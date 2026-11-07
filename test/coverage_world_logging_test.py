"""Privacy-safe lifecycle logging tests for the world worker."""

import importlib
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))

_runtime_dir = tempfile.TemporaryDirectory()
_worker_dependencies = {
    "uvicorn": types.ModuleType("uvicorn"),
    "asr_guard": types.ModuleType("asr_guard"),
    "fastapi": types.ModuleType("fastapi"),
    "fastapi.responses": types.ModuleType("fastapi.responses"),
    "pydantic": types.ModuleType("pydantic"),
}


class FakeFastAPI:
    def __init__(self, **kwargs):
        return None

    def get(self, *args, **kwargs):
        return lambda function: function

    def post(self, *args, **kwargs):
        return lambda function: function


class FakeHTTPException(Exception):
    pass


_worker_dependencies["asr_guard"].WindowsJob = object
_worker_dependencies["fastapi"].FastAPI = FakeFastAPI
_worker_dependencies["fastapi"].HTTPException = FakeHTTPException
_worker_dependencies["fastapi.responses"].FileResponse = object
_worker_dependencies["pydantic"].BaseModel = object
_worker_dependencies["pydantic"].Field = lambda default=None, **kwargs: default
with (
    mock.patch.dict(sys.modules, _worker_dependencies),
    mock.patch.dict(os.environ, {"FORGE_RUNTIME_DIR": _runtime_dir.name}),
):
    world_worker = importlib.import_module("world_worker")


class FakeGuard:
    def add(self, child):
        return None

    def close(self):
        return None


class FakeChild:
    def kill(self):
        return None

    def wait(self):
        return None


class CaptureHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


class WorldWorkerLoggingTests(unittest.TestCase):
    def setUp(self):
        self.handler = CaptureHandler()
        world_worker.logger.addHandler(self.handler)
        world_worker.logger.setLevel(logging.INFO)
        self.job_id = "a" * 32
        world_worker.jobs[self.job_id] = {"status": "queued"}
        world_worker.state["busy"] = True

    def tearDown(self):
        world_worker.logger.removeHandler(self.handler)
        world_worker.jobs.pop(self.job_id, None)
        world_worker.state["busy"] = False

    def parsed_events(self):
        return [json.loads(message) for message in self.handler.messages]

    def run_job(self, desktop, work, wait_side_effect):
        request = SimpleNamespace(model="worldgen")
        with (
            mock.patch.object(world_worker, "DESKTOP", desktop),
            mock.patch.object(world_worker, "WindowsJob", FakeGuard),
            mock.patch.object(world_worker.subprocess, "Popen", return_value=FakeChild()),
            mock.patch.object(world_worker, "wait_for_render", side_effect=wait_side_effect),
        ):
            world_worker.run_job(self.job_id, request, work)

    def test_startup_failure_logs_only_safe_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / "work"
            work.mkdir()
            self.run_job(Path(directory), work, None)

        [event] = self.parsed_events()
        self.assertEqual(event["engine"], "worldgen")
        self.assertEqual(event["event"], "startup_failed")
        self.assertEqual(event["job_id"], self.job_id)
        self.assertGreaterEqual(event["elapsed_ms"], 0)
        self.assertEqual(event["exception_class"], "RuntimeError")
        self.assertNotIn("Python environment is missing", self.handler.messages[0])

    def test_render_success_logs_startup_and_render_events(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / "WorldGen" / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            work = root / "work"
            work.mkdir()

            def finish_render(child, guard):
                (work / "result.ply").touch()
                return 0

            self.run_job(root, work, finish_render)

        events = self.parsed_events()
        self.assertEqual(
            [event["event"] for event in events],
            [
                "startup_succeeded",
                "render_succeeded",
            ],
        )
        for event in events:
            self.assertEqual(event["engine"], "worldgen")
            self.assertEqual(event["job_id"], self.job_id)
            self.assertGreaterEqual(event["elapsed_ms"], 0)
            self.assertIsNone(event["exception_class"])

    def test_render_failure_logs_exception_class_without_error_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            python = root / "WorldGen" / ".venv" / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True)
            python.touch()
            work = root / "work"
            work.mkdir()
            sensitive_path = str(root / "private-input.png")

            def fail_render(child, guard):
                raise RuntimeError(f"private prompt at {sensitive_path}")

            self.run_job(root, work, fail_render)

        events = self.parsed_events()
        self.assertEqual(events[-1]["event"], "render_failed")
        self.assertEqual(events[-1]["exception_class"], "RuntimeError")
        event_json = self.handler.messages[-1]
        self.assertNotIn("private prompt", event_json)
        self.assertNotIn(sensitive_path, event_json)
        frames = events[-1]["traceback_frames"]
        self.assertTrue(any(frame["function"] == "fail_render" for frame in frames))
        self.assertTrue(all(set(frame) == {"file", "function", "line"} for frame in frames))
        self.assertTrue(all(Path(frame["file"]).name == frame["file"] for frame in frames))


if __name__ == "__main__":
    unittest.main()
