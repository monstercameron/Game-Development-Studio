"""Unit tests for the Qwen3-TTS clone and design branches, using a fake model and stubbed libraries."""

import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "runtime" / "tts_worker.py"


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeBaseModel:
    def __init__(self, **values):
        for key, value in vars(type(self)).items():
            if not key.startswith("_") and not callable(value):
                setattr(self, key, value)
        for key, value in values.items():
            setattr(self, key, value)


class FakeAudio:
    """Stands in for a numpy waveform: only the attributes the worker reads are provided."""

    def __init__(self, length):
        self.ndim = 1
        self._length = length

    def __len__(self):
        return self._length

    def astype(self, _dtype):
        return self


def load_worker_module(runtime_dir):
    os.environ["FORGE_RUNTIME_DIR"] = str(runtime_dir)
    spec = importlib.util.spec_from_file_location("tts_worker_voice_modes_test", WORKER_PATH)
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


def fake_soundfile(length_samples, sample_rate=16000):
    return types.SimpleNamespace(
        read=lambda *args, **kwargs: (FakeAudio(length_samples), sample_rate)
    )


class RecordingModel:
    def __init__(self, label):
        self.label = label
        self.calls = []

    def generate_custom_voice(self, **kwargs):
        self.calls.append(("custom_voice", kwargs))
        return [b"wav"], 24000

    def generate_voice_clone(self, **kwargs):
        self.calls.append(("clone", kwargs))
        return [b"wav"], 24000

    def generate_voice_design(self, **kwargs):
        self.calls.append(("design", kwargs))
        return [b"wav"], 24000


