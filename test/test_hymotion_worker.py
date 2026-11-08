"""Exercise the isolated HY-Motion worker over loopback with a fake model."""

import json
import os
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import hymotion_worker as worker


def http(base, path, *, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = Request(
        base + path, data=data, headers={"Content-Type": "application/json", **(headers or {})}
    )
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, response.read()
    except HTTPError as error:
        with error:
            return error.code, error.read()


def wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("Timed out waiting for motion worker.")


class MotionWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        worker.OUTPUTS = Path(cls.temp.name) / "outputs"
        worker.OUTPUTS.mkdir()
        worker.TOKEN = "test-motion-token"
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(128)
        cls.base = f"http://127.0.0.1:{sock.getsockname()[1]}"
        cls.server = uvicorn.Server(uvicorn.Config(worker.app, log_level="error", access_log=False))
        cls.thread = threading.Thread(
            target=cls.server.run, kwargs={"sockets": [sock]}, daemon=True
        )
        cls.thread.start()
        wait_for(lambda: cls.server.started)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=5)
        cls.temp.cleanup()

    def setUp(self):
        with worker.lock:
            worker.model = None
            worker.state.update(phase="idle", error=None, closing=False)
            worker.jobs.clear()

    def test_memory_recheck_prevents_encoder_loading(self):
        encoder = Mock()
        fake = types.SimpleNamespace(
            load_motion_core=Mock(return_value=object()), load_motion_text_encoder=encoder
        )
        # The default host-memory policy only enforces a 2 GiB floor, so the 9 GiB text-encoder
        # budget is checked in full only in strict mode.
        with (
            patch.dict(os.environ, {"FORGE_HOST_MEMORY_POLICY": "strict"}),
            patch.dict(sys.modules, {"hymotion_backend": fake}),
            patch.object(worker, "files_ready", return_value=True),
            patch.object(worker, "require_memory"),
            patch.object(worker, "free_host_memory", return_value=8 * 1024**3),
        ):
            self.assertEqual(http(self.base, "/api/model/load", body={})[0], 202)

            def failed():
                value = json.loads(http(self.base, "/api/status")[1])
                return value if value["phase"] == "error" else None

            status = wait_for(failed)
            self.assertIn("free system memory", status["error"])
            self.assertFalse(status["loaded"])
            encoder.assert_not_called()

    def test_load_generate_and_guard_active_work(self):
        entered, release = threading.Event(), threading.Event()

        def fake_generate(model, prompt, **kwargs):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("Test timed out.")
            self.assertEqual(prompt, "walk")
            self.assertEqual(kwargs["steps"], 8)
            return "HIERARCHY\nMOTION\nFrames: 1\n"

        fake = types.SimpleNamespace(
            load_motion_core=lambda *_: object(),
            load_motion_text_encoder=lambda model, *_: model,
            generate_motion=fake_generate,
        )
        with (
            patch.dict(sys.modules, {"hymotion_backend": fake}),
            patch.object(worker, "files_ready", return_value=True),
            patch.object(worker, "require_memory"),
            patch.object(worker, "free_host_memory", return_value=16 * 1024**3),
        ):
            self.assertEqual(http(self.base, "/api/model/load", body={})[0], 202)
            wait_for(lambda: json.loads(http(self.base, "/api/status")[1])["loaded"])
            request = {"prompt": "walk", "duration": 1.5, "seed": 123, "steps": 8, "guidance": 5.0}
            status, body = http(self.base, "/api/generate", body=request)
            self.assertEqual(status, 202)
            job_id = json.loads(body)["id"]
            # Stop must be token-gated and must not interrupt a job that is still running.
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(http(self.base, "/api/generate", body=request)[0], 409)
                self.assertEqual(
                    http(
                        self.base,
                        "/api/forge/stop",
                        body={},
                        headers={"X-Forge-Engine-Token": worker.TOKEN},
                    )[0],
                    409,
                )
                self.assertEqual(http(self.base, "/api/forge/stop", body={})[0], 403)
            finally:
                release.set()

            def complete():
                value = json.loads(http(self.base, "/api/jobs/" + job_id)[1])
                return value if value["status"] == "completed" else None

            wait_for(complete)
            status, data = http(self.base, "/api/jobs/" + job_id + "/motion")
            self.assertEqual(status, 200)
            self.assertEqual(data.splitlines()[0], b"HIERARCHY")
            # Zero steps is an invalid request and is refused with 422 instead of being queued.
            self.assertEqual(http(self.base, "/api/generate", body={**request, "steps": 0})[0], 422)
            # Resume cancels the pending exit timer, so finish_stop must never run.
            with patch.object(worker, "finish_stop") as finish_stop:
                headers = {"X-Forge-Engine-Token": worker.TOKEN}
                self.assertEqual(
                    http(self.base, "/api/forge/stop", body={}, headers=headers)[0], 200
                )
                self.assertEqual(http(self.base, "/api/generate", body=request)[0], 409)
                self.assertEqual(
                    http(self.base, "/api/forge/resume", body={}, headers=headers)[0], 200
                )
                finish_stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
