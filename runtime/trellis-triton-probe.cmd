@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "TRITON_HOME=%~dp0..\.forge-runtime\trellis2-cache"
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
"%~dp0..\.forge-runtime\trellis2-venv\Scripts\python.exe" "%~dp0trellis-triton-probe.py"
exit /b %errorlevel%
