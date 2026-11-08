"""Run Mammoth Studio behind Forge's lifecycle guard, without autoloading.

This wrapper leaves the standalone application untouched. Forge must perform
memory admission before calling the authenticated load endpoint.
"""

import argparse
import asyncio
import ctypes
import functools
import hmac
import importlib.util
import os
import sys
import threading
from pathlib import Path

# Embedded Python can omit the script directory from sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app_log import get_logger, install_excepthook  # noqa: E402
from engine_identity import identity

log = get_logger("chat")


def load_mammoth(directory):
    """Import the upstream Mammoth server with its startup hook removed.

    Raises RuntimeError when server.py cannot be imported or its startup hooks
    are not exactly the expected single hook, so the process never autoloads.
    """
    source = Path(directory).resolve() / "server.py"
    spec = importlib.util.spec_from_file_location("forge_mammoth_engine", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("Mammoth Studio server could not be imported.")
    engine = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(engine)
    # Refuse to start if the upstream startup hook changes: accidentally running
    # it would start an unchecked model load or a download.
    hooks = engine.app.router.on_startup
    if hooks.count(engine.startup) != 1:
        raise RuntimeError("Unrecognized Mammoth startup hooks; refusing autoload.")
    hooks.remove(engine.startup)
    if hooks:
        raise RuntimeError("Unexpected Mammoth startup hooks; refusing autoload.")
    return engine


def check_cuda_backend():
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; Mammoth will not fall back to CPU inference.")
    import native_engine

    backend = native_engine.library()
    backend.llama_supports_gpu_offload.restype = ctypes.c_bool
    if not backend.llama_supports_gpu_offload():
        raise RuntimeError("The Mammoth llama.cpp backend cannot offload to the GPU.")


class GuardedMammoth:
    """ASGI wrapper that routes Forge control calls and tracks inference work.

    Loads only start through /api/forge/load, after Forge's memory admission.
    The standalone /api/load endpoint is refused for that reason.
    """

    def __init__(self, engine, token, request_exit, preflight=check_cuda_backend):
        if not token:
            raise RuntimeError("A Forge control token is required.")
        self.engine = engine
        self.token = token
        self.request_exit = request_exit
        self.preflight = preflight
        self.lock = threading.RLock()
        self.active = 0
        self.threads = 0
        self.loading = False
        self.load_finished = False
        self.closing = False
        self.stop_handle = None
        self.tasks = set()
        # Track actual synchronous inference even if its HTTP task is cancelled.
        routes = [
            r
            for r in engine.app.routes
            if getattr(r, "path", None) == "/v1/systemone" and "POST" in getattr(r, "methods", ())
        ]
        if len(routes) != 1 or not hasattr(routes[0], "dependant"):
            raise RuntimeError("Unrecognized Mammoth decision endpoint.")
        original = routes[0].dependant.call

        @functools.wraps(original)
        def tracked(*args, **kwargs):
            from fastapi import HTTPException

            with self.lock:
                if self.closing:
                    raise HTTPException(503, "Mammoth service is stopping.")
                self.threads += 1
            try:
                return original(*args, **kwargs)
            finally:
                with self.lock:
                    self.threads -= 1

        routes[0].dependant.call = tracked

    async def respond(self, scope, receive, send, status, body):
        from starlette.responses import JSONResponse

        await JSONResponse(body, status_code=status)(scope, receive, send)

    async def load(self):
        try:

            def load_checked():
                self.preflight()
                self.engine.load_model()

            stop = log.time("chat.model.load.completed")
            await asyncio.to_thread(load_checked)
            stop()
        except Exception as error:
            log.error("chat.model.load.failed", {"errorClass": type(error).__name__})
            self.engine.status.update(state="error", message=f"{type(error).__name__}: {error}")
        finally:
            with self.lock:
                self.loading = False
                self.load_finished = True

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.engine.app(scope, receive, send)
        path, method = scope.get("path", ""), scope.get("method", "")
        if path.startswith("/api/forge/"):
            headers = dict(scope.get("headers", []))
            supplied = headers.get(b"x-forge-engine-token", b"").decode("ascii", "ignore")
            if not hmac.compare_digest(self.token, supplied):
                log.warn(
                    "chat.request.rejected",
                    {"route": "/api/forge/:action", "reason": "forbidden"},
                )
                return await self.respond(scope, receive, send, 403, {"error": "Forbidden."})
            with self.lock:
                if method == "GET" and path == "/api/forge/identity":
                    try:
                        response = (200, identity(self.token, supplied, "game"))
                    except LookupError as error:
                        log.warn(
                            "chat.request.rejected",
                            {
                                "route": "/api/forge/identity",
                                "reason": "identity_unavailable",
                                "errorClass": type(error).__name__,
                            },
                        )
                        response = (404, {"error": "Recovery identity is unavailable."})
                elif method == "GET" and path == "/api/forge/status":
                    response = (
                        200,
                        {
                            "engine": "forge-mammoth-v1",
                            "active": self.active,
                            "threads": self.threads,
                            "loading": self.loading,
                            "closing": self.closing,
                            "loaded": self.engine.engine is not None,
                            "load_finished": self.load_finished,
                            "model_downloaded": self.engine.download_status().get("complete")
                            is True,
                            "state": self.engine.status.get("state"),
                        },
                    )
                elif method == "POST" and path == "/api/forge/resume":
                    if self.stop_handle:
                        self.stop_handle.cancel()
                        self.stop_handle = None
                    self.closing = False
                    response = (200, {"resumed": True})
                elif method == "POST" and path == "/api/forge/stop":
                    if self.active or self.threads or self.loading:
                        log.warn(
                            "chat.request.rejected",
                            {"route": "/api/forge/stop", "reason": "busy"},
                        )
                        response = (409, {"error": "Mammoth has active or queued work."})
                    else:
                        self.closing = True
                        log.info("chat.process.stop.requested")
                        if self.stop_handle is None:
                            self.stop_handle = asyncio.get_running_loop().call_later(
                                1, self.request_exit
                            )
                        response = (200, {"stopping": True})
                elif method == "POST" and path == "/api/forge/load":
                    if self.closing:
                        log.warn(
                            "chat.request.rejected",
                            {"route": "/api/forge/load", "reason": "closing"},
                        )
                        response = (409, {"error": "Mammoth service is stopping."})
                    elif self.loading or self.engine.engine is not None:
                        response = (
                            200,
                            {
                                "accepted": False,
                                "loading": self.loading,
                                "loaded": self.engine.engine is not None,
                            },
                        )
                    elif not self.engine.download_status().get("complete"):
                        log.warn(
                            "chat.request.rejected",
                            {"route": "/api/forge/load", "reason": "model_files_missing"},
                        )
                        response = (409, {"error": "Verified Mammoth model files are missing."})
                    else:
                        self.loading = True
                        self.load_finished = False
                        task = asyncio.create_task(self.load())
                        self.tasks.add(task)
                        task.add_done_callback(self.tasks.discard)
                        response = (202, {"accepted": True})
                else:
                    response = (404, {"error": "Not found."})
            return await self.respond(scope, receive, send, *response)
        # The standalone load endpoint bypasses Forge's admission control.
        if path == "/api/load":
            log.warn(
                "chat.request.rejected",
                {"route": "/api/load", "reason": "standalone_endpoint"},
            )
            return await self.respond(
                scope, receive, send, 403, {"error": "Use the Forge model load endpoint."}
            )
        tracked = method == "POST" and path == "/v1/systemone"
        with self.lock:
            if self.closing and tracked:
                rejected = True
            else:
                rejected = False
                if tracked:
                    self.active += 1
        if rejected:
            log.warn(
                "chat.request.rejected",
                {"route": "/v1/systemone", "reason": "closing"},
            )
            return await self.respond(
                scope, receive, send, 503, {"error": "Mammoth service is stopping."}
            )
        try:
            return await self.engine.app(scope, receive, send)
        finally:
            if tracked:
                with self.lock:
                    self.active -= 1


def main():
    install_excepthook("chat")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--engine-dir", required=True)
    args = parser.parse_args()
    log.info("chat.process.started", {"port": args.port})
    engine = load_mammoth(args.engine_dir)
    import uvicorn

    config = uvicorn.Config(None, host="127.0.0.1", port=args.port, access_log=False)
    server = uvicorn.Server(config)
    config.app = GuardedMammoth(
        engine,
        os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", ""),
        lambda: setattr(server, "should_exit", True),
    )
    server.run()
    log.info("chat.process.stopped", {"reason": "server_exited"})


if __name__ == "__main__":
    main()
