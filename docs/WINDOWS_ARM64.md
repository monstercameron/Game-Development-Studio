# Windows ARM64 runtime and rebuild notes

This document records the installation observed on 2026-11-06. The existing setup is machine-specific, under `C:\Users\mreca\Desktop\Game Development Studio`, and is **not yet a one-command clean-machine installer**. Preserve the current runtime, model folders, and separate Desktop applications before rebuilding. Inference is intended to run on NVIDIA GPU; CPU work may still be used for file I/O and preprocessing.

## The service boundary

`server.js` supervises an HTTP host in a separate process. That host supervises a runtime process, which runs the durable SQLite queue and a GPU-monitor worker thread. Engine processes are isolated from the HTTP and queue processes; the main supervisor retains handles to services it started so an HTTP-host restart does not automatically relinquish ownership. Each engine has its own start, readiness, memory-admission, and safe-stop behavior. `runtime/README.md` maps the files.

The active model-load barrier and queue lease are persisted. A lost response can leave the outcome unknown, so recovery may require checking the worker and logs rather than resubmitting a render. `runtime/model-load.js` checks a single identifiable NVIDIA GPU and refuses an ambiguous multi-GPU reading. GPU and system-memory figures are snapshots, not reservations.

## Source checkouts and revisions

The checkouts below are in `.forge-runtime/` and ignored by Git in the studio repository. The commits were read from their local Git metadata. They do **not** include Forge's wrapper code in `runtime/`, and they do not describe every Python or CUDA package needed to reproduce the environment.

