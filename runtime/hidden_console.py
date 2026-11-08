"""Give a console-less Windows engine process a hidden console.

Forge starts every engine detached so that it survives a studio restart. On
Windows a detached process has no console at all, and every console program
that such a process (or a library it imports) starts without CREATE_NO_WINDOW
is handed a brand-new visible console, which Windows Terminal turns into a
window. Allocating one console, hidden, as early as possible makes every
descendant inherit it and removes those windows without patching libraries.
"""

import os
import sys


def ensure_hidden_console():
    """Attach a hidden console when the process has none; return True if created."""
    if sys.platform != "win32" or os.environ.get("FORGE_ALLOW_CONSOLE_WINDOWS") == "1":
        return False
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32.GetConsoleWindow.restype = ctypes.c_void_p
        user32.ShowWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
        process_ids = (ctypes.c_uint * 1)()
        # A console (even a windowless one) is already attached: children inherit it.
        if kernel32.GetConsoleProcessList(process_ids, 1) != 0:
            return False
        if not kernel32.AllocConsole():
            return False
        window = kernel32.GetConsoleWindow()
        if window:
            user32.ShowWindow(window, 0)
        return True
    except Exception:
        return False


ensure_hidden_console()
