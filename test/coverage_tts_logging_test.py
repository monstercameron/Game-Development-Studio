"""Verify TTS lifecycle logs expose metadata without speech content or errors."""

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

ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "runtime" / "tts_worker.py"


def load_worker_module(runtime_dir):
    os.environ["FORGE_RUNTIME_DIR"] = str(runtime_dir)
    spec = importlib.util.spec_from_file_location("tts_worker_logging_test_module", WORKER_PATH)
    module = importlib.util.module_from_spec(spec)

    class FakeFastAPI:
        def __init__(self, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda handler: handler

        def post(self, *args, **kwargs):
            return lambda handler: handler

    class FakeBaseModel:
        def __init__(self, **values):
            # Class-level defaults (such as mode = "preset") apply as they do in pydantic.
            for key, value in vars(type(self)).items():
                if not key.startswith("_") and not callable(value):
                    setattr(self, key, value)
            for key, value in values.items():
                setattr(self, key, value)

    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = FakeFastAPI
    fastapi.Header = lambda default="": default
    fastapi.HTTPException = RuntimeError
    responses = types.ModuleType("fastapi.responses")
    responses.FileResponse = object
    fastapi.responses = responses
    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = FakeBaseModel
    pydantic.Field = lambda default=None, **kwargs: default
    identity = types.ModuleType("engine_identity")
    identity.install_identity_endpoint = lambda *args: None
    outputs = types.ModuleType("worker_outputs")
    outputs.recovered_job = lambda *args: None
    substitutes = {
        "engine_identity": identity,
        "fastapi": fastapi,
        "fastapi.responses": responses,
        "pydantic": pydantic,
        "uvicorn": types.ModuleType("uvicorn"),
        "worker_outputs": outputs,
    }
    with patch.dict(sys.modules, substitutes):
        spec.loader.exec_module(module)
    return module


class TtsWorkerLoggingTests(unittest.TestCase):
    def setUp(self):
        self.runtime_dir = tempfile.TemporaryDirectory(prefix="forge-tts-logging-")
        self.addCleanup(self.runtime_dir.cleanup)
        previous_runtime_dir = os.environ.get("FORGE_RUNTIME_DIR")
        self.addCleanup(self._restore_runtime_dir, previous_runtime_dir)
        self.worker = load_worker_module(Path(self.runtime_dir.name))
        self.log_output = io.StringIO()
        self.log_handler = logging.StreamHandler(self.log_output)
        self.log_handler.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
        self.worker.logger = logging.Logger("tts_logging_test")
        self.worker.logger.addHandler(self.log_handler)
        self.worker.logger.setLevel(logging.INFO)

    @staticmethod
    def _restore_runtime_dir(previous_runtime_dir):
        if previous_runtime_dir is None:
            os.environ.pop("FORGE_RUNTIME_DIR", None)
        else:
            os.environ["FORGE_RUNTIME_DIR"] = previous_runtime_dir

    def test_load_success_logs_structured_lifecycle_without_model_path(self):
        worker = self.worker
        fake_torch = types.ModuleType("torch")
        fake_torch.cuda = types.SimpleNamespace(is_available=lambda: True)
        fake_torch.bfloat16 = object()
        fake_qwen = types.ModuleType("qwen_tts")
        fake_qwen.Qwen3TTSModel = types.SimpleNamespace(
            from_pretrained=lambda *args, **kwargs: object()
        )

        with patch.dict(sys.modules, {"torch": fake_torch, "qwen_tts": fake_qwen}):
            worker.load_worker("custom_voice")

        lines = self.log_output.getvalue().splitlines()
        records = [json.loads(line.split(":", 2)[2]) for line in lines]
        self.assertEqual(
            [record["event"] for record in records],
            ["model_load_started", "model_load_completed"],
        )
        self.assertTrue(all(record["engine"] == "forge-qwen3-tts-v1" for record in records))
        for record in records:
            self.assertEqual(
                set(record),
                {
                    "engine",
                    "event",
                    "job_id",
                    "elapsed_ms",
                    "exception_class",
                    "traceback_frames",
                },
            )
            self.assertIsInstance(record["elapsed_ms"], int)
            self.assertEqual(record["job_id"], None)
            self.assertEqual(record["traceback_frames"], [])
        self.assertNotIn(str(worker.CHECKPOINTS["custom_voice"]), self.log_output.getvalue())

    def test_generation_failure_logs_only_opaque_job_metadata_and_exception_class(self):
        worker = self.worker
        secret_text = "private spoken phrase"
        error_detail = "private failure detail"
        job_id = "a" * 32
        worker.model = types.SimpleNamespace(
            generate_custom_voice=lambda **kwargs: (_ for _ in ()).throw(RuntimeError(error_detail))
        )
        worker.jobs[job_id] = {"status": "queued"}
        fake_soundfile = types.ModuleType("soundfile")
        fake_soundfile.write = Mock()

        with patch.dict(sys.modules, {"soundfile": fake_soundfile}):
            worker.render_worker(job_id, worker.SpeechRequest(text=secret_text), None)

        lines = self.log_output.getvalue().splitlines()
        records = [json.loads(line.split(":", 2)[2]) for line in lines]
        self.assertEqual(len(records), 2)
        failed = records[-1]
        self.assertEqual(failed["event"], "generation_failed")
        self.assertEqual(failed["engine"], "forge-qwen3-tts-v1")
        self.assertEqual(failed["job_id"], job_id)
        self.assertEqual(failed["exception_class"], "RuntimeError")
        self.assertIsInstance(failed["elapsed_ms"], int)
        self.assertTrue(failed["traceback_frames"])
        for frame in failed["traceback_frames"]:
            self.assertEqual(set(frame), {"file", "function", "line"})
            self.assertNotIn("/", frame["file"])
            self.assertNotIn("\\", frame["file"])
            self.assertIsInstance(frame["function"], str)
            self.assertIsInstance(frame["line"], int)
        self.assertNotIn(secret_text, repr(records))
        self.assertNotIn(error_detail, repr(records))
        self.assertNotIn(str(ROOT), repr(records))
        self.assertNotIn(secret_text, self.log_output.getvalue())
        self.assertNotIn(error_detail, self.log_output.getvalue())
        self.assertEqual(worker.jobs[job_id]["status"], "failed")

    def test_formatted_json_limits_frames_and_strips_both_path_separators(self):
        worker = self.worker
        try:
            raise ValueError("private exception detail")
        except ValueError as error:
            frames = [
                types.SimpleNamespace(filename=path, name="private_function", lineno=index)
                for index, path in enumerate(
                    ["C:\\secret\\weights.py", "/home/private/prompt.py"] * 6,
                    start=1,
                )
            ]
            with patch.object(worker.traceback, "extract_tb", return_value=frames):
                worker.log_lifecycle(
                    "generation_failed", started_at=worker.time.perf_counter(), error=error
                )

        formatted = self.log_output.getvalue().strip()
        payload = json.loads(formatted.split(":", 2)[2])
        self.assertEqual(payload["event"], "generation_failed")
        self.assertEqual(len(payload["traceback_frames"]), 8)
        self.assertEqual(
            {frame["file"] for frame in payload["traceback_frames"]},
            {"weights.py", "prompt.py"},
        )
        self.assertNotIn("C:\\secret", formatted)
        self.assertNotIn("/home/private", formatted)
        self.assertNotIn("private exception detail", formatted)


if __name__ == "__main__":
    unittest.main()
