"""Cover privacy-safe SAM model-load and segmentation lifecycle events."""

import contextlib
import importlib.util
import io
import json
import logging
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "runtime" / "sam31_worker.py"


def load_worker_module(runtime_dir):
    module_name = "sam31_logging_coverage_worker"
    spec = importlib.util.spec_from_file_location(module_name, WORKER_PATH)
    module = importlib.util.module_from_spec(spec)
    fastapi = types.ModuleType("fastapi")

    class FakeFastAPI:
        def __init__(self, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda handler: handler

        def post(self, *args, **kwargs):
            return lambda handler: handler

    class FakeHTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code

    fastapi.FastAPI = FakeFastAPI
    fastapi.Header = lambda default="": default
    fastapi.HTTPException = FakeHTTPException
    responses = types.ModuleType("fastapi.responses")
    responses.FileResponse = object
    fastapi.responses = responses

    class FakeImage:
        DecompressionBombError = type("DecompressionBombError", (Exception,), {})

    pil = types.ModuleType("PIL")
    pil.Image = FakeImage
    pil.ImageOps = object()
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = object
    pydantic.Field = lambda default=None, **kwargs: default
    substitutes = {
        "fastapi": fastapi,
        "fastapi.responses": responses,
        "PIL": pil,
        "pydantic": pydantic,
        "uvicorn": types.ModuleType("uvicorn"),
    }
    with patch.dict(os.environ, {"FORGE_RUNTIME_DIR": str(runtime_dir)}):
        with patch.dict("sys.modules", substitutes):
            spec.loader.exec_module(module)
    return module


class FakeResult:
    def save(self, path, format):
        self.assert_png_format(format)
        Path(path).write_bytes(b"fake PNG")

    @staticmethod
    def assert_png_format(format):
        if format != "PNG":
            raise AssertionError("Expected a PNG output.")


class SamLoggingCoverageTests(unittest.TestCase):
    def setUp(self):
        self.runtime_dir = tempfile.TemporaryDirectory(prefix="forge-sam-logging-")
        self.addCleanup(self.runtime_dir.cleanup)
        self.worker = load_worker_module(Path(self.runtime_dir.name))
        self.worker.OUTPUTS.mkdir(parents=True, exist_ok=True)
        self.worker.jobs = {}
        self.worker.model = None
        self.worker.state.update(phase="idle", error=None, closing=False)
        self.log_stream = io.StringIO()
        self.log_handler = logging.StreamHandler(self.log_stream)
        self.previous_logger_level = self.worker.logger.level
        self.previous_logger_propagate = self.worker.logger.propagate
        self.worker.logger.setLevel(logging.INFO)
        self.worker.logger.propagate = False
        self.worker.logger.addHandler(self.log_handler)
        self.addCleanup(self._restore_logger)

    def _restore_logger(self):
        self.worker.logger.removeHandler(self.log_handler)
        self.log_handler.close()
        self.worker.logger.setLevel(self.previous_logger_level)
        self.worker.logger.propagate = self.previous_logger_propagate

    @property
    def events(self):
        return [json.loads(line) for line in self.log_stream.getvalue().splitlines()]

    def assert_event(self, index, event, job_id, error_class=None):
        record = self.events[index]
        self.assertEqual(record["event"], f"sam31.{event}")
        self.assertEqual(record["job_id"], job_id)
        self.assertGreaterEqual(record["elapsed_ms"], 0)
        self.assertEqual(record["error_class"], error_class)
        fields = {"event", "job_id", "elapsed_ms", "error_class"}
        if error_class is not None:
            fields.add("traceback_frames")
        self.assertEqual(set(record), fields)

    def assert_safe_worker_frame(self, index, function):
        frames = self.events[index]["traceback_frames"]
        self.assertTrue(
            any(
                frame["file"] == "sam31_worker.py"
                and frame["function"] == function
                and isinstance(frame["line"], int)
                for frame in frames
            )
        )
        for frame in frames:
            self.assertEqual(set(frame), {"file", "function", "line"})
            self.assertNotIn("/", frame["file"])
            self.assertNotIn("\\", frame["file"])

    def test_model_load_success_and_failure_emit_minimal_events(self):
        worker = self.worker
        with (
            patch.object(worker, "require_memory"),
            patch.object(worker, "load_detector", return_value=object()),
        ):
            worker.load_worker("opaque-load-id")

        self.assert_event(0, "model_load_started", "opaque-load-id")
        self.assert_event(1, "model_load_completed", "opaque-load-id")

        worker.model = None
        worker.state.update(phase="loading", error=None)
        stderr = io.StringIO()
        with (
            patch.object(worker, "require_memory"),
            patch.object(
                worker,
                "load_detector",
                side_effect=RuntimeError(
                    "prompt secret /private/model.pt api_key=hidden source snippet: private source snippet"
                ),
            ),
            contextlib.redirect_stderr(stderr),
        ):
            worker.load_worker("opaque-failed-load-id")

        self.assert_event(2, "model_load_started", "opaque-failed-load-id")
        self.assert_event(3, "model_load_failed", "opaque-failed-load-id", "RuntimeError")
        self.assert_safe_worker_frame(3, "load_worker")
        self.assertEqual(stderr.getvalue(), "")
        serialized = self.log_stream.getvalue()
        for private_value in (
            "prompt secret",
            "/private/model.pt",
            "api_key",
            "private source snippet",
        ):
            self.assertNotIn(private_value, serialized)

    def test_segmentation_success_and_failure_emit_minimal_events(self):
        worker = self.worker
        worker.model = object()
        request = types.SimpleNamespace(prompt="private segmentation prompt")
        success_id = "opaque-segmentation-id"
        worker.jobs[success_id] = {"status": "queued"}
        with (
            patch.object(worker, "require_memory"),
            patch.object(worker, "run_segmentation", return_value=(FakeResult(), {})),
        ):
            worker.render_worker(success_id, object(), request)

        self.assert_event(0, "segmentation_started", success_id)
        self.assert_event(1, "segmentation_completed", success_id)
        self.assertEqual(worker.jobs[success_id]["status"], "completed")

        failed_id = "opaque-failed-segmentation-id"
        worker.jobs[failed_id] = {"status": "queued"}
        stderr = io.StringIO()
        with (
            patch.object(worker, "require_memory"),
            patch.object(
                worker,
                "run_segmentation",
                side_effect=ValueError(
                    "private segmentation prompt /private/image.png token=hidden private source snippet"
                ),
            ),
            contextlib.redirect_stderr(stderr),
        ):
            worker.render_worker(failed_id, object(), request)

        self.assert_event(2, "segmentation_started", failed_id)
        self.assert_event(3, "segmentation_failed", failed_id, "ValueError")
        self.assert_safe_worker_frame(3, "render_worker")
        self.assertEqual(stderr.getvalue(), "")
        serialized = self.log_stream.getvalue()
        for private_value in (
            "private segmentation prompt",
            "/private/image.png",
            "token=hidden",
            "private source snippet",
        ):
            self.assertNotIn(private_value, serialized)
        self.assertEqual(worker.jobs[failed_id]["status"], "failed")

    def test_prepare_failure_emits_only_sanitized_traceback_frames(self):
        worker = self.worker
        worker.model = object()
        request = types.SimpleNamespace(
            prompt="private prompt",
            image="data:image/png;base64,ZmFrZQ==",
        )
        stderr = io.StringIO()
        with (
            patch.object(
                worker.Image,
                "open",
                side_effect=RuntimeError(
                    "private prompt C:\\private\\image.png api_key=hidden source snippet"
                ),
                create=True,
            ),
            contextlib.redirect_stderr(stderr),
        ):
            with self.assertRaises(worker.HTTPException) as raised:
                worker.generate(request)

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(len(self.events), 1)
        job_id = self.events[0]["job_id"]
        self.assertEqual(len(job_id), 32)
        self.assert_event(0, "segmentation_prepare_failed", job_id, "RuntimeError")
        self.assert_safe_worker_frame(0, "generate")
        self.assertEqual(stderr.getvalue(), "")
        serialized = self.log_stream.getvalue()
        for private_value in (
            "private prompt",
            "C:\\private\\image.png",
            "api_key",
            "source snippet",
        ):
            self.assertNotIn(private_value, serialized)


if __name__ == "__main__":
    unittest.main()