class VoiceModesWorkerTests(unittest.TestCase):
    def setUp(self):
        self.runtime_dir = tempfile.TemporaryDirectory(prefix="forge-tts-voice-modes-")
        self.addCleanup(self.runtime_dir.cleanup)
        self.worker = load_worker_module(Path(self.runtime_dir.name))
        self.worker.jobs = {}
        self.worker.model = None
        self.worker.loaded_variant = None
        self.worker.state.update(phase="ready", error=None, closing=False)

    def request(self, **values):
        base = {"text": "Hello there", "language": "English", "seed": 3}
        base.update(values)
        return self.worker.SpeechRequest(**base)

    def test_clone_sends_reference_transcript_in_icl_mode_and_the_decoded_clip(self):
        model = RecordingModel("base")
        clip = (FakeAudio(16000 * 5), 16000)
        request = self.request(
            mode="clone", reference_text="The reference words.", max_new_tokens=512
        )
        self.worker.model = model
        wavs, sample_rate = self.worker.synthesize(request, clip, {"temperature": 0.7})
        self.assertEqual((wavs, sample_rate), ([b"wav"], 24000))
        name, kwargs = model.calls[-1]
        self.assertEqual(name, "clone")
        self.assertEqual(kwargs["ref_text"], "The reference words.")
        self.assertIs(kwargs["ref_audio"], clip)
        self.assertFalse(kwargs["x_vector_only_mode"])
        self.assertEqual(kwargs["max_new_tokens"], 512)
        self.assertEqual(kwargs["temperature"], 0.7)

    def test_voice_only_clone_uses_x_vector_mode_and_withholds_any_transcript(self):
        model = RecordingModel("base")
        clip = (FakeAudio(16000 * 5), 16000)
        self.worker.model = model
        for transcript in ("", "Words that must not reach the model."):
            with self.subTest(transcript=transcript):
                request = self.request(
                    mode="clone", clone_voice_only=True, reference_text=transcript
                )
                self.worker.synthesize(request, clip, {})
                name, kwargs = model.calls[-1]
                self.assertEqual(name, "clone")
                self.assertTrue(kwargs["x_vector_only_mode"])
                self.assertIsNone(kwargs["ref_text"])
                self.assertIs(kwargs["ref_audio"], clip)

    def test_clone_request_defaults_to_the_transcript_mode(self):
        self.assertFalse(self.request(mode="clone").clone_voice_only)

    def test_generate_accepts_a_voice_only_clone_without_a_transcript(self):
        self.worker.model = RecordingModel("base")
        self.worker.loaded_variant = "base"
        request = self.request(
            mode="clone", clone_voice_only=True, reference_audio_base64="UklGRg=="
        )
        with patch.dict(sys.modules, {"soundfile": fake_soundfile(16000 * 5)}):
            with patch.object(self.worker.threading, "Thread") as thread:
                response = self.worker.generate(request)
        self.assertRegex(response["id"], r"^[0-9a-f]{32}$")
        self.assertIn(response["id"], self.worker.jobs)
        started_request = thread.call_args.kwargs["args"][1]
        self.assertTrue(started_request.clone_voice_only)

    def test_design_passes_the_description_as_instruct(self):
        model = RecordingModel("design")
        self.worker.model = model
        request = self.request(mode="design", voice_description="A calm narrator, low and warm.")
        self.worker.synthesize(request, None, {})
        name, kwargs = model.calls[-1]
        self.assertEqual(name, "design")
        self.assertEqual(kwargs["instruct"], "A calm narrator, low and warm.")
        self.assertNotIn("speaker", kwargs)

    def test_preset_keeps_the_custom_voice_call(self):
        model = RecordingModel("custom")
        self.worker.model = model
        self.worker.synthesize(self.request(speaker="Aiden", instruct="Brisk."), None, {})
        name, kwargs = model.calls[-1]
        self.assertEqual(name, "custom_voice")
        self.assertEqual(kwargs["speaker"], "Aiden")
        self.assertEqual(kwargs["instruct"], "Brisk.")

    def test_reference_clip_must_be_3_to_30_seconds(self):
        encoded = "UklGRg=="
        with patch.dict(sys.modules, {"soundfile": fake_soundfile(16000 * 2)}):
            with self.assertRaises(FakeHTTPException) as short:
                self.worker.decode_reference(encoded)
        self.assertEqual(short.exception.status_code, 400)
        self.assertIn("3 to 30 seconds", short.exception.detail)
        with patch.dict(sys.modules, {"soundfile": fake_soundfile(16000 * 31)}):
            with self.assertRaises(FakeHTTPException):
                self.worker.decode_reference(encoded)
        with patch.dict(sys.modules, {"soundfile": fake_soundfile(16000 * 10)}):
            audio, sample_rate = self.worker.decode_reference(encoded)
        self.assertEqual((len(audio), sample_rate), (16000 * 10, 16000))

    def test_reference_must_be_valid_base64(self):
        with patch.dict(sys.modules, {"soundfile": fake_soundfile(16000 * 5)}):
            with self.assertRaises(FakeHTTPException) as error:
                self.worker.decode_reference("%%% not base64 %%%")
        self.assertEqual(error.exception.status_code, 400)

    def test_generate_refuses_bad_clone_and_design_requests_before_queuing(self):
        self.worker.model = RecordingModel("custom")
        self.worker.loaded_variant = "custom_voice"
        cases = [
            (self.request(mode="clone", reference_audio_base64="UklGRg=="), "transcript"),
            (self.request(mode="design", voice_description="   "), "voice description"),
            (self.request(mode="whisper"), "Unknown voice mode"),
        ]
        for request, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(FakeHTTPException) as error:
                    self.worker.generate(request)
                self.assertEqual(error.exception.status_code, 400)
                self.assertIn(message, error.exception.detail)
        self.assertEqual(self.worker.jobs, {})

    def test_generate_refuses_a_mode_whose_checkpoint_is_not_resident(self):
        self.worker.model = RecordingModel("custom")
        self.worker.loaded_variant = "custom_voice"
        with self.assertRaises(FakeHTTPException) as error:
            self.worker.generate(self.request(mode="design", voice_description="A bright voice."))
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("voice_design", error.exception.detail)

    def test_load_names_the_checkpoint_and_swaps_only_when_it_differs(self):
        started = []

        class FakeThread:
            def __init__(self, target, args=(), daemon=False):
                started.append(args)

            def start(self):
                pass

        self.worker.model = RecordingModel("custom")
        self.worker.loaded_variant = "custom_voice"
        with patch.object(self.worker, "checkpoint_ready", return_value=True), patch.object(
            self.worker.threading, "Thread", FakeThread
        ):
            same = self.worker.load(self.worker.LoadRequest(variant="custom_voice"))
            swap = self.worker.load(self.worker.LoadRequest(variant="base"))
        self.assertEqual(same, {"message": "Already loaded."})
        self.assertEqual(swap, {"message": "Loading started."})
        self.assertEqual(started, [("base",)])
        self.assertEqual(self.worker.state["phase"], "loading")

    def test_load_rejects_unknown_or_missing_checkpoints(self):
        with self.assertRaises(FakeHTTPException) as unknown:
            self.worker.load(self.worker.LoadRequest(variant="turbo"))
        self.assertEqual(unknown.exception.status_code, 400)
        self.worker.state["phase"] = "ready"
        with patch.object(self.worker, "checkpoint_ready", return_value=False):
            with self.assertRaises(FakeHTTPException) as missing:
                self.worker.load(self.worker.LoadRequest(variant="voice_design"))
        self.assertEqual(missing.exception.status_code, 409)

    def test_status_reports_the_resident_checkpoint_and_each_installed_checkpoint(self):
        self.worker.model = RecordingModel("base")
        self.worker.loaded_variant = "base"
        with patch.object(
            self.worker,
            "checkpoint_ready",
            side_effect=lambda name: name in ("custom_voice", "base"),
        ):
            status = self.worker.status()
        self.assertEqual(status["loaded_variant"], "base")
        self.assertEqual(
            status["variants"], {"custom_voice": True, "base": True, "voice_design": False}
        )
        self.assertTrue(status["loaded"])

    def test_load_unloads_the_previous_checkpoint_before_loading_the_new_one(self):
        events = []
        previous = RecordingModel("custom")
        self.worker.model = previous
        self.worker.loaded_variant = "custom_voice"

        class FakeQwen:
            @staticmethod
            def from_pretrained(path, **kwargs):
                events.append(("load", Path(path).name, self.worker.model))
                return RecordingModel("design")

        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(
                is_available=lambda: True,
                empty_cache=lambda: events.append(("empty_cache", None, self.worker.model)),
            ),
            bfloat16="bf16",
        )
        fake_qwen = types.SimpleNamespace(Qwen3TTSModel=FakeQwen)
        with patch.dict(sys.modules, {"torch": fake_torch, "qwen_tts": fake_qwen}):
            self.worker.load_worker("voice_design")
        self.assertEqual(events[0], ("empty_cache", None, None))
        self.assertEqual(events[1], ("load", "Qwen3-TTS-12Hz-1.7B-VoiceDesign", None))
        self.assertEqual(self.worker.loaded_variant, "voice_design")
        self.assertEqual(self.worker.state["phase"], "ready")


if __name__ == "__main__":
    unittest.main()