| Local checkout        | Upstream                                                                          | Commit                                     |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| `hunyuan3d-src`       | [Tencent-Hunyuan/Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1) | `82920d643c0dc2f7bfd7255f45f62d386edfe60c` |
| `hy-motion-src`       | [Tencent-Hunyuan/HY-Motion-1.0](https://github.com/Tencent-Hunyuan/HY-Motion-1.0) | `4e426f5a1021cbcf7f375458c37b840ee7225229` |
| `motionbricks-src`    | [NVlabs/motionbricks](https://github.com/NVlabs/motionbricks)                     | `54fc563aeaaf819a753d72cc9fdc6713989cdd43` |
| `sam3-src`            | [facebookresearch/sam3](https://github.com/facebookresearch/sam3)                 | `f1647e8d0c1d280991f4d1b7d974c2704537fe66` |
| `trellis2-src`        | [microsoft/TRELLIS.2](https://github.com/microsoft/TRELLIS.2)                     | `75fbf0183001ed9876c8dbb35de6b68552ee08bd` |
| `trellis2-CuMesh`     | [JeffreyXiang/CuMesh](https://github.com/JeffreyXiang/CuMesh)                     | `12289e1062f0603f2f0d0771b02e1395d247f26f` |
| `trellis2-FlexGEMM`   | [JeffreyXiang/FlexGEMM](https://github.com/JeffreyXiang/FlexGEMM)                 | `6dd94a859c26ee8246888502eada3dd8ad85532e` |
| `trellis2-nvdiffrast` | [NVlabs/nvdiffrast](https://github.com/NVlabs/nvdiffrast)                         | `253ac4fcea7de5f396371124af597e6cc957bfae` |
| `trellis2-opencv-src` | [opencv/opencv](https://github.com/opencv/opencv)                                 | `49486f61fb25722cbcf586b7f4320921d46fb38e` |
| `trellis2-utils3d`    | [EasternJournalist/utils3d](https://github.com/EasternJournalist/utils3d)         | `9a4eb15e4021b67b12c460c7057d642626897ec8` |

TRELLIS.2's `o-voxel/third_party/eigen` is a Git submodule at `21e4582d1739107337a03460c81412981130373e`. A replacement checkout needs the matching submodule as well as the matching parent commit. The modified TRELLIS.2, CuMesh, and FlexGEMM source diffs are saved as `runtime/trellis-patches/trellis2.patch`, `cumesh.patch`, and `flexgemm.patch`. They are already applied to this machine's checkout. Apply them only to a separate clean checkout at the recorded commit, after checking with `git apply --check`; do not apply them twice or discard local changes.

## Native TRELLIS.2 changes

Upstream TRELLIS.2 documents a Linux-oriented setup; this is an experimental native Windows ARM64 port, not upstream Windows support. The following work has been done:

- CUDA extensions for CuMesh, FlexGEMM, O-Voxel, and nvdiffrast were built and exercised with small GPU operations. The setup patches use MSVC-compatible C++20 flags, and O-Voxel has Windows-compatible numeric literals and explicit integer casts.
- `runtime/trellis-build-extension.cmd` selects the Visual Studio ARM64 environment, CUDA 13.5 ARM64 library directory and the RTX Spark `12.1` architecture. Two build jobs limit peak compile memory. Build logs are under `.forge-runtime/trellis2-build/`.
- The [Windows Triton distribution](https://github.com/triton-lang/triton-windows) is used for GPU kernels. A FlexGEMM autotune cache is placed under `.forge-runtime/trellis2-cache/`, rather than a user-home cache.
- CuMesh `fill_holes` fix (`runtime/trellis-patches/cumesh.patch`): CUB's `DeviceSegmentedReduce::Sum` value-initialised its `Vec3f` accumulator on the host, but `Vec3f`'s constructors were device-only, so the accumulator was uninitialised and every hole-filling vertex got a garbage z coordinate (about 1e16). O-Voxel's `to_glb` calls `fill_holes` first, so the BVH, dual-contouring remesh and baked GLB contained huge triangles that appeared as long black spikes or slabs. The patch marks the `Vec3f` constructors `__host__ __device__` and passes an explicit zero and add functor to `Reduce`. After applying it, rebuild with `cmd /c runtime	rellis-build-extension.cmd cumesh`; `test/trellis_cumesh_test.py` checks that a filled hole's new vertex lies at the loop centroid.
- A native OpenCV 4.12.0 build uses a NEON baseline and only `core`, `imgproc`, `photo`, and Python bindings. It supports image preprocessing, not model inference. The available alternative ARM64 wheel required CPU features this computer did not expose.
- TRELLIS sparse attention supports segmented PyTorch SDPA on CUDA. The sparse implementation refuses CPU tensors. The DINOv3 adapter supports the installed Transformers 5 layer layout while retaining TRELLIS's unweighted final normalization.
- `runtime/trellis_backend.py` assembles the 512-resolution model from local, memory-mapped checkpoints, reconstructs the deterministic sparse-flow RoPE buffer absent from the checkpoint, uses the GPU for inference, and currently accepts transparent references. The DINO encoder has run on CUDA; full textured GLB renders now complete (several through the studio queue on 2026-11-07, 100,000-triangle default); memory use is not calibrated, and only one object was tested. `decimation_target` is exposed as a triangle budget (default 100,000).

The `1024`, `1024_cascade` and `1536_cascade` pipelines (`runtime/trellis_backend.py`, `ensure_pipeline_models`) load the two extra 1024 flow checkpoints on first use and run the same native extensions at larger sparse grids. All four pipelines completed a render on this port on 2026-11-08 (one apple cutout: 512 in about 70 s, 1024 in 3 min 43 s, 1024 cascade in 4 min 15 s, 1536 cascade in 9 min 10 s; sampled GPU memory in use peaked at about 8, 20, 15 and 36 GB). One object is not a calibration, and free host RAM dipped below 2 GB during each render. If a higher pipeline fails natively, select 512 again; the worker reports the error through the job.

The current environment uses Python 3.12.10 ARM64, PyTorch `2.14.0+cu134`, Transformers 5.22.1, Triton 3.8.0, OpenCV 4.12.0, and `huggingface_hub` 2.4.0. Its `.pth` files deliberately refer to:

- `C:\Users\mreca\Desktop\Qwen Image Studio\.venv\Lib\site-packages` for the existing GPU-enabled PyTorch and packages;
- `.forge-runtime/trellis2-python-packages`, `.forge-runtime/trellis2-src`, and `.forge-runtime/trellis2-utils3d`;
- `.forge-runtime/trellis2-opencv-install/python` for the locally built OpenCV module.

Moving or removing Qwen Image Studio's environment breaks this setup. The build scripts also hard-code the installed Visual Studio 2022 Build Tools, CUDA Toolkit `v13.5`, Python 3.12 ARM64, and NumPy include paths. The scripts compile against the current `.forge-runtime` checkouts; they do not download sources, create a new virtual environment, or restore weights.

To rebuild **an existing prepared** environment after reviewing paths and patches, run from the studio directory:

```powershell
cmd /c runtime\trellis-build-opencv.cmd configure
cmd /c runtime\trellis-build-opencv.cmd build
cmd /c runtime\trellis-build-opencv.cmd install
cmd /c runtime\trellis-build-extension.cmd cumesh
cmd /c runtime\trellis-build-extension.cmd flexgemm
cmd /c runtime\trellis-build-extension.cmd voxel
cmd /c runtime\trellis-build-extension.cmd raster
cmd /c runtime\trellis-native-tests.cmd
```

The component suite verifies CUDA operations and native imports without loading model weights. The separate `test/trellis_dinov3_cuda_test.py` and `test/trellis_pipeline_load_test.py` load real checkpoints and check available memory; do not run them while other work is using memory needed by the test. Neither test generates a complete 3D asset. Download the matching model files using [Model sources and restoration](MODEL_SOURCES.md).

## Drama 3 native CUDA build

Drama 3 uses the community [audio.cpp](https://github.com/0xShug0/audio.cpp) engine, pinned for the verified build to commit `0382d37fe6e1a817b6b8fed5dcaab0e11fd1e8e6`. Its normal Windows build instructions target x64; the build below was tested on native Windows ARM64 with Visual Studio 2022 Build Tools (MSVC 14.44 ARM64), LLVM/clang-cl 23.1.5 ARM64, CUDA 13.5, CMake 4.4, Ninja and an RTX Spark N1X. Install those tools separately; use versions and paths matching your installation. The GGUF model is a separate download and its license and source are documented in the model source guide.

From the Forge repository root, clone audio.cpp and check out the pinned commit:

```bat
git clone https://github.com/0xShug0/audio.cpp.git ".forge-runtime\drama3-audiocpp-src"
git -C ".forge-runtime\drama3-audiocpp-src" checkout 0382d37fe6e1a817b6b8fed5dcaab0e11fd1e8e6
```

In its `external/sentencepiece/CMakeLists.txt`, at the pinned revision, wrap the existing `string(APPEND CMAKE_CXX_FLAGS " -fmacro-prefix-map=...")` line with `if(NOT MSVC)` and `endif()`. This narrowly removes an unquoted debug-path mapping that clang-cl splits at spaces in a Windows project path; it does not change inference. Reassess the patch on an upstream update.

From the repository root, save the following as a local `.cmd` file and run it. These paths are examples from the tested installation, not portable defaults. The CUDA host compiler must be the native ARM64 `cl.exe`; the C and C++ compiler must be native ARM64 `clang-cl` for the bundled ggml build.

```bat
@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" arm64
if errorlevel 1 exit /b 1
set "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.5"
set "PATH=C:\Program Files\LLVM\bin;%CUDA_PATH%\bin;C:\Program Files\CMake\bin;%PATH%"
cmake -S ".forge-runtime\drama3-audiocpp-src" -B ".forge-runtime\drama3-audiocpp-clang-build" -G Ninja -DCMAKE_MAKE_PROGRAM="C:\Strawberry\c\bin\ninja.exe" -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl -DCMAKE_CUDA_HOST_COMPILER="C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostarm64\arm64\cl.exe" -DCMAKE_BUILD_TYPE=Release -DENGINE_ENABLE_CUDA=ON -DENGINE_ENABLE_NATIVE_CPU=OFF -DENGINE_ENABLE_LLAMAFILE=OFF -DENGINE_ENABLE_OPENMP=OFF -DAUDIOCPP_MODEL_SET=custom -DAUDIOCPP_MODELS=fish_drama3 -DAUDIOCPP_DEPLOYMENT_BUILD=ON -DCMAKE_CUDA_ARCHITECTURES=121 -DCMAKE_CUDA_FLAGS=--allow-unsupported-compiler
if errorlevel 1 exit /b 1
cmake --build ".forge-runtime\drama3-audiocpp-clang-build" --target audiocpp_cli --parallel 3
if errorlevel 1 exit /b 1
if not exist "engines\drama3\bin" mkdir "engines\drama3\bin"
copy ".forge-runtime\drama3-audiocpp-clang-build\bin\audiocpp_cli.exe" "engines\drama3\bin\audiocpp_cli.exe"
cl /nologo /EHsc /std:c++17 /W4 /WX /O2 /MT "runtime\drama3-win-launcher.cpp" /Fo".forge-runtime\drama3-win-launcher.obj" /Fe"engines\drama3\bin\forge-drama3-launcher.exe"
```

The tested engine imports `cublas64_13.dll`, `cublasLt64_13.dll`, `libomp140.aarch64.dll` and the ARM64 Visual C++ runtime. The CUDA DLLs came from the CUDA toolkit's `bin\arm64`; the OpenMP DLL came from the locally installed Visual Studio Build Tools `VC\Redist\MSVC\14.44.35112\debug_nonredist\arm64\Microsoft.VC143.OpenMP.LLVM`. This Build Tools file is a local dependency, not a redistributable bundled with Forge. The runner discovers the dependencies and passes their locations to the child process. Other installations must provide compatible ARM64 libraries and respect their distribution terms.

The launcher creates the engine suspended, assigns a kill-on-close Windows job and sets a 2 GiB hard pageable working-set limit before resuming. This bounds the process working set, not GPU allocations, pinned memory or total Windows commit; memory admission and monitoring remain necessary. The verified settings use CUDA, a 2,048-token context, disk-backed experts with an eight-slot cache, no pinned experts, no CPU expert layers, and zero retained prefill graph caches. An isolated actual queue render produced a 4.23-second WAV and persisted its asset provenance and completed status. This establishes a working short sample on the tested machine, not performance or memory guarantees for other prompts or machines.

## Other Windows adaptations

- **Hunyuan3D shape:** `runtime/hunyuan_backend.py` uses memory-mapped checkpoint loading, `accelerate` empty-weight initialization, and a Pillow RGBA preprocessing adapter because the available OpenCV wheel could not run on the CPU. Pillow preprocessing has not been shown pixel-identical to upstream. Shape-only inference produced one GLB.
- **Hunyuan3D texture (optional, experimental):** `runtime/hunyuan_paint_backend.py` runs upstream `hy3dpaint` (multiview PBR diffusion, `MeshRender`, view baking) in the same worker. It replaces upstream's Blender GLB export with a trimesh writer, MeshLab simplification with `fast-simplification` plus `trimesh`, and basicsr/realesrgan with a small Real-ESRGAN x4plus loader, and uses the studio's native NEON OpenCV build from `.forge-runtime/trellis2-opencv-install` because the OpenCV wheel aborts at import. `runtime/hunyuan-build-paint.cmd all` (or `deps`, `xatlas`, `simplify`, `inpaint`, `rasterizer`) installs `scipy`, `ninja`, `pybind11`, builds `xatlas` and `fast-simplification` from source, compiles upstream's `mesh_inpaint_processor.cpp` into `hy3dpaint/DifferentiableRenderer/`, and builds the `custom_rasterizer` CUDA extension for `sm_121` from a copy of upstream's Windows kernel sources with one patch (`z_min.data_ptr<int64_t>()`; current PyTorch rejects the `uint64_t` accessor on its int64 tensor). Build logs go to `.forge-runtime/hunyuan3d-build/`. The texture weights are listed in [Model sources and restoration](MODEL_SOURCES.md). One 128-resolution plus 2048-texture job completed through Forge's queue in 142 seconds; see the studio guide for what that did and did not verify.
- **HY-Motion:** `runtime/hymotion_backend.py` loads checkpoint tensors with memory mapping, points its text encoders at the local Qwen3-8B and CLIP folders, and converts output to BVH in `runtime/hymotion_bvh.py`. A standalone test produced a skeletal clip; a real queued run previously encountered insufficient host memory.
- **SAM 3.1:** `runtime/sam31_backend.py` builds the upstream detector, selects detector weights from the multiplex checkpoint, restores derived RoPE buffers, and runs text-prompted still-image segmentation. The separate Python 3.14/NumPy 2 environment is outside upstream's declared NumPy range. A single real queued example was tested; it does not establish general segmentation quality.
- **MotionBricks:** `runtime/motionbricks_backend.py` assembles NVIDIA's SOMA PyTorch graph from the released checkpoints and forces CUDA instead of falling back to CPU. A SOMA BVH transition was tested, without endpoint correction or retargeting. G1 and the separate ONNX paths are not connected.
- **Nemotron ASR:** the native Windows ARM64 CUDA binary is NVIDIA's NeMo-Speech.cpp 0.3.0 release, guarded by `runtime/asr_guard.py`. Its model-file and release provenance are in the model guide. The server loads at start, so Forge starts it on demand after memory admission rather than restarting it automatically without a fresh check.
- **Qwen3-TTS:** its isolated environment currently shares CUDA libraries from `C:\Users\mreca\Desktop\Snapdargon-DJ\.runtime`; it is not self-contained. The integrated preset-voice path returns completed WAV files.
- **H3 video and Mammoth:** Forge bridges the existing external applications. H3 uses Vulkan through its own stable-diffusion.cpp executable; its actual VAE paths are in [Model sources and restoration](MODEL_SOURCES.md). Managed H3 and ASR guards use Windows process jobs to contain child processes; a separately launched external service is not owned by Forge.

## How engines are launched on Windows (no console windows)

Forge starts every model engine detached (`runtime/engines.js`) so it keeps running, and stays recoverable, when the studio host restarts. A non-detached child would be placed in a job object that is closed with the host. Windows gives a detached process no console at all, so any console program it starts without `CREATE_NO_WINDOW` (`nvidia-smi`, `cmd`, `ffmpeg`, a compiler, `os.system`) gets a new console, which Windows Terminal shows as a window. `windowsHide` does not help: it only applies to the process Forge itself creates. A venv's `Scripts\python.exe` is also only a redirector that starts the base interpreter in a new console.

`runtime/engine-launch.js` therefore decides each launch, including automatic restarts:

- A venv `python.exe` is replaced by the base interpreter named in that venv's own `pyvenv.cfg`, started with the same `__PYVENV_LAUNCHER__` hint the redirector would set, so `sys.prefix` and site-packages are identical. Ownership records, recovery and force stop still use the venv launcher path, which they already accept alongside the base interpreter.
- Forge's Python workers import `runtime/engine_identity.py`, which imports `runtime/hidden_console.py`. It allocates one hidden console when the process has none, and every descendant inherits it. `h3_guard.py` and `world_worker.py` import it directly.
- Engines whose entry point is not in this repository (YuE2 music, Stable Audio) run as `python -u runtime/console_launch.py [-m module | script] args`, which creates the hidden console and then runs the original module or script unchanged.

To debug an engine in a visible console, set `FORGE_ALLOW_CONSOLE_WINDOWS=1` in its environment. If a console window still appears, run `Get-CimInstance Win32_Process` and look at the parent of the new `cmd.exe`, `conhost.exe` or `powershell.exe`; it may belong to another application. Native engines (`llama-server.exe`, `nemo-speech.exe`) do not start console children.

These notes describe the observed installation. They do not replace a tested installation manifest for every dependency or establish that a new machine can reproduce the environment without additional setup.

## Known intermittent video crash (exit 3221226505, 0xC0000409)

**Symptom.** A default-setting H3 video render (56 frames, 8 steps) ended with `Generation failed (engine exit 3221226505)` at step 7 of 8. Two of six renders failed this way on 2026-11-08 (jobs started 08:29:56 and 08:32:50 local time, UTC-5), and the same requests and seeds completed later. 3221226505 is `0xC0000409`. Forge now shows "The video engine crashed (0xC0000409), often under memory pressure. Retry; if it repeats, offload other models and lower max GPU memory/size." and offers a manual **Retry** that submits a fresh attempt. Forge never retries by itself.

**Where the evidence lives.** H3 Studio writes no per-job log file. Its `server.js` keeps only the last 12,000 characters of `sd-cli` output in memory (`GET /api/status`, `job.details`), and loses them when H3 restarts. `.forge-runtime/engine-video.log` holds only the guard start lines. The evidence below comes from the Windows event logs, which a normal user can read:

```powershell
# Low virtual memory (commit limit) diagnoses, with the largest consumers
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Resource-Exhaustion-Detector'} | Select-Object TimeCreated, Message
# sd-cli crashes recorded by Windows Error Reporting
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'} | Where-Object Message -match 'sd-cli'
# Commit limit and use right now
Get-CimInstance Win32_OperatingSystem | Select-Object TotalVirtualMemorySize, FreeVirtualMemory
```

**What the logs show.**

- The machine has 30.4 GiB of RAM and a fixed 96 GiB page file, so the Windows commit limit is 126.4 GiB.
- At 08:32:24, as the first failed render ended, Windows logged event 2004 (low virtual memory). A `node.exe` (PID 25092, not a Forge engine, already gone) had committed 118.5 GiB; `sd-cli.exe` held only 3.5 GiB. Five seconds later the same node process was at 53.7 GiB.
- At 08:34:59, as the second render ended, event 2004 again listed a node process at 23.8 GiB and `sd-cli.exe` at 3.1 GiB. At 08:34:58 the WMI service (`svchost.exe_winmgmt`) crashed with exception 0x0000000E (`ERROR_OUTOFMEMORY`), and Service Control Manager logged that the Windows Error Reporting service timed out (event 7009). That is also why neither render left a Windows Error Reporting report.
- The only `sd-cli.exe` crash that Windows did record is from 2026-11-05 23:46:42: fault module `ucrtbase.dll` offset `0x15e27c`, exception `0xC0000409`, exception data `7`. Data 7 is `FAST_FAIL_FATAL_APP_EXIT`, which is what the C runtime raises for `abort()` and an uncaught C++ exception. It is not a stack-buffer-overrun check (that would be data 2).

**Hypotheses, most likely first.**

1. _Commit exhaustion in another process makes an `sd-cli` allocation fail, and `sd-cli` aborts._ Supported by the timing (each failure ends within seconds of an event 2004, and other Windows components failed for lack of memory in the same minutes) and by the abort signature above. The decode and encode after step 8 allocate large host buffers, which fits a failure at step 7 or 8. Unproven: no dump was captured, and the large node process was not identified.
2. _A Vulkan allocation failure inside `sd-cli`_ (the engine is `engine/vulkan/sd-cli.exe`) that the C++ code does not handle. It would also abort with this status. Not excluded; GPU memory use was not logged at the time.
3. _A real defect in `sd-cli` or `ucrtbase` that only some seeds or timings reach._ Unlikely for the same seed to pass later, but not excluded.

**Ruled out.** A GPU driver reset (no `nvlddmkm` or `dxgkrnl` events between 08:20 and 08:45, and none at 08:29 to 08:36). A crash of the H3 server or the guard (the same guard PID and server PID served every job). A deterministic bug for those seeds (they completed later). A wrong exit code from Forge (`3221226505` is exactly the value `sd-cli` returned to H3's server).

**Capturing a dump next time.** Windows keeps full dumps only if told to. From an elevated PowerShell:

```powershell
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\sd-cli.exe'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name DumpFolder -Value 'C:\ForgeDumps' -PropertyType ExpandString -Force | Out-Null
New-ItemProperty -Path $key -Name DumpType -Value 2 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $key -Name DumpCount -Value 3 -PropertyType DWord -Force | Out-Null
```

(`DumpType 2` is a full dump of up to the process size, about 4 GiB each; create the folder first and remove the key afterwards.) Without elevation, Sysinternals ProcDump works as the same user: `procdump -accepteula -ma -e 1 -w sd-cli.exe C:\ForgeDumps`. To log the pressure itself, run `typeperf "\Memory\Committed Bytes" "\Memory\Commit Limit" -si 5 -o C:\ForgeDumps\commit.csv` during renders. A dump whose exception data is 7 and whose stack contains `std::terminate` or `ggml_abort` confirms hypothesis 1 or 2; the allocation size on the stack separates them.

**What Forge does about it.** It names the cause in the failure text and keeps Retry manual. It does not reduce the commit use of other programs. Close other large programs (test runs and model tools that commit tens of GiB) during renders, and keep the GPU memory budget at its default unless a render needs more.
