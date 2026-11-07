@echo off
setlocal
rem This builds CPU preprocessing helpers only; model inference remains on CUDA.
rem See docs\WINDOWS_ARM64.md before changing the machine-specific paths below.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "FORGE_ROOT=%~dp0.."
set "FORGE_RUNTIME=%FORGE_ROOT%\.forge-runtime"
set "FORGE_PYTHON=%FORGE_RUNTIME%\trellis2-venv\Scripts\python.exe"
set "FORGE_CMAKE=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "FORGE_NINJA=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"
set "FORGE_NUMPY=C:/Users/mreca/Desktop/Qwen Image Studio/.venv/Lib/site-packages/numpy/_core/include"
set "FORGE_BASE_PYTHON=C:/Users/mreca/AppData/Local/Programs/Python/Python312-arm64"
set "FORGE_PYTHON_CMAKE=%FORGE_PYTHON:\=/%"
if /i "%~1"=="configure" goto configure
if /i "%~1"=="build" goto build
if /i "%~1"=="install" goto install
echo Usage: trellis-build-opencv.cmd configure^|build^|install
exit /b 2
:configure
"%FORGE_CMAKE%" -G Ninja -S "%FORGE_RUNTIME%\trellis2-opencv-src" -B "%FORGE_RUNTIME%\trellis2-opencv-build" ^
  "-DCMAKE_MAKE_PROGRAM=%FORGE_NINJA%" -DCMAKE_BUILD_TYPE=Release ^
  "-DCMAKE_INSTALL_PREFIX=%FORGE_RUNTIME%\trellis2-opencv-install" ^
  -DOPENCV_PYTHON3_INSTALL_PATH=python -DPYTHON3_PACKAGES_PATH=python ^
  -DBUILD_LIST=core,imgproc,photo,python3 -DBUILD_SHARED_LIBS=OFF -DBUILD_opencv_python3=ON ^
  -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOCS=OFF -DBUILD_opencv_apps=OFF ^
  -DWITH_IPP=OFF -DWITH_OPENCL=OFF -DWITH_FFMPEG=OFF -DWITH_MSMF=OFF -DWITH_CUDA=OFF -DWITH_QUIRC=OFF ^
  -DCPU_BASELINE=NEON -DCPU_DISPATCH= ^
  "-DPYTHON3_EXECUTABLE=%FORGE_PYTHON_CMAKE%" "-DPYTHON3_INCLUDE_DIR=%FORGE_BASE_PYTHON%/include" ^
  "-DPYTHON3_LIBRARY=%FORGE_BASE_PYTHON%/libs/python312.lib" "-DPYTHON3_NUMPY_INCLUDE_DIRS=%FORGE_NUMPY%" ^
  "-DPYTHON3_LIBRARIES:INTERNAL=%FORGE_BASE_PYTHON%/libs/python312.lib" "-DPYTHON3_INCLUDE_PATH:INTERNAL=%FORGE_BASE_PYTHON%/include"
exit /b %errorlevel%
:build
"%FORGE_CMAKE%" --build "%FORGE_RUNTIME%\trellis2-opencv-build" --parallel 2
exit /b %errorlevel%
:install
"%FORGE_CMAKE%" --install "%FORGE_RUNTIME%\trellis2-opencv-build" --component python
exit /b %errorlevel%
