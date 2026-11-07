@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "FORGE_ROOT=%~dp0.."
set "FORGE_PYTHON=%FORGE_ROOT%\.forge-runtime\trellis2-venv\Scripts\python.exe"
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
set "PATH=%FORGE_ROOT%\.forge-runtime\trellis2-venv\Scripts;%CUDA_HOME%\bin;%PATH%"
set "TRITON_HOME=%FORGE_ROOT%\.forge-runtime\trellis2-cache"
set "FLEX_GEMM_AUTOTUNE_CACHE_PATH=%TRITON_HOME%\flex-gemm\autotune_cache.json"
set "FLEX_GEMM_AUTOSAVE_AUTOTUNE_CACHE=0"
set "ATTN_BACKEND=sdpa"
set "SPARSE_ATTN_BACKEND=sdpa"
set "PYTHONNOUSERSITE=1"
for %%T in (trellis_cumesh_test trellis_flexgemm_test trellis_ovoxel_test trellis_nvdiffrast_test trellis_opencv_test trellis_sparse_sdpa_test trellis_native_import_test) do (
    echo Running %%T...
    "%FORGE_PYTHON%" "%FORGE_ROOT%\test\%%T.py"
    if errorlevel 1 exit /b 1
)
echo Native component tests passed. Model inference was not tested.
