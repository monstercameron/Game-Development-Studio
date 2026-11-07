"""Cover TTS worker partial-output cleanup and thread startup failures."""

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "runtime" / "tts_worker.py"


class StartFailureThread:
    def __init__(self, *args, **kwargs):
        pass

    def start(self):
        raise RuntimeError("thread start failed")


def load_worker_module(runtime_dir):
    os.environ["FORGE_RUNTIME_DIR"] = str(runtime_dir)
    spec = importlib.util.spec_from_file_location("tts_worker_lifecycle_test_module", WORKER_PATH)
    module = importlib.util.module_from_spec(spec)

    class FakeHTTPException(Exception):
        def __init__(self, status_code, detail):
            super().__init__(detail)
            self.status_code = status_code

    class FakeFastAPI:
        def __init__(self, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda handler: handler

        def post(self, *args, **kwargs):
            return lambda handler: handler

    class FakeBaseModel:
        def __init__(self, **values):
            for key, value in values.items():
                setattr(self, key, value)

    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = FakeFastAPI
    fastapi.Header = lambda default="": default
    fastapi.HTTPException = FakeHTTPException
    responses = types.ModuleType("fastapi.responses")
    responses.FileResponse = object
    fastapi.responses = responses
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = FakeBaseModel
    pydantic.Field = lambda default=None, **kwargs: default
    substitutes = {
        "fastapi": fastapi,
        "fastapi.responses": responses,
        "pydantic": pydantic,
        "uvicorn": types.ModuleType("uvicorn"),
    }
    with patch.dict(sys.modules, substitutes):
        spec.loader.exec_module(module)
    return module


class TtsWorkerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.runtime_dir = tempfile.TemporaryDirectory(prefix="forge-tts-lifecycle-")
        self.addCleanup(self.runtime_dir.cleanup)
        previous_runtime_dir = os.environ.get("FORGE_RUNTIME_DIR")
        self.addCleanup(self._restore_runtime_dir, previous_runtime_dir)
        self.worker = load_worker_module(Path(self.runtime_dir.name))
        self.worker.jobs = {}
        self.worker.model = None
        self.worker.state.update(phase="idle", error=None, closing=False)

    @staticmethod
    def _restore_runtime_dir(previous_runtime_dir):
        if previous_runtime_dir is None:
            os.environ.pop("FORGE_RUNTIME_DIR", None)
        else:
            os.environ["FORGE_RUNTIME_DIR"] = previous_runtime_dir

    def test_render_removes_partial_audio_when_write_fails(self):
        worker = self.worker
        worker.model = types.SimpleNamespace(
            generate_custom_voice=lambda **kwargs: ([b"audio"], 24000)
        )
        worker.jobs["a" * 32] = {"status": "queued"}

        def write_partial_then_fail(path, *args, **kwargs):
            Path(path).write_bytes(b"partial")
            raise OSError("disk write failed")

        soundfile = types.SimpleNamespace(write=write_partial_then_fail)
        with patch.dict(sys.modules, {"soundfile": soundfile}):
            worker.render_worker("a" * 32, worker.SpeechRequest(text="hello"))

        self.assertFalse((worker.OUTPUTS / f".{('a' * 32)}.part").exists())
        self.assertEqual(worker.jobs["a" * 32]["status"], "failed")
        self.assertEqual(worker.state["phase"], "ready")

    def test_load_restores_error_state_when_thread_cannot_start(self):
        worker = self.worker
        with (
            patch.object(worker, "files_ready", return_value=True),
            patch.object(worker.threading, "Thread", StartFailureThread),
        ):
            with self.assertRaises(worker.HTTPException) as raised:
                worker.load()

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(worker.state["phase"], "error")
        self.assertEqual(worker.state["error"], "thread start failed")

    def test_generate_fails_queued_job_when_thread_cannot_start(self):
        worker = self.worker
        worker.model = object()
        with patch.object(worker.threading, "Thread", StartFailureThread):
            with self.assertRaises(worker.HTTPException) as raised:
                worker.generate(worker.SpeechRequest(text="hello"))

        self.assertEqual(raised.exception.status_code, 500)
        self.assertEqual(worker.state["phase"], "ready")
        self.assertEqual(len(worker.jobs), 1)
        job = next(iter(worker.jobs.values()))
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["message"], "thread start failed")


if __name__ == "__main__":
    unittest.main()
