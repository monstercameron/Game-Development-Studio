"""Exercise the experimental SAM worker over loopback with a fake detector."""

import base64
import io
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import uvicorn
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import sam31_worker as worker


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
    raise AssertionError("Timed out waiting for SAM worker.")


def wait_for_completed(base, job_id):
    def finished():
        value = json.loads(http(base, "/api/jobs/" + job_id)[1])
        return value if value.get("status") == "completed" else None

    return wait_for(finished)


class Sam31WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        worker.MODEL = Path(cls.temp.name) / "mock.pt"
        worker.MODEL.write_bytes(b"mock")
        worker.OUTPUTS = Path(cls.temp.name) / "outputs"
        worker.OUTPUTS.mkdir()
        worker.TOKEN = "test-control-token"
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

    def test_worker_checks_memory_before_importing_or_loading_model(self):
        with (
            patch.object(worker, "free_host_memory", return_value=1024**3),
            patch.object(worker, "load_detector") as loader,
        ):
            self.assertEqual(http(self.base, "/api/model/load", body={})[0], 202)

            def failed_load():
                value = json.loads(http(self.base, "/api/status")[1])
                return value if value["phase"] == "error" else None

            status = wait_for(failed_load)
            self.assertIn("free system memory", status["error"])
            self.assertFalse(status["loaded"])
            loader.assert_not_called()

    def test_status_lists_the_match_selection_feature(self):
        status = json.loads(http(self.base, "/api/status")[1])
        self.assertIn(worker.MATCH_SELECTION_FEATURE, status["features"])

    def test_match_selection_fields_are_validated_before_any_work_starts(self):
        stream = io.BytesIO()
        Image.new("RGB", (2, 2)).save(stream, format="PNG")
        image = "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()
        base = {"image": image, "prompt": "tree"}
        with (
            patch.object(worker, "require_memory"),
            patch.object(worker, "load_detector", return_value=object()),
            patch.object(worker, "run_segmentation") as segment,
        ):
            http(self.base, "/api/model/load", body={})
            wait_for(lambda: json.loads(http(self.base, "/api/status")[1])["loaded"])
            for extra in [
                {"select": "some"},
                {"select": "top"},
                {"select": "top", "max_instances": 0},
                {"select": "top", "max_instances": 51},
                {"select": "top", "max_instances": "2"},
                {"select": "best", "max_instances": 2},
                {"output": "sticker"},
            ]:
                with self.subTest(extra=extra):
                    self.assertEqual(
                        http(self.base, "/api/generate", body={**base, **extra})[0], 422
                    )
            segment.assert_not_called()
            self.assertEqual(json.loads(http(self.base, "/api/status")[1])["phase"], "ready")

    def test_match_selection_and_output_reach_the_segmentation_call(self):
        stream = io.BytesIO()
        Image.new("RGB", (2, 2)).save(stream, format="PNG")
        image = "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()
        received = []

        def fake_segment(_model, _picture, request):
            received.append((request.output, request.select, request.max_instances))
            return Image.new("RGBA", (2, 2)), {"instances": 3, "used": 2, "matches": []}

        with (
            patch.object(worker, "require_memory"),
            patch.object(worker, "load_detector", return_value=object()),
            patch.object(worker, "run_segmentation", side_effect=fake_segment),
        ):
            http(self.base, "/api/model/load", body={})
            wait_for(lambda: json.loads(http(self.base, "/api/status")[1])["loaded"])
            for extra, expected in [
                ({}, ("transparent", "all", None)),
                (
                    {"output": "outline", "select": "top", "max_instances": 2},
                    ("outline", "top", 2),
                ),
                ({"output": "cropped", "select": "largest"}, ("cropped", "largest", None)),
            ]:
                with self.subTest(extra=extra):
                    status, result = http(
                        self.base, "/api/generate", body={"image": image, "prompt": "tree", **extra}
                    )
                    self.assertEqual(status, 202)
                    job = wait_for_completed(self.base, json.loads(result)["id"])
                    self.assertEqual(job["metadata"]["used"], 2)
                    wait_for(
                        lambda: json.loads(http(self.base, "/api/status")[1])["phase"] == "ready"
                    )
                    self.assertEqual(received[-1], expected)

    def test_load_segment_and_guard_active_work(self):
        entered, release = threading.Event(), threading.Event()

        def fake_segment(_model, image, request):
            entered.set()
            if not release.wait(8):
                raise RuntimeError("Test timed out.")
            self.assertEqual(image.size, (2, 2))
            self.assertEqual(request.prompt, "tree")
            return Image.new("RGBA", (2, 2), (20, 40, 60, 128)), {
                "instances": 1,
                "selectedPixels": 4,
            }

        with (
            patch.object(worker, "require_memory"),
            patch.object(worker, "load_detector", return_value=object()),
            patch.object(worker, "run_segmentation", side_effect=fake_segment),
        ):
            status, _ = http(self.base, "/api/model/load", body={})
            self.assertEqual(status, 202)
            wait_for(lambda: json.loads(http(self.base, "/api/status")[1])["loaded"])
            self.assertEqual(http(self.base, "/api/forge/stop", body={})[0], 403)
            invalid = {"image": "data:image/png;base64,bad!", "prompt": "tree"}
            self.assertEqual(http(self.base, "/api/generate", body=invalid)[0], 400)
            self.assertEqual(json.loads(http(self.base, "/api/status")[1])["phase"], "ready")
            stream = io.BytesIO()
            Image.new("RGB", (2, 2)).save(stream, format="PNG")
            request = {
                "image": "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode(),
                "prompt": "tree",
                "output": "transparent",
                "confidence": 0.5,
            }
            status, result = http(self.base, "/api/generate", body=request)
            self.assertEqual(status, 202)
            job_id = json.loads(result)["id"]
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
            finally:
                release.set()

            job = wait_for_completed(self.base, job_id)
            self.assertEqual(job["metadata"]["selectedPixels"], 4)
            status, data = http(self.base, "/api/jobs/" + job_id + "/image")
            self.assertEqual(status, 200)
            with Image.open(io.BytesIO(data)) as result_image:
                self.assertEqual(result_image.getpixel((0, 0)), (20, 40, 60, 128))
            self.assertEqual(http(self.base, "/api/jobs/" + ("0" * 32) + "/image")[0], 404)
            with patch.object(worker, "finish_stop") as finish_stop:
                headers = {"X-Forge-Engine-Token": worker.TOKEN}
                self.assertEqual(
                    http(self.base, "/api/forge/stop", body={}, headers=headers)[0], 200
                )
                self.assertEqual(http(self.base, "/api/generate", body=request)[0], 409)
                self.assertEqual(
                    http(self.base, "/api/forge/resume", body={}, headers=headers)[0], 200
                )
                self.assertFalse(worker.state["closing"])
                finish_stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
