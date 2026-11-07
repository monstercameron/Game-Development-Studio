"""Lifecycle guard tests; run with a Python environment containing FastAPI."""

import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
spec = importlib.util.spec_from_file_location(
    "mammoth_guard", Path(__file__).resolve().parents[1] / "runtime" / "mammoth_worker.py"
)
guard_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard_module)


async def request(app, path, method="GET", token="secret"):
    messages = []
    done = False

    async def receive():
        nonlocal done
        if not done:
            done = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await asyncio.Event().wait()

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": [(b"x-forge-engine-token", token.encode())],
        "server": ("127.0.0.1", 1),
        "client": ("127.0.0.1", 2),
        "root_path": "",
    }
    await app(scope, receive, send)
    return next(
        message["status"] for message in messages if message["type"] == "http.response.start"
    )


class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.started = threading.Event()
        self.finish = threading.Event()
        self.loaded = threading.Event()
        self.load_finish = threading.Event()
        self.engine = types.SimpleNamespace(app=self.app, engine=None, status={"state": "waiting"})
        self.engine.download_status = lambda: {"complete": True}

        def load_model():
            self.loaded.set()
            self.load_finish.wait(5)
            self.engine.engine = object()

        self.engine.load_model = load_model

        @self.app.post("/v1/systemone")
        def decide():
            self.started.set()
            self.finish.wait(5)
            return {"ok": True}

        @self.app.post("/api/load")
        def load():
            raise AssertionError("Public load must be blocked")

        self.exited = False

        def exit_worker():
            self.exited = True

        self.guard = guard_module.GuardedMammoth(
            self.engine, "secret", exit_worker, preflight=lambda: None
        )

    async def asyncTearDown(self):
        self.finish.set()
        self.load_finish.set()
        if self.guard.stop_handle:
            self.guard.stop_handle.cancel()
        if self.guard.tasks:
            await asyncio.gather(*self.guard.tasks)

    async def test_load_is_authenticated_and_blocks_stop_until_finished(self):
        self.assertEqual(await request(self.guard, "/api/load", "POST"), 403)
        self.assertEqual(await request(self.guard, "/api/forge/load", "POST", "wrong"), 403)
        self.assertEqual(await request(self.guard, "/api/forge/load", "POST"), 202)
        self.assertTrue(await asyncio.to_thread(self.loaded.wait, 2))
        self.assertEqual(await request(self.guard, "/api/forge/stop", "POST"), 409)
        self.load_finish.set()
        await asyncio.gather(*self.guard.tasks)
        self.assertEqual(await request(self.guard, "/api/forge/stop", "POST"), 200)
        self.assertEqual(await request(self.guard, "/v1/systemone", "POST"), 503)
        self.assertEqual(await request(self.guard, "/api/forge/resume", "POST"), 200)
        await asyncio.sleep(1.1)
        self.assertFalse(self.exited)

    async def test_recovery_identity_is_private(self):
        with patch.dict(os.environ, {"FORGE_ENGINE_INSTANCE_NONCE": "a" * 64}):
            self.assertEqual(await request(self.guard, "/api/forge/identity", token="wrong"), 403)
            self.assertEqual(await request(self.guard, "/api/forge/identity"), 200)
        with patch.dict(os.environ, {"FORGE_ENGINE_INSTANCE_NONCE": "invalid"}):
            self.assertEqual(await request(self.guard, "/api/forge/identity"), 404)

    async def test_active_and_cancelled_decisions_block_stop(self):
        pending = asyncio.create_task(request(self.guard, "/v1/systemone", "POST"))
        self.assertTrue(await asyncio.to_thread(self.started.wait, 2))
        self.assertEqual(await request(self.guard, "/api/forge/stop", "POST"), 409)
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        self.assertEqual(await request(self.guard, "/api/forge/stop", "POST"), 409)
        self.finish.set()
        for _ in range(100):
            if self.guard.threads == 0:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(self.guard.threads, 0)
        self.assertEqual(await request(self.guard, "/api/forge/stop", "POST"), 200)

    async def test_failed_cuda_preflight_never_calls_model_loader(self):
        def reject_cuda():
            raise RuntimeError("CUDA unavailable")

        self.guard.preflight = reject_cuda
        self.assertEqual(await request(self.guard, "/api/forge/load", "POST"), 202)
        await asyncio.gather(*self.guard.tasks)
        self.assertFalse(self.loaded.is_set())
        self.assertEqual(self.engine.status["state"], "error")
        self.assertTrue(self.guard.load_finished)


@unittest.skipUnless(
    os.environ.get("FORGE_MAMMOTH_SMOKE_PYTHON") and os.environ.get("FORGE_MAMMOTH_SMOKE_DIR"),
    "No local Mammoth smoke-test paths supplied",
)
class RealAppSmokeTest(unittest.TestCase):
    def test_starts_unloaded_and_stops_without_touching_standalone(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        env = {**os.environ, "FORGE_ENGINE_CONTROL_TOKEN": "isolated-smoke-token"}
        cmd = [
            env["FORGE_MAMMOTH_SMOKE_PYTHON"],
            "-u",
            str(Path(__file__).resolve().parents[1] / "runtime" / "mammoth_worker.py"),
            "--port",
            str(port),
            "--engine-dir",
            env["FORGE_MAMMOTH_SMOKE_DIR"],
        ]
        process = subprocess.Popen(
            cmd,
            env=env,
            cwd=env["FORGE_MAMMOTH_SMOKE_DIR"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(100):
                if process.poll() is not None:
                    self.fail("Worker exited: " + process.stderr.read().decode(errors="replace"))
                try:
                    with urllib.request.urlopen(base + "/health", timeout=0.5) as response:
                        health = json.load(response)
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(0.1)
            else:
                self.fail("Worker did not start")
            self.assertFalse(health["model_ready"])
            headers = {"X-Forge-Engine-Token": "isolated-smoke-token"}
            with urllib.request.urlopen(
                urllib.request.Request(base + "/api/forge/status", headers=headers), timeout=2
            ) as response:
                state = json.load(response)
            self.assertEqual(state["engine"], "forge-mammoth-v1")
            self.assertFalse(state["loading"])
            with self.assertRaises(urllib.error.HTTPError) as failure:
                urllib.request.urlopen(
                    urllib.request.Request(base + "/api/load", data=b"", method="POST"), timeout=2
                )
            self.assertEqual(failure.exception.code, 403)
            with urllib.request.urlopen(
                urllib.request.Request(
                    base + "/api/forge/stop", headers=headers, data=b"", method="POST"
                ),
                timeout=2,
            ) as response:
                self.assertTrue(json.load(response)["stopping"])
            self.assertEqual(process.wait(timeout=8), 0)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=8)
            process.stderr.close()


if __name__ == "__main__":
    unittest.main()
