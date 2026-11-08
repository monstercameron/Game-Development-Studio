"""Qwen3-TTS sampling controls reach the model only when the caller set them."""

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from coverage_tts_lifecycle_test import load_worker_module  # noqa: E402


class TtsSamplingTests(unittest.TestCase):
    def setUp(self):
        self.runtime_dir = tempfile.TemporaryDirectory(prefix="forge-tts-sampling-")
        self.addCleanup(self.runtime_dir.cleanup)
        self.worker = load_worker_module(Path(self.runtime_dir.name))
        self.worker.jobs = {}
        self.worker.state.update(phase="idle", error=None, closing=False)

    def render(self, **request):
        worker = self.worker
        calls = []

        def generate(**kwargs):
            calls.append(kwargs)
            # One second of silence at the model's 24 kHz output rate.
            return [[0.0] * 24000], 24000

        worker.model = types.SimpleNamespace(generate_custom_voice=generate)
        worker.jobs["b" * 32] = {"status": "queued"}
        # The worker imports soundfile at render time; stub it to write bytes without audio.
        soundfile = types.SimpleNamespace(
            write=lambda path, *args, **kwargs: Path(path).write_bytes(b"audio")
        )
        with patch.dict(sys.modules, {"soundfile": soundfile}):
            worker.render_worker("b" * 32, worker.SpeechRequest(text="hello", **request), None)
        self.assertEqual(worker.jobs["b" * 32]["status"], "completed")
        return calls[0]

    def test_unset_controls_are_not_forwarded(self):
        call = self.render()
        for name in (
            "do_sample",
            "subtalker_dosample",
            "subtalker_temperature",
            "subtalker_top_p",
            "subtalker_top_k",
            "temperature",
        ):
            self.assertNotIn(name, call)

    def test_sub_talker_and_sampling_switches_are_forwarded(self):
        call = self.render(
            do_sample=False,
            subtalker_dosample=True,
            subtalker_temperature=0.5,
            subtalker_top_p=0.8,
            subtalker_top_k=20,
        )
        self.assertIs(call["do_sample"], False)
        self.assertIs(call["subtalker_dosample"], True)
        self.assertEqual(call["subtalker_temperature"], 0.5)
        self.assertEqual(call["subtalker_top_p"], 0.8)
        self.assertEqual(call["subtalker_top_k"], 20)


if __name__ == "__main__":
    unittest.main()
