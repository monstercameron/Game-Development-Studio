"""Configure the existing Windows ARM64 compiler for Triton's CUDA JIT."""
import os
from pathlib import Path
import subprocess

VCVARS = Path(r'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat')
CUDA = Path(r'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5')


def configure_toolchain():
    if os.name != 'nt' or not VCVARS.is_file() or not (CUDA / 'bin' / 'nvcc.exe').is_file():
        raise RuntimeError('The Windows ARM64 compiler or CUDA toolkit is unavailable.')
    result = subprocess.run(f'cmd.exe /d /s /c ""{VCVARS}" arm64 >nul && set"',
                            capture_output=True, text=True, check=False, timeout=30, errors='replace',
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError('Could not initialize the Windows ARM64 build tools.')
    # The command returns the whole environment, including secrets; copy only
    # compiler search paths and never write its captured output to logs.
    variables={}
    for line in result.stdout.splitlines():
        key, separator, value=line.partition('=')
        if separator and key.upper() in {'PATH','INCLUDE','LIB','LIBPATH'}:
            variables[key.upper()]=value
    if not all(variables.get(key) for key in ('PATH','INCLUDE','LIB')):
        raise RuntimeError('Windows ARM64 compiler paths are incomplete.')
    os.environ.update(variables)
    os.environ['CUDA_HOME']=str(CUDA)
    os.environ['CUDA_PATH']=str(CUDA)
    os.environ['PATH']=str(CUDA / 'bin')+os.pathsep+os.environ['PATH']
    os.environ['LIB']=str(CUDA / 'lib' / 'arm64')+os.pathsep+os.environ['LIB']
