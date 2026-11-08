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
- A native OpenCV 4.12.0 build uses a NEON baseline and only `core`, `imgproc`, `photo`, and Python bindings. It supports image preprocessing, not model inference. The available alternative ARM64 wheel required CPU features this computer did not expose.
- TRELLIS sparse attention supports segmented PyTorch SDPA on CUDA. The sparse implementation refuses CPU tensors. The DINOv3 adapter supports the installed Transformers 5 layer layout while retaining TRELLIS's unweighted final normalization.
- `runtime/trellis_backend.py` assembles the 512-resolution model from local, memory-mapped checkpoints, reconstructs the deterministic sparse-flow RoPE buffer absent from the checkpoint, uses the GPU for inference, and currently accepts transparent references. The DINO encoder has run on CUDA; a full textured GLB render has not yet been validated or calibrated. Keep this distinction when assessing readiness.

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
