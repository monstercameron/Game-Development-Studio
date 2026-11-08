"""Detached Windows workers get a hidden console, and external engines can be wrapped."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1] / "runtime"
sys.path.insert(0, str(RUNTIME))
import hidden_console  # noqa: E402

DETACHED_PROCESS = 0x00000008
PROBE = """
import ctypes, json, sys
sys.path.insert(0, {runtime!r})
import hidden_console
k = ctypes.WinDLL("kernel32")
k.GetConsoleWindow.restype = ctypes.c_void_p
u = ctypes.WinDLL("user32")
u.IsWindowVisible.argtypes = [ctypes.c_void_p]
ids = (ctypes.c_uint * 4)()
window = k.GetConsoleWindow()
print(json.dumps({{"attached": k.GetConsoleProcessList(ids, 4), "visible": bool(window and u.IsWindowVisible(window))}}))
"""


class HiddenConsoleTest(unittest.TestCase):
    def test_nothing_happens_off_windows_or_when_disabled(self):
        with patch.object(sys, "platform", "linux"):
            self.assertFalse(hidden_console.ensure_hidden_console())
        with patch.dict(os.environ, {"FORGE_ALLOW_CONSOLE_WINDOWS": "1"}):
            self.assertFalse(hidden_console.ensure_hidden_console())

    @unittest.skipUnless(sys.platform == "win32", "Windows consoles only")
    def test_detached_process_receives_an_invisible_console(self):
        # Like Forge's launcher: detached, with the window state hidden. The base
        # interpreter is used because a venv's python.exe redirector would itself
        # open a console for the real interpreter.
        hidden = subprocess.STARTUPINFO(dwFlags=subprocess.STARTF_USESHOWWINDOW, wShowWindow=0)
        python = getattr(sys, "_base_executable", sys.executable)
        result = subprocess.run(
            [python, "-c", PROBE.format(runtime=str(RUNTIME))],
            env={**os.environ, "__PYVENV_LAUNCHER__": sys.executable},
            startupinfo=hidden,
            creationflags=DETACHED_PROCESS,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            check=True,
        )
        state = json.loads(result.stdout)
        self.assertGreaterEqual(state["attached"], 1)
        self.assertFalse(state["visible"])


class ConsoleLaunchTest(unittest.TestCase):
    def run_launcher(self, *args):
        return subprocess.run(
            [sys.executable, str(RUNTIME / "console_launch.py"), *args],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )

    def test_script_runs_as_main_with_its_own_arguments(self):
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / "engine.py"
            script.write_text(
                "import json, os, sys\n"
                f"runtime = {str(RUNTIME)!r}\n"
                "print(json.dumps([__name__, __file__, sys.argv, sys.path[0],"
                " any(os.path.abspath(p or '.') == runtime for p in sys.path)]))\n",
                encoding="utf-8",
            )
            name, file, argv, first, leaked = json.loads(
                self.run_launcher(str(script), "--port", "9").stdout
            )
        self.assertEqual(name, "__main__")
        self.assertEqual(Path(file), script)
        self.assertEqual(argv, [str(script), "--port", "9"])
        self.assertEqual(Path(first), script.parent)
        self.assertFalse(leaked)

    def test_module_runs_as_main(self):
        output = self.run_launcher("-m", "json.tool", "--help").stdout
        self.assertIn("usage", output.lower())

    def test_usage_errors_exit_nonzero(self):
        for args in ([], ["-m"]):
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_launcher(*args)


if __name__ == "__main__":
    unittest.main()
