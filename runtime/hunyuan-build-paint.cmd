@echo off
setlocal
rem Builds the native pieces Hunyuan3D 2.1's texture stage needs on Windows ARM64.
rem Same toolchain as runtime\trellis-build-extension.cmd (VS 2022 Build Tools ARM64 + CUDA 13.5).
rem Targets: deps | rasterizer | inpaint | xatlas | simplify | all. Details: docs\WINDOWS_ARM64.md.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "FORGE_ROOT=%~dp0.."
set "VENV=%FORGE_ROOT%\.forge-runtime\hunyuan3d-venv"
set "FORGE_PYTHON=%VENV%\Scripts\python.exe"
set "BUILD=%FORGE_ROOT%\.forge-runtime\hunyuan3d-build"
set "PAINT=%FORGE_ROOT%\.forge-runtime\hunyuan3d-src\hy3dpaint"
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
set "CUDA_PATH=%CUDA_HOME%"
rem PyTorch's default extension search can select x64 CUDA libraries on ARM64.
set "LIB=%CUDA_HOME%\lib\arm64;%LIB%"
set "PATH=%VENV%\Scripts;%CUDA_HOME%\bin;%PATH%"
set "TORCH_CUDA_ARCH_LIST=12.1"
set "MAX_JOBS=2"
set "PYTHONNOUSERSITE=1"
set "DISTUTILS_USE_SDK=1"
set "MSSdk=1"
set "CL=%CL% /Zc:preprocessor"
if not exist "%BUILD%" mkdir "%BUILD%"
if /i "%~1"=="deps" goto deps
if /i "%~1"=="rasterizer" goto rasterizer
if /i "%~1"=="inpaint" goto inpaint
if /i "%~1"=="xatlas" goto xatlas
if /i "%~1"=="simplify" goto simplify
if /i "%~1"=="all" goto all
echo Usage: hunyuan-build-paint.cmd deps^|rasterizer^|inpaint^|xatlas^|simplify^|all
exit /b 2

:all
call "%~f0" deps || exit /b 1
call "%~f0" xatlas || exit /b 1
call "%~f0" simplify || exit /b 1
call "%~f0" inpaint || exit /b 1
call "%~f0" rasterizer || exit /b 1
exit /b 0

:deps
rem Build helpers and the pure-Python/binary-wheel packages the texture stage needs.
"%FORGE_PYTHON%" -m pip install --no-deps ninja pybind11 scipy==1.18.1
exit /b %errorlevel%

:rasterizer
rem Upstream ships a Windows variant of the kernel sources; build from a copy so the clone stays pristine.
if exist "%BUILD%\custom_rasterizer" rmdir /s /q "%BUILD%\custom_rasterizer"
xcopy /e /i /q "%PAINT%\custom_rasterizer" "%BUILD%\custom_rasterizer" >nul || exit /b 1
"%FORGE_PYTHON%" -m pip install ninja >nul || exit /b 1
rem Point setup.py at the Windows sources. Current PyTorch rejects data_ptr<uint64_t>() on the
rem int64 z-buffer tensor, so read it as int64_t (the kernel casts it back to uint64_t*).
"%FORGE_PYTHON%" -c "import pathlib;b=pathlib.Path(r'%BUILD%\custom_rasterizer');p=b/'setup.py';p.write_text(p.read_text().replace('lib/custom_rasterizer_kernel/','lib/custom_rasterizer_kernel_for_windows/'));c=b/'lib'/'custom_rasterizer_kernel_for_windows'/'rasterizer_gpu.cu';c.write_text(c.read_text().replace('z_min.data_ptr<uint64_t>()','z_min.data_ptr<int64_t>()'))" || exit /b 1
"%FORGE_PYTHON%" -m pip install --no-build-isolation --no-deps --no-cache-dir --force-reinstall "%BUILD%\custom_rasterizer"
exit /b %errorlevel%

:inpaint
"%FORGE_PYTHON%" -m pip install pybind11 >nul || exit /b 1
for /f "delims=" %%I in ('python -c "import pybind11;print(pybind11.get_include())"') do set "PYBIND_INCLUDE=%%I"
for /f "delims=" %%I in ('python -c "import sysconfig;print(sysconfig.get_paths()['include'])"') do set "PY_INCLUDE=%%I"
for /f "delims=" %%S in ('python -c "import sysconfig;print(sysconfig.get_config_var('EXT_SUFFIX'))"') do set "EXT_SUFFIX=%%S"
for /f "delims=" %%L in ('python -c "import sys,pathlib;print(pathlib.Path(sys.base_prefix)/'libs')"') do set "PYLIBS=%%L"
pushd "%PAINT%\DifferentiableRenderer"
cl /nologo /O2 /EHsc /std:c++17 /LD /I"%PYBIND_INCLUDE%" /I"%PY_INCLUDE%" mesh_inpaint_processor.cpp /Fe:mesh_inpaint_processor%EXT_SUFFIX% /link /LIBPATH:"%PYLIBS%"
set "RC=%errorlevel%"
popd
exit /b %RC%

:xatlas
"%FORGE_PYTHON%" -m pip install --no-deps --no-cache-dir xatlas==0.0.11
exit /b %errorlevel%

:simplify
"%FORGE_PYTHON%" -m pip install --no-deps --no-cache-dir fast-simplification==0.2.0
exit /b %errorlevel%
