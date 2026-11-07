"""Verify HY-Motion lifecycle logging without loading weights or starting services."""

import contextlib
import importlib.util
import io
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))


def load_worker_module(runtime_dir):
    os.environ["FORGE_RUNTIME_DIR"] = str(runtime_dir)
    spec = importlib.util.spec_from_file_location(
        "hymotion_worker_logging_test_module",
        Path(__file__).resolve().parents[1] / "runtime" / "hymotion_worker.py",
    )
    module = importlib.util.module_from_spec(spec)

    class FakeFastAPI:
        def __init__(self, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda handler: handler

        def post(self, *args, **kwargs):
            return lambda handler: handler

    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = FakeFastAPI
    fastapi.Header = lambda default="": default
    fastapi.HTTPException = RuntimeError
    responses = types.ModuleType("fastapi.responses")
    responses.FileResponse = object
    fastapi.responses = responses
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = object
    pydantic.Field = lambda default=None, **kwargs: default
    engine_identity = types.ModuleType("engine_identity")
    engine_identity.install_identity_endpoint = lambda *args: None
    worker_outputs = types.ModuleType("worker_outputs")
    worker_outputs.recovered_job = lambda *args: None
    substitutes = {
        "engine_identity": engine_identity,
        "fastapi": fastapi,
        "fastapi.responses": responses,
        "pydantic": pydantic,
        "uvicorn": types.ModuleType("uvicorn"),
        "worker_outputs": worker_outputs,
    }
    with patch.dict(sys.modules, substitutes):
        spec.loader.exec_module(module)
    return module


with tempfile.TemporaryDirectory(prefix="forge-motion-logging-import-") as runtime_dir:
    previous_runtime_dir = os.environ.get("FORGE_RUNTIME_DIR")
    worker = load_worker_module(Path(runtime_dir))
    if previous_runtime_dir is None:
        os.environ.pop("FORGE_RUNTIME_DIR", None)
    else:
        os.environ["FORGE_RUNTIME_DIR"] = previous_runtime_dir


def fail_with_sensitive_traceback(*args, **kwargs):
    exec(
        compile(
            "def invoke(depth):\n"
            "    if depth:\n"
            "        return invoke(depth - 1)\n"
            "    raise ValueError('private prompt C:/private/model')\n"
            "invoke(12)\n",
            r"C:\private\model-source\generate.py",
            "exec",
        ),
        {},
    )


class MotionLifecycleLoggingTests(unittest.TestCase):
    def setUp(self):
        self.previous_model = worker.model
        self.previous_outputs = worker.OUTPUTS
        self.previous_state = worker.state.copy()
        self.previous_jobs = worker.jobs.copy()
        self.temp = tempfile.TemporaryDirectory(prefix="forge-motion-logging-")
        worker.OUTPUTS = Path(self.temp.name)
        worker.model = None
        worker.jobs = {}
        worker.state.update(phase="idle", error=None, closing=False)

    def tearDown(self):
        worker.model = self.previous_model
        worker.OUTPUTS = self.previous_outputs
        worker.state.clear()
        worker.state.update(self.previous_state)
        worker.jobs = self.previous_jobs
        self.temp.cleanup()

    @staticmethod
    @contextlib.contextmanager
    def capture_formatted_logs():
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = worker.logger
        previous_level = logger.level
        previous_propagate = logger.propagate
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
        try:
            yield stream
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous_level)
            logger.propagate = previous_propagate

    @staticmethod
    def fields_from(stream):
        return [json.loads(line) for line in stream.getvalue().splitlines()]

    def test_model_load_logs_start_and_completion_with_opaque_id(self):
        fake = types.SimpleNamespace(
            load_motion_core=Mock(return_value=object()),
            load_motion_text_encoder=Mock(return_value=object()),
        )
        with (
            patch.dict(sys.modules, {"hymotion_backend": fake}),
            patch.object(worker, "require_memory"),
            patch.object(worker, "free_host_memory", return_value=16 * 1024**3),
            self.capture_formatted_logs() as output,
        ):
            worker.load_worker()

        formatted = output.getvalue()
        fields = self.fields_from(output)
        self.assertEqual(
            [item["event"] for item in fields],
            ["model_load_started", "model_load_completed"],
        )
        self.assertEqual(fields[0]["job_id"], fields[1]["job_id"])
        self.assertEqual(len(fields[0]["job_id"]), 32)
        self.assertTrue(all(item["elapsed_ms"] >= 0 for item in fields))
        self.assertTrue(all("exception_class" not in item for item in fields))
        self.assertTrue(all('"event":' in line for line in formatted.splitlines()))

    def test_model_load_failure_logs_sanitized_traceback(self):
        with (
            patch.object(
                worker,
                "require_memory",
                side_effect=fail_with_sensitive_traceback,
            ),
            patch.object(worker, "clear_cuda_cache"),
            self.capture_formatted_logs() as output,
        ):
            worker.load_worker()

        formatted = output.getvalue()
        fields = self.fields_from(output)
        self.assertEqual(
            [item["event"] for item in fields], ["model_load_started", "model_load_failed"]
        )
        self.assertEqual(fields[1]["exception_class"], "ValueError")
        self.assertEqual(
            set(fields[1]),
            {
                "engine",
                "event",
                "job_id",
                "elapsed_ms",
                "exception_class",
                "traceback_frames",
            },
        )
        self.assertIn(
            {"file": "generate.py", "function": "invoke", "line": 4},
            fields[1]["traceback_frames"],
        )
        self.assertEqual(len(fields[1]["traceback_frames"]), 8)
        self.assertNotIn("private prompt", formatted)
        self.assertNotIn("C:/private/model", formatted)
        self.assertNotIn(r"C:\private\model-source", formatted)

    def test_render_logs_start_and_completion(self):
        job_id = "a" * 32
        worker.jobs[job_id] = {"status": "queued"}
        worker.model = object()
        fake = types.SimpleNamespace(generate_motion=Mock(return_value="HIERARCHY\nMOTION\n"))
        request = types.SimpleNamespace(
            prompt="private prompt", duration=3, seed=123, steps=50, guidance=5
        )
        with (
            patch.dict(sys.modules, {"hymotion_backend": fake}),
            patch.object(worker, "require_memory"),
            self.capture_formatted_logs() as output,
        ):
            worker.render_worker(job_id, request)

        formatted = output.getvalue()
        fields = self.fields_from(output)
        self.assertEqual(
            [item["event"] for item in fields],
            ["motion_render_started", "motion_render_completed"],
        )
        self.assertTrue(all(item["job_id"] == job_id for item in fields))
        self.assertTrue((worker.OUTPUTS / f"{job_id}.bvh").is_file())
        self.assertNotIn("private prompt", formatted)

    def test_render_failure_logs_sanitized_traceback(self):
        job_id = "b" * 32
        worker.jobs[job_id] = {"status": "queued"}
        worker.model = object()
        fake = types.SimpleNamespace(
            generate_motion=Mock(side_effect=fail_with_sensitive_traceback)
        )
        request = types.SimpleNamespace(
            prompt="private prompt", duration=3, seed=123, steps=50, guidance=5
        )
        with (
            patch.dict(sys.modules, {"hymotion_backend": fake}),
            patch.object(worker, "require_memory"),
            patch.object(worker, "clear_cuda_cache"),
            self.capture_formatted_logs() as output,
        ):
            worker.render_worker(job_id, request)

        formatted = output.getvalue()
        fields = self.fields_from(output)
        self.assertEqual(
            [item["event"] for item in fields],
            ["motion_render_started", "motion_render_failed"],
        )
        self.assertEqual(fields[1]["exception_class"], "ValueError")
        self.assertEqual(fields[1]["job_id"], job_id)
        self.assertIn(
            {"file": "generate.py", "function": "invoke", "line": 4},
            fields[1]["traceback_frames"],
        )
        self.assertEqual(len(fields[1]["traceback_frames"]), 8)
        self.assertNotIn("private prompt", formatted)
        self.assertNotIn("C:/private/model", formatted)
        self.assertNotIn(r"C:\private\model-source", formatted)


if __name__ == "__main__":
    unittest.main()
