@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "PROBE_DIR=%~dp0..\.forge-runtime\trellis2-build"
if not exist "%PROBE_DIR%" mkdir "%PROBE_DIR%"
"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5\bin\nvcc.exe" -arch=sm_121 -o "%PROBE_DIR%\cuda-probe.exe" "%~dp0trellis-native-probe.cu"
if errorlevel 1 exit /b 1
"%PROBE_DIR%\cuda-probe.exe"
exit /b %errorlevel%
