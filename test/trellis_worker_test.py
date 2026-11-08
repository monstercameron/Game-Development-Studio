"""Exercise worker isolation, admission, validation, and output recovery."""

import base64
import io
import os
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "runtime"))
temporary = tempfile.TemporaryDirectory()
os.environ["FORGE_RUNTIME_DIR"] = temporary.name
os.environ["FORGE_ENGINE_CONTROL_TOKEN"] = "test-control-token"
import trellis_worker as worker  # noqa: E402 - set runtime paths and tokens before import.
from fastapi.testclient import TestClient  # noqa: E402 - configure the worker before import.


def image_data(opaque=False):
    image = Image.new("RGBA", (8, 8), (0, 0, 0, 255 if opaque else 0))
    for y in range(2, 6):
        for x in range(2, 6):
            image.putpixel((x, y), (200, 50, 20, 255))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def wait_for(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Worker operation timed out.")


class WorkerTest(unittest.TestCase):
    def setUp(self):
        worker.model = None
        worker.jobs.clear()
        worker.state.update(phase="idle", error=None, closing=False)
        self.client = TestClient(worker.app)

    def test_lifecycle_and_committed_output_recovery(self):
        started = threading.Event()
        finish = threading.Event()

        def generate(model, image, destination, **kwargs):
            report = kwargs.pop("report")
            self.assertTrue(callable(report))
            self.assertEqual(
                kwargs,
                {
                    "seed": 42,
                    "steps": 3,
                    "texture_size": 512,
                    "target_faces": 100000,
                    "pipeline_type": "512",
                },
            )
            started.set()
            if not finish.wait(5):
                raise RuntimeError("Test timed out.")
            Path(destination).write_bytes(b"glTF-test")

        fake = types.SimpleNamespace(load_trellis=lambda: object(), generate_glb=generate)
        with (
            patch.dict(
                sys.modules,
                {
                    "trellis_backend": fake,
                    "trellis_toolchain": types.SimpleNamespace(configure_toolchain=lambda: None),
                },
            ),
            patch.object(worker, "missing_files", return_value=[]),
            patch.object(worker, "check_memory") as memory,
        ):
            self.assertEqual(self.client.get("/api/status").json()["phase"], "idle")
            self.assertEqual(self.client.post("/api/model/load").status_code, 202)
            wait_for(lambda: worker.state["phase"] == "ready")
            self.assertEqual(
                self.client.post("/api/generate", json={"image": image_data(True)}).status_code, 400
            )
            self.assertEqual(
                self.client.post(
                    "/api/generate", json={"image": image_data(), "texture_size": 17}
                ).status_code,
                400,
            )
            response = self.client.post(
                "/api/generate", json={"image": image_data(), "steps": 3, "texture_size": 512}
            )
            self.assertEqual(response.status_code, 202)
            job_id = response.json()["id"]
            self.assertTrue(started.wait(3))
            self.assertEqual(
                self.client.post("/api/generate", json={"image": image_data()}).status_code, 409
            )
            self.assertEqual(
                self.client.post(
                    "/api/forge/stop", headers={"X-Forge-Engine-Token": "wrong"}
                ).status_code,
                403,
            )
            self.assertEqual(
                self.client.post(
                    "/api/forge/stop", headers={"X-Forge-Engine-Token": "test-control-token"}
                ).status_code,
                409,
            )
            finish.set()
            wait_for(lambda: worker.jobs[job_id]["status"] == "completed")
            self.assertEqual(memory.call_count, 2)
            worker.jobs.clear()
            recovered = self.client.get(f"/api/jobs/{job_id}").json()
            self.assertTrue(recovered["recovered"])
            self.assertEqual(self.client.get(f"/api/jobs/{job_id}/mesh").content, b"glTF-test")

    def test_pipeline_selection_is_validated_budgeted_and_forwarded(self):
        seen = {}

        def generate(model, image, destination, **kwargs):
            seen.update(kwargs)
            kwargs["report"]("Loading the 1024 checkpoints (first use of this pipeline).")
            Path(destination).write_bytes(b"glTF-test")

        fake = types.SimpleNamespace(load_trellis=lambda: object(), generate_glb=generate)
        with (
            patch.dict(
                sys.modules,
                {
                    "trellis_backend": fake,
                    "trellis_toolchain": types.SimpleNamespace(configure_toolchain=lambda: None),
                },
            ),
            patch.object(worker, "missing_files", return_value=[]),
            patch.object(worker, "pipelines_available", return_value=["512", "1024"]),
            patch.object(worker, "check_memory") as memory,
        ):
            self.assertEqual(
                self.client.get("/api/status").json()["pipelines_available"], ["512", "1024"]
            )
            self.assertEqual(self.client.post("/api/model/load").status_code, 202)
            wait_for(lambda: worker.state["phase"] == "ready")
            for pipeline in ("2048", "1536_cascade"):
                response = self.client.post(
                    "/api/generate", json={"image": image_data(), "pipeline": pipeline}
                )
                self.assertEqual(response.status_code, 400)
            memory.reset_mock()
            response = self.client.post(
                "/api/generate", json={"image": image_data(), "pipeline": "1024"}
            )
            self.assertEqual(response.status_code, 202)
            job_id = response.json()["id"]
            wait_for(lambda: worker.jobs[job_id]["status"] == "completed")
            self.assertEqual(seen["pipeline_type"], "1024")
            # The 1024 budget is 18 GiB of host memory and 40 GiB of GPU memory.
            memory.assert_called_once_with(18 * 1024**3, 40 * 1024**3)

    def test_failed_memory_check_does_not_create_output(self):
        fake = types.SimpleNamespace(
            load_trellis=lambda: object(),
            generate_glb=lambda *_a, **_k: self.fail("render must not start"),
        )
        with (
            patch.dict(
                sys.modules,
                {
                    "trellis_backend": fake,
                    "trellis_toolchain": types.SimpleNamespace(configure_toolchain=lambda: None),
                },
            ),
            patch.object(worker, "missing_files", return_value=[]),
            patch.object(
                worker, "check_memory", side_effect=[None, RuntimeError("Not enough memory")]
            ),
        ):
            self.assertEqual(self.client.post("/api/model/load").status_code, 202)
            wait_for(lambda: worker.state["phase"] == "ready")
            job_id = self.client.post("/api/generate", json={"image": image_data()}).json()["id"]
            wait_for(lambda: worker.jobs[job_id]["status"] == "failed")
            self.assertIn("Not enough memory", worker.jobs[job_id]["message"])
            self.assertEqual(self.client.get(f"/api/jobs/{job_id}/mesh").status_code, 404)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary.cleanup()
