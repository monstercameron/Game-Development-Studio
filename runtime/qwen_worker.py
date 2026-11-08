"""Run the existing Qwen app with a guarded, Forge-only shutdown handshake.

The original application and model files remain in their existing directory.
The guard stops new submissions before Forge stops an idle owned process.
"""

import argparse
import hmac
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

import uvicorn
from app_log import flush, get_logger, install_excepthook
from engine_identity import identity

log = get_logger("image")


def load_engine(directory):
    """Imports the Qwen app's app.py from directory and returns the module.

    Raises RuntimeError when the module lacks the app, jobs or lock interfaces that the
    guard relies on. The module is registered in sys.modules under its spec name before it
    executes, so code inside the engine can look it up by name.
    """
    source = Path(directory) / "app.py"
    spec = importlib.util.spec_from_file_location("forge_qwen_engine", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, "app") or not hasattr(module, "jobs") or not hasattr(module, "lock"):
        raise RuntimeError(
            "The Qwen application does not expose the required guarded-worker interfaces."
        )
    return module


def log_upstream_submission(status, started_at):
    """Logs how the image studio answered one submission, with its duration and no content."""
    duration_ms = round((time.perf_counter() - started_at) * 1000)
    if status is None:
        log.warn(
            "image.upstream.request.failed",
            {"route": "/api/generate", "reason": "no_response", "durationMs": duration_ms},
        )
    elif status >= 400:
        log.warn(
            "image.upstream.request.failed",
            {"route": "/api/generate", "status": status, "durationMs": duration_ms},
        )
    else:
        log.info(
            "image.upstream.request.completed",
            {"route": "/api/generate", "status": status, "durationMs": duration_ms},
        )


class GuardedApp:
    """ASGI wrapper that adds the Forge stop/resume handshake in front of the Qwen app.

    A stop is accepted only while no submission, lock or unfinished job is active. Once
    accepted, new submissions get 503 and the process exits one second later unless a
    resume arrives first. The gate lock serializes the flag and submission counter.
    """

    def __init__(self, engine, token):
        if not token:
            raise RuntimeError("Forge image worker control token is required.")
        self.engine = engine
        self.token = token
        self.gate = threading.Lock()
        self.stopping = False
        self.submissions = 0
        self.stop_timer = None

    def terminate_if_stopping(self):
        with self.gate:
            if self.stopping:
                log.info("image.process.stopped", {"reason": "stop_requested"})
                # os._exit skips atexit, so buffered log records are written first.
                flush()
                os._exit(0)

    async def reply(self, send, status, body):
        payload = json.dumps(body).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.engine.app(scope, receive, send)
        path, method = scope.get("path", ""), scope.get("method", "")
        if path == "/api/forge/identity":
            header = (
                dict(scope.get("headers", []))
                .get(b"x-forge-engine-token", b"")
                .decode("utf-8", "replace")
            )
            if method != "GET":
                log.warn(
                    "image.request.rejected",
                    {"route": "/api/forge/identity", "reason": "method_not_allowed"},
                )
                return await self.reply(send, 405, {"error": "Use GET."})
            try:
                return await self.reply(send, 200, identity(self.token, header, "images"))
            except PermissionError as error:
                log.warn(
                    "image.request.rejected",
                    {
                        "route": "/api/forge/identity",
                        "reason": "forbidden",
                        "errorClass": type(error).__name__,
                    },
                )
                return await self.reply(send, 403, {"error": "Forbidden."})
            except LookupError as error:
                log.warn(
                    "image.request.rejected",
                    {
                        "route": "/api/forge/identity",
                        "reason": "identity_unavailable",
                        "errorClass": type(error).__name__,
                    },
                )
                return await self.reply(send, 404, {"error": "Recovery identity is unavailable."})
        if path in ("/api/forge/stop", "/api/forge/resume"):
            header = (
                dict(scope.get("headers", []))
                .get(b"x-forge-engine-token", b"")
                .decode("utf-8", "replace")
            )
            if method != "POST" or not hmac.compare_digest(header, self.token):
                log.warn(
                    "image.request.rejected",
                    {"route": "/api/forge/:action", "reason": "forbidden"},
                )
                return await self.reply(send, 403, {"error": "Forbidden."})
            with self.gate:
                if path.endswith("/resume"):
                    if self.stop_timer:
                        self.stop_timer.cancel()
                        self.stop_timer = None
                    self.stopping = False
                    log.info("image.resume.requested", {"route": "/api/forge/resume"})
                    result = (200, {"resumed": True})
                else:
                    try:
                        pending = any(
                            job.get("status") not in ("completed", "failed")
                            for job in list(self.engine.jobs.values())
                        )
                        busy = self.submissions > 0 or self.engine.lock.locked() or pending
                    except Exception as error:
                        # Unknown state is treated as busy so a stop never interrupts work.
                        log.warn(
                            "image.stop.check.failed",
                            {"reason": "assume_busy", "errorClass": type(error).__name__},
                        )
                        busy = True
                    if busy:
                        log.warn(
                            "image.request.rejected",
                            {"route": "/api/forge/stop", "reason": "active_work"},
                        )
                        result = (409, {"error": "Image worker has active or queued work."})
                    else:
                        self.stopping = True
                        log.info("image.stop.requested", {"route": "/api/forge/stop"})
                        if not self.stop_timer:
                            self.stop_timer = threading.Timer(1, self.terminate_if_stopping)
                            self.stop_timer.daemon = True
                            self.stop_timer.start()
                        result = (200, {"stopping": True})
            return await self.reply(send, *result)
        is_submission = method == "POST" and path == "/api/generate"
        upstream_status = None
        upstream_send = send
        if is_submission:
            with self.gate:
                rejected = self.stopping
                if not rejected:
                    self.submissions += 1
            if rejected:
                log.warn(
                    "image.request.rejected",
                    {"route": "/api/generate", "reason": "stopping"},
                )
                return await self.reply(
                    send, 503, {"error": "Image worker is stopping; retry in Forge."}
                )

            async def upstream_send(message):
                # Records only the HTTP status code; the response body is never logged.
                nonlocal upstream_status
                if message["type"] == "http.response.start":
                    upstream_status = message["status"]
                await send(message)

        upstream_started_at = time.perf_counter()
        try:
            return await self.engine.app(scope, receive, upstream_send)
        finally:
            if is_submission:
                with self.gate:
                    self.submissions -= 1
                log_upstream_submission(upstream_status, upstream_started_at)


if __name__ == "__main__":
    install_excepthook("image")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--engine-dir", default=os.getcwd())
    args = parser.parse_args()
    engine = load_engine(args.engine_dir)
    log.info("image.process.started", {"port": args.port, "pid": os.getpid()})
    uvicorn.run(
        GuardedApp(engine, os.environ.get("FORGE_IMAGE_CONTROL_TOKEN", "")),
        host="127.0.0.1",
        port=args.port,
        access_log=False,
    )
    log.info("image.process.stopped", {"reason": "server_exited"})
