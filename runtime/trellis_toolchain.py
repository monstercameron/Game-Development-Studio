"""Configure the existing Windows ARM64 compiler for Triton's CUDA JIT."""

import os
import subprocess
from pathlib import Path

from app_log import get_logger

log = get_logger("three-d")

VCVARS = Path(
    r"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
)
CUDA = Path(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5")


def configure_toolchain():
    if os.name != "nt" or not VCVARS.is_file() or not (CUDA / "bin" / "nvcc.exe").is_file():
        log.warn("three-d.toolchain.check.failed", {"reason": "toolchain_unavailable"})
        raise RuntimeError("The Windows ARM64 compiler or CUDA toolkit is unavailable.")
    log.info("three-d.process.spawned", {"kind": "vcvars"})
    stop = log.time("three-d.process.exited", {"kind": "vcvars"})
    result = subprocess.run(
        f'cmd.exe /d /s /c ""{VCVARS}" arm64 >nul && set"',
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    stop({"exitCode": result.returncode})
    if result.returncode:
        log.warn(
            "three-d.toolchain.check.failed",
            {"reason": "vcvars_failed", "exitCode": result.returncode},
        )
        raise RuntimeError("Could not initialize the Windows ARM64 build tools.")
    # The command returns the whole environment, including secrets; copy only
    # compiler search paths and never write its captured output to logs.
    variables = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator and key.upper() in {"PATH", "INCLUDE", "LIB", "LIBPATH"}:
            variables[key.upper()] = value
    if not all(variables.get(key) for key in ("PATH", "INCLUDE", "LIB")):
        log.warn("three-d.toolchain.check.failed", {"reason": "paths_incomplete"})
        raise RuntimeError("Windows ARM64 compiler paths are incomplete.")
    os.environ.update(variables)
    os.environ["CUDA_HOME"] = str(CUDA)
    os.environ["CUDA_PATH"] = str(CUDA)
    os.environ["PATH"] = str(CUDA / "bin") + os.pathsep + os.environ["PATH"]
    os.environ["LIB"] = str(CUDA / "lib" / "arm64") + os.pathsep + os.environ["LIB"]
