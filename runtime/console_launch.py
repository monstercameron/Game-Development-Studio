"""Run a Python module or script under a hidden Windows console.

Engines that Forge does not own (their entry points live in other folders) are
started as ``python -u console_launch.py [-m module | script.py] args...`` so the
hidden console from hidden_console.py exists before the engine starts anything.
"""

import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hidden_console  # noqa: E402,F401  (allocates the console on import)

# The engine must not see Forge's runtime folder on its import path.
sys.path[:] = [entry for entry in sys.path if os.path.abspath(entry or ".") != HERE]


def main(argv):
    if not argv:
        raise SystemExit("usage: console_launch.py [-m module | script.py] [args...]")
    if argv[0] == "-m":
        if len(argv) < 2:
            raise SystemExit("console_launch.py: -m needs a module name")
        module, rest = argv[1], argv[2:]
        if not sys.flags.safe_path:
            sys.path.insert(0, os.getcwd())
        sys.argv = [module, *rest]
        runpy.run_module(module, run_name="__main__", alter_sys=True)
        return
    script, rest = os.path.abspath(argv[0]), argv[1:]
    if not sys.flags.safe_path:
        sys.path.insert(0, os.path.dirname(script))
    sys.argv = [script, *rest]
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main(sys.argv[1:])
