@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "FORGE_ROOT=%~dp0.."
set "TRITON_HOME=%FORGE_ROOT%\.forge-runtime\trellis2-cache"
set "FLEX_GEMM_AUTOTUNE_CACHE_PATH=%FORGE_ROOT%\.forge-runtime\trellis2-cache\flex-gemm\autotune_cache.json"
set "FLEX_GEMM_AUTOSAVE_AUTOTUNE_CACHE=0"
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
"%FORGE_ROOT%\.forge-runtime\trellis2-venv\Scripts\python.exe" "%FORGE_ROOT%\test\trellis_flexgemm_test.py"
exit /b %errorlevel%
