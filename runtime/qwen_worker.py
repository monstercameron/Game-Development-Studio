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
from pathlib import Path

import uvicorn
from engine_identity import identity


def load_engine(directory):
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


class GuardedApp:
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
                return await self.reply(send, 405, {"error": "Use GET."})
            try:
                return await self.reply(send, 200, identity(self.token, header, "images"))
            except PermissionError:
                return await self.reply(send, 403, {"error": "Forbidden."})
            except LookupError:
                return await self.reply(send, 404, {"error": "Recovery identity is unavailable."})
        if path in ("/api/forge/stop", "/api/forge/resume"):
            header = (
                dict(scope.get("headers", []))
                .get(b"x-forge-engine-token", b"")
                .decode("utf-8", "replace")
            )
            if method != "POST" or not hmac.compare_digest(header, self.token):
                return await self.reply(send, 403, {"error": "Forbidden."})
            with self.gate:
                if path.endswith("/resume"):
                    if self.stop_timer:
                        self.stop_timer.cancel()
                        self.stop_timer = None
                    self.stopping = False
                    result = (200, {"resumed": True})
                else:
                    try:
                        pending = any(
                            job.get("status") not in ("completed", "failed")
                            for job in list(self.engine.jobs.values())
                        )
                        busy = self.submissions > 0 or self.engine.lock.locked() or pending
                    except Exception:
                        busy = True
                    if busy:
                        result = (409, {"error": "Image worker has active or queued work."})
                    else:
                        self.stopping = True
                        if not self.stop_timer:
                            self.stop_timer = threading.Timer(1, self.terminate_if_stopping)
                            self.stop_timer.daemon = True
                            self.stop_timer.start()
                        result = (200, {"stopping": True})
            return await self.reply(send, *result)
        is_submission = method == "POST" and path == "/api/generate"
        if is_submission:
            with self.gate:
                rejected = self.stopping
                if not rejected:
                    self.submissions += 1
            if rejected:
                return await self.reply(
                    send, 503, {"error": "Image worker is stopping; retry in Forge."}
                )
        try:
            return await self.engine.app(scope, receive, send)
        finally:
            if is_submission:
                with self.gate:
                    self.submissions -= 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--engine-dir", default=os.getcwd())
    args = parser.parse_args()
    engine = load_engine(args.engine_dir)
    uvicorn.run(
        GuardedApp(engine, os.environ.get("FORGE_IMAGE_CONTROL_TOKEN", "")),
        host="127.0.0.1",
        port=args.port,
        access_log=False,
    )
