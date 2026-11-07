@echo off
setlocal
rem Build against the existing native Windows ARM64/CUDA toolchain, not WSL.
rem Paths and source revisions are recorded in docs\WINDOWS_ARM64.md.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "FORGE_ROOT=%~dp0.."
set "FORGE_PYTHON=%FORGE_ROOT%\.forge-runtime\trellis2-venv\Scripts\python.exe"
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
set "CUDA_PATH=%CUDA_HOME%"
rem PyTorch's default extension search can select x64 CUDA libraries on ARM64.
set "LIB=%CUDA_HOME%\lib\arm64;%LIB%"
set "PATH=%FORGE_ROOT%\.forge-runtime\trellis2-venv\Scripts;%CUDA_HOME%\bin;%PATH%"
set "TRITON_HOME=%FORGE_ROOT%\.forge-runtime\trellis2-cache"
set "FLEX_GEMM_AUTOTUNE_CACHE_PATH=%FORGE_ROOT%\.forge-runtime\trellis2-cache\flex-gemm\autotune_cache.json"
set "TORCH_CUDA_ARCH_LIST=12.1"
set "MAX_JOBS=2"
set "PYTHONNOUSERSITE=1"
set "DISTUTILS_USE_SDK=1"
set "MSSdk=1"
set "CL=%CL% /Zc:preprocessor"
set "FORGE_PACKAGE="
if /i "%~1"=="cumesh" set "FORGE_PACKAGE=%FORGE_ROOT%\.forge-runtime\trellis2-CuMesh"
if /i "%~1"=="flexgemm" set "FORGE_PACKAGE=%FORGE_ROOT%\.forge-runtime\trellis2-FlexGEMM"
if /i "%~1"=="voxel" set "FORGE_PACKAGE=%FORGE_ROOT%\.forge-runtime\trellis2-src\o-voxel"
if /i "%~1"=="raster" set "FORGE_PACKAGE=%FORGE_ROOT%\.forge-runtime\trellis2-nvdiffrast"
if not defined FORGE_PACKAGE (
    echo Usage: trellis-build-extension.cmd cumesh^|flexgemm^|voxel^|raster
    exit /b 2
)
"%FORGE_PYTHON%" -m pip install --no-build-isolation --no-deps --no-cache-dir "%FORGE_PACKAGE%"
exit /b %errorlevel%
