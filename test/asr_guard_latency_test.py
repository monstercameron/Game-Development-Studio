"""The speech guard passes the chosen streaming latency to the native engine."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

# runtime/ is not an installed package, so it is added to the path before the import.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))
import asr_guard  # noqa: E402


# Carries only the fields native_command reads. The paths are placeholders; nothing is launched.
def arguments(right_context):
    return SimpleNamespace(
        native=Path("nemo-speech.exe"),
        model=Path("model.gguf"),
        right_context=right_context,
    )


class NativeCommandTests(unittest.TestCase):
    def test_default_command_has_no_latency_option(self):
        command = asr_guard.native_command(arguments(None), 9000)
        self.assertEqual(command[:2], ["nemo-speech.exe", "serve"])
        self.assertNotIn("--asr.streaming.rnnt_right_context", command)
        self.assertIn("--no-ui", command)

    def test_right_context_selects_the_chunk_size(self):
        for right_context in asr_guard.RIGHT_CONTEXTS:
            command = asr_guard.native_command(arguments(right_context), 9000)
            at = command.index("--asr.streaming.rnnt_right_context")
            self.assertEqual(command[at + 1], str(right_context))

    def test_only_documented_modes_are_accepted(self):
        self.assertEqual(asr_guard.RIGHT_CONTEXTS, (0, 1, 6, 13))


if __name__ == "__main__":
    unittest.main()
