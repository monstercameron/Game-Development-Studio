# Agent setup and handoff

This guide is an entry point for an agent working on Forge. The current installation was assembled on Windows ARM64 with an NVIDIA RTX Spark N1X. Paths and model status can drift; inspect the machine rather than assuming this particular setup is present. A fresh source checkout can run the web application after JavaScript dependencies are installed, but **cannot reproduce the local inference stack by itself**.

## 1. Orient without disturbing running work

From the repository root, inspect `git status`, this guide, and [the runtime map](../runtime/README.md). Open `http://127.0.0.1:5173` if the studio is already running. The loopback endpoints `/api/diagnostics`, `/api/runtime/health`, `/api/runtime/services`, and `/api/runtime/jobs` expose useful status. They are snapshots: a reachable engine is not proof that its model is loaded or can render. The **Diagnostics** page exposes logs and server metadata; logs may include prompts and local paths, so review before sharing.

Use the existing server when possible. Inspect active jobs and owned services before any restart or offload, and preserve unrelated workloads. Model loads can consume both Windows commit memory and GPU memory; those are separate measurements. Do not read credentials into terminal output. Do not switch to CPU inference or WSL to work around a missing CUDA setup.

## 2. Install and run the application

For the Windows installer, model download options, source links, and remaining per-engine setup, start with the [installation guide](INSTALLATION.md). `install.ps1 -CheckOnly` inspects selected prerequisites without changing the installation; `-ListModels` lists the model sources.

Node.js 24 and a package manager are required. The observed development environment used Node 24.22.1 and pnpm 11.25.0. From the project root on Windows:

```powershell
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1
```

The default address is `http://127.0.0.1:5173`. To stop this studio, use `stop-server.ps1` with the same `-Port` argument, after checking active work. The start script checks the port and existing process identity. `npm start` runs the unified supervisor in the foreground; `npm run dev` starts the Vite development host. Rebuild after UI edits when using the unified server. `pnpm install --frozen-lockfile` and `pnpm run build` are alternatives; keep both lockfiles consistent when dependencies change. The pnpm workspace explicitly permits esbuild's install script.

`node_modules/`, `dist/`, `projects/`, `models/`, `.forge-runtime/`, native llama binaries, credentials, and caches are local state and are excluded from Git. The shell launchers are provided for other platforms, but the local GPU integrations described here are Windows-specific and are not automatically portable.

## 3. Understand the inference dependencies

Engine definitions and default ports are in [`runtime/engines.js`](../runtime/engines.js). Many engines rely on independently installed applications on the user's Desktop, not just this repository. Their Python environments, supporting repositories, checkpoints and licenses are documented in [model sources](MODEL_SOURCES.md) and [Windows ARM64 notes](WINDOWS_ARM64.md). Do not delete or overwrite those installations to make a test pass. Request or use existing authorized model access without putting tokens in command lines or logs.

- **WorldGen:** the Windows `Desktop/WorldGen/.venv`, local WorldGen and DA-2 dependencies, cached FLUX components, panorama LoRAs, and optional Q5 transformer files in `models/worldgen` are required. The Q5 sources and names are listed in the [studio guide](STUDIO_GUIDE.md#world-studio). The Q5 checkpoints inherit the FLUX.1 dev non-commercial license. Without them the adapter uses the existing full-precision path, which can demand substantially more Windows memory.
- **HY-World:** `Desktop/HY-World-2.0/.venv` and the `compat-port` WorldMirror weights support multi-view and panorama reconstruction. The current integration does not expose the other HY-World pipelines (HY-Pano text-to-panorama, WorldStereo).
- **Chat:** `engines/llama-cuda/bin/llama-server.exe` and the Qwen GGUF at the path in `runtime/engines.js` are local dependencies, not Git content. The installed runtime is the official llama.cpp `b12180` Windows ARM64 CUDA 13.5 release. The two archives, their official source link and recorded SHA-256 hashes are in the [chat section of the studio guide](STUDIO_GUIDE.md#chat-and-qwen38). Download and verify both release archives before extracting their contents into `engines/llama-cuda/bin/`; preserve any existing installation and check that it is not running before replacing files.

These are installation records, not evidence that a model is currently working. Check license terms, gated access, disk space and the selected GPU before downloading or loading weights. Record new versions, sources, hashes and compatibility patches in the model and platform guides.

## 4. Validate the right layer

```powershell
node --test test/world-queue.test.js test/world-mcp.test.js test/nav-queue-status.test.js
node node_modules/vite/bin/vite.js build
```

For the complete JavaScript suite and native checks, see [test/README.md](../test/README.md). World adapter unit checks use the already installed environments:

```powershell
& "$env:USERPROFILE\Desktop\WorldGen\.venv\Scripts\python.exe" -m unittest discover -s test -p world_lora_test.py -v
& "$env:USERPROFILE\Desktop\WorldGen\.venv\Scripts\python.exe" -m unittest discover -s test -p world_perspective_test.py -v
& "$env:USERPROFILE\Desktop\WorldGen\.venv\Scripts\python.exe" -m unittest discover -s test -p world_options_test.py -v
& "$env:USERPROFILE\Desktop\WorldGen\.venv\Scripts\python.exe" -m unittest discover -s test -p world_views_test.py -v
& "$env:USERPROFILE\Desktop\HY-World-2.0\.venv\Scripts\python.exe" -m unittest discover -s test -p world_memory_test.py -v
```

Use temporary projects and substitute services for protocol tests. A real GPU test should use a clearly identified project and inputs, check the queue and memory first, inspect the resulting asset in the studio, and report visible defects. Mock-worker tests and successful builds do not establish output quality. The world worker reports model loading, panorama generation, 3D reconstruction, and saving stages; check Diagnostics when a render fails. Preserve partial or interrupted job evidence rather than blindly retrying an uncertain submission.
