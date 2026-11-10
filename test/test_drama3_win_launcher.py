"""Exercise the local launcher with a harmless Python child, never a model."""

import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

LAUNCHER = Path(__file__).resolve().parents[1] / "engines/drama3/bin/forge-drama3-launcher.exe"


@unittest.skipUnless(os.name == "nt" and LAUNCHER.is_file(), "Native Windows launcher is not built")
class Drama3LauncherTests(unittest.TestCase):
    def test_preserves_arguments_exit_code_and_working_set_cap(self):
        child = (
            "import ctypes,json,sys; "
            "k=ctypes.WinDLL('kernel32',use_last_error=True); "
            "k.GetCurrentProcess.restype=ctypes.c_void_p; "
            "a=ctypes.c_size_t();b=ctypes.c_size_t();f=ctypes.c_ulong(); "
            "k.GetProcessWorkingSetSizeEx.argtypes=(ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),"
            "ctypes.POINTER(ctypes.c_size_t),ctypes.POINTER(ctypes.c_ulong)); "
            "assert k.GetProcessWorkingSetSizeEx(k.GetCurrentProcess(),ctypes.byref(a),ctypes.byref(b),ctypes.byref(f)); "
            "print(json.dumps([sys.argv[1:],b.value,f.value]));sys.exit(37)"
        )
        args = ["two words", 'a"b', "trailing\\", ""]
        result = subprocess.run(
            [str(LAUNCHER), sys.executable, "-c", child, *args],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(result.returncode, 37, result.stderr)
        received, maximum, flags = json.loads(result.stdout)
        self.assertEqual(received, args)
        self.assertEqual(maximum, 2 * 1024**3)
        self.assertEqual(flags & 4, 4)

    def test_parent_termination_kills_only_its_child(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "child.pid"
            child = "import os,pathlib,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(60)"
            parent = subprocess.Popen([str(LAUNCHER), sys.executable, "-c", child, str(marker)])
            handle = None
            try:
                deadline = time.monotonic() + 15
                while not marker.exists() and parent.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertTrue(marker.exists(), "Child did not start")
                handle = kernel.OpenProcess(0x00100000, False, int(marker.read_text()))
                self.assertTrue(handle, "Could not open test child")
                parent.terminate()
                parent.wait(timeout=10)
                self.assertEqual(
                    kernel.WaitForSingleObject(handle, 10000), 0, "Child survived launcher"
                )
            finally:
                if parent.poll() is None:
                    parent.kill()
                    parent.wait(timeout=10)
                if handle:
                    kernel.CloseHandle(handle)


if __name__ == "__main__":
    unittest.main()
