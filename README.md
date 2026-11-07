# Forge — Game Development Studio

**A local workspace for creating and organizing game assets.**

### World studio

Choose **Worlds** in the sidebar and select a project. WorldGen accepts a text description, one image, or a 360° panorama and exports a Gaussian splat or mesh as PLY. HY-World 2.0 reconstructs a Gaussian-splat PLY from 1–8 views of the same scene. Choose reference images from disk or the asset library, then add the render to the shared durable queue. Completed worlds appear in the project's 3D assets and in the World studio preview, where they can be downloaded, rated, or moved to trash.

Both integrations use the existing Windows ARM64 environments on the Desktop and require NVIDIA CUDA. The render process exits after each job to release GPU memory. HY-World weights and WorldGen's supporting models remain in their existing desktop environments and Hugging Face cache. WorldGen can also use smaller Q5 transformers in `models/worldgen`; the rest of each FLUX pipeline must still be cached. Forge does not download missing model files during a render. Gaussian PLY files use an interactive Gaussian-splat preview, with a point-cloud fallback if the viewer cannot load. GPU memory requirements vary by mode and are not yet calibrated.

The world worker exposes its status and job progress through Forge, its logs appear in Diagnostics, and the MCP tool `forge_queue_world` accepts staged references. CUDA queue tests completed WorldGen text-to-splat, image-to-splat and panorama-to-splat/mesh, and an HY-World four-image reconstruction. An image-to-world test exposed a perspective projection defect in the Windows port; Forge now supplies perspective rays so that the reference is preserved. A render guard stops the active world process if Windows commit memory becomes critically low. These scenes are useful starting points, not guaranteed game-ready geometry: seams, holes and distortion can remain as the viewpoint moves.

The text transformer is [`city96/FLUX.1-dev-gguf`, `flux1-dev-Q5_0.gguf`](https://huggingface.co/city96/FLUX.1-dev-gguf); the image-fill transformer is [`second-state/FLUX.1-Fill-dev-GGUF`, `flux1-fill-dev-Q5_0.gguf`](https://huggingface.co/second-state/FLUX.1-Fill-dev-GGUF). Both inherit the FLUX.1 dev non-commercial license. Place them in `models/worldgen` with those filenames. Forge loads each Q5 transformer when present and retains the original full-precision path if it is absent. WorldGen's local panorama LoRAs and depth model are still required. `FORGE_WORLDGEN_FULL_PRECISION=1` selects the original full-precision path for troubleshooting.

Forge keeps projects, asset creation, and local engine status in one studio. Image, music, sound-effect, video, preset-voice, and untextured Hunyuan shape renders are connected to local engines. Other creation panels and most model controls are previews that help explore planned workflows.

> **Current stage: early integration.** Projects, asset browsing, diagnostics, live GPU memory, the Mammoth decision bridge, and a durable render queue are available. Image, music, sound-effect, video, preset-voice, Hunyuan shape, and SAM still-image segmentation have been verified through Forge in isolated test services and projects. HY-Motion is experimental: a short real queued text-to-motion render has succeeded on CUDA. The video file was produced and saved; its visual quality has not been assessed. Forge can start connected engine services without loading their models and stop supported idle services it owns. Project asset ratings, keep status, rename, reversible trash, managed model removal, and live speech transcription are connected. TRELLIS.2 is an experimental queue workflow; a complete model render remains unverified.

[Quick start](#quick-start) · [What works today](#what-works-today) · [Using the studio](#using-the-studio) · [Models and services](#models-and-services) · [Diagnostics](#diagnostics-and-logs) · [Troubleshooting](#troubleshooting) · [Roadmap](#roadmap)

For installation, model source links, staged downloads, and Windows engine prerequisites, see the [installation guide](docs/INSTALLATION.md). Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly` to inspect prerequisites or `-ListModels` to list model sources without downloading anything.

For maintainers: [agent setup](docs/AGENT_SETUP.md), [model sources and download steps](docs/MODEL_SOURCES.md), [Windows ARM64 runtime and rebuild notes](docs/WINDOWS_ARM64.md), [runtime map](runtime/README.md), and [test guide](test/README.md).

## Quick start

### Windows

Open PowerShell and run:

```powershell
cd 'C:\Users\mreca\Desktop\Game Development Studio'

# Run after installing or updating the app.
npm install
npm run build

# Start the studio in the background.
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1
```

Open **[http://127.0.0.1:5173](http://127.0.0.1:5173)**. Starting the studio does not start or load model engines. Open **Models & services** and choose **Start connected services** to start the connected engine services; this does not load their models.

To stop it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-server.ps1
```

If port 5173 is already in use, choose a different port and use the same port to stop the server:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start-server.ps1 -Port 5199
powershell -NoProfile -ExecutionPolicy Bypass -File .\stop-server.ps1 -Port 5199
```

The launcher prints the address and log location. It checks for an existing studio server and refuses to take over a port occupied by another service. Node.js 24 and npm must be available; the scripts also require the project dependencies installed in `node_modules` and a current build in `dist`. The runtime uses Node's built-in SQLite support.

For foreground use, run `npm start` and stop it with **Ctrl+C**. Run `npm run build` after changing the React UI. `npm run dev` remains available for development with hot reload. The unified local service is intended for use on this computer and binds to `127.0.0.1`.

### TRELLIS.2 native Windows development

TRELLIS.2 has an experimental isolated rendering service and queue integration. Its CuMesh, FlexGEMM, O-Voxel and nvdiffrast extensions have been built for Windows ARM64 and tested with CUDA. The studio also has a native OpenCV build for image preprocessing and a GPU-only sparse attention implementation. These component tests do not establish that a complete 3D render works.

The isolated environment under `.forge-runtime/trellis2-venv` currently references the PyTorch installation in `C:\Users\mreca\Desktop\Qwen Image Studio\.venv`. It also depends on the installed Visual Studio 2022 ARM64 build tools and CUDA 13.5. Moving or removing those dependencies requires rebuilding or reconfiguring the environment. Run the component checks with:

```powershell
cmd /c runtime\trellis-native-tests.cmd
```

To download and verify the public, pinned image-to-3D checkpoints under `models/`, run `& .\.forge-runtime\trellis2-venv\Scripts\python.exe .\runtime\trellis-download.py`. The approved DINOv3 dependency can be downloaded with `node .\runtime\trellis-dinov3-download.js`, which reads the shared Hugging Face token and passes it to the downloader without putting it on the command line. The scripts resume Hugging Face downloads and will not overwrite an existing file that fails verification. The model inventory measures the main TRELLIS.2 folder, its supporting decoder, and DINOv3, but removal through Forge is unavailable for these preview files until their lifecycle can be managed safely.

The experimental offline 512 pipeline loads the verified files using memory-mapped weights; a real test loaded the pipeline and ran DINOv3 feature extraction on CUDA. The queue, HTTP, MCP, and UI are connected and tested with a substitute renderer. A full TRELLIS.2 render has not yet been verified and its memory budget is not calibrated. Queue preparation requires at least 12 GiB of free system memory, and rendering checks an estimated 24 GiB of free GPU memory plus Forge's reserve. These are conservative estimates, not reservations. The separate background-removal model still requires approved access. The experimental backend therefore requires a transparent PNG or WebP image, which can be prepared using the segmentation panel. On Windows, a replacement supervisor can recover a verified Forge-started TRELLIS.2 worker after its owner crashes; other engine ownership is not yet recovered this way. An unverifiable prior launch is left unresolved instead of automatically starting a duplicate.

### macOS and Linux

Shell launchers are included for environments with Node.js, npm, and `curl`:

```sh
npm install
npm run build
chmod +x start-server.sh stop-server.sh
./start-server.sh
./stop-server.sh
```

Pass a port as the first argument to both scripts if needed, for example `./start-server.sh 5199`. These scripts have been syntax checked but have not been verified end to end on macOS or Linux. Windows-specific features such as keep-awake are not portable as currently implemented.

## What works today

| Capability | Current state |
| --- | --- |
| Studio navigation | Available. Browse the panels and use your browser's Back and Forward buttons to revisit them. |
| Projects | Available. Create a project and its folders on disk; switch projects from the interface. |
| Asset library | Available for sample assets and supported files found in project folders. Search, filter, sort, preview, download, and copy paths. |
| Diagnostics | Available. Inspect local server metadata and stream available logs. |
| Keep computer awake | Available on Windows while the studio server is running. |
| Notifications | Permission, preferences, and a test notification are available. The open studio page observes real render completion and can notify you. |
| Render queue | Durable sequential image, music, sound-effects, video, voice, Hunyuan shape, SAM segmentation, HY-Motion, and MotionBricks jobs save results to the project. Forge starts workers on demand and checks available memory before loading or rendering. Stable Audio requires Hugging Face model access. |
| Game decisions | Mammoth-1 requests can be sent from the game-logic panel, HTTP API, or MCP. A real request through Forge has been verified. Forge can also start its own guarded Mammoth worker after a GPU memory check. |
| Other creation panels | Preview only. Saved items are browser drafts, not render jobs. |
| Model management | The studio reports GPU memory, managed model file sizes, and observed engine status. It can start services, load models after a memory check, stop supported idle services, and permanently remove stopped Forge-managed model folders. Some models remain in their original applications. |
| Asset ratings, keep, and delete | Project ratings and keep status are saved in the project. Deletion moves a file to project trash; restore it from the asset library or confirm clearing the trash to permanently remove it. Rename preserves ratings and the link to render history. Sample ratings are browser-local. |
| Render and queue estimates | The header shows current render and queue timing on every page. Creation panels show render time, queue wait, and the combined estimate. Exact matches use completed jobs; nearby settings can provide a clearly labeled rough estimate. Unknown preparation, memory waits, and interrupted jobs are not presented as definite finish times. |

## Using the studio

### 1. Create a project

From the overview, choose **New project** and give your game a name. Forge creates a folder under `projects/`, including folders for the asset types currently supported by the project service:

```text
projects/
└── Your Game/
    ├── .forge-project.json
    ├── images/
    ├── video/
    ├── music/
    ├── sfx/
    ├── voices/
    └── masks/
```

The server sanitizes folder names and handles naming collisions. Existing generated files can be placed in the appropriate project folder manually; supported files are discovered for the library. The queue adapters save completed output into the selected project's matching asset folder.

### 2. Explore the creation panels

Choose a panel from the sidebar, select the current project, and experiment with its controls. Draft settings and the draft queue are saved in the browser. In **Images**, **Music**, **Sound effects**, **Video**, **Voices**, **3D models**, **Character rigging**, and **Segmentation**, **Add to render queue** creates a durable job; **Save as a draft instead** keeps an editable browser draft. Video needs 1–9 reference images (up to 10 MiB each and 40 MiB total). They are saved in the project when the video is queued; select them again after refreshing the page. Image renders can use up to 10 optional reference images; they have the same 10 MiB per-file and 40 MiB total limits as video. Music requires a style and lyrics; use `[Instrumental]` for an instrumental. Forge starts the workers on demand and requests the YuE2 model after checking GPU memory. If memory is short, the job waits and the studio shows the offload dialog. Stable Audio requires gated model access. For a worker started by Forge, it can use a Hugging Face token from the configured shared credentials file; an external worker can use its own configured token, or you can enter one in **Models & services**. Forge reads the token only for its own managed sound worker, passes it locally to that worker for Hugging Face access, and does not write it into the queue, MCP calls, or Forge logs. The worker keeps it in memory while running. TRELLIS.2 can queue an experimental 512-resolution model from a transparent PNG or WebP; a real complete render remains unverified. HY-Motion can queue experimental text-to-motion jobs, and MotionBricks can queue experimental SOMA pose transitions from BVH files. The game-logic panel can send a structured decision to a running Mammoth service.

If a render or model load runs short of system RAM or GPU memory, the memory dialog shows the requirement, current free memory, and available services. Select an idle Forge-managed service and choose **Stop selected service & retry**; Forge checks it can stop safely and keeps its model files. Repeat if more room is needed. Externally started services must be managed in their own application. Qwen chat has no safe idle-stop guard; use its separate Force stop control only when you accept interrupting a response. These readings are estimates, and stopping a GPU model may not free enough Windows system RAM.

Render timing starts when the engine accepts a job and ends when the asset is saved. Model startup and preparation before acceptance are not included. The queue forecast adds known remaining render times in order, reports unknown timing when a job is preparing or blocked, and shows known render work separately when a full forecast is not possible. Nearby estimates are scaled from completed renders with similar settings and marked **rough**. Without suitable history the studio says so instead of inventing a time. The game-decision and audio-file transcription panels keep their own timing samples locally in the browser; microphone sessions have no fixed end time.

Render jobs run sequentially and are stored in `.forge-runtime/jobs.sqlite`. If a job has a known remote ID when the runtime restarts, it resumes monitoring that job. For Forge's Hunyuan3D, SAM, HY-Motion, MotionBricks, and Qwen3-TTS workers, completed files are atomically committed and can be recovered after a worker restart without loading the model or resubmitting the render. Incomplete output is not treated as complete; if the old job cannot be identified, the queue stops for review. Custom external services are not automatically started unless explicitly configured for auto-start. A failed job can be retried; when an engine job ID is known, Forge rechecks that existing job rather than submitting another render. If a crash makes submission uncertain, the queue stops on an **interrupted** item rather than automatically submitting a duplicate. H3 exposes only its current job; if it no longer recognizes an accepted job, Forge stops for review even if a similarly named output exists, since the file could be incomplete. Check the relevant engine's own queue, history, and rendering process before resolving it in Forge. Queued or waiting items can be cancelled; cancelling an already running job is not yet supported from Forge. Keep `.forge-runtime/` if you need the queue history as well as `projects/` if you need the output files. The existing engines also retain their own original outputs; Forge copies the selected asset into the project.

Image and video reference files are snapshotted under the project’s hidden `.forge-inputs` directory and retained for recovery and retries. Other reference-file controls are previews; they retain the selected file’s name and size, not the file contents.

### 3. Browse your assets

Open **Asset library** to explore included samples or files discovered in a project. Select a project, then search or filter by type, change the sort order, or switch between grid and list views. Supported media can be previewed or played, and assets can be downloaded. Project asset details also provide a file location you can copy.

Currently indexed formats are PNG, JPG/JPEG, WebP, GIF, WAV, MP3, FLAC, OGG, MP4, WebM, GLB, glTF, FBX, and BVH. Some 3D formats require an external viewer.

Project asset ratings and keep status are stored with the project; sample ratings are browser-local. Delete moves a project file to **Project trash** in the asset library, where it can be restored or permanently removed by clearing the trash after confirmation. Incomplete or unsafe trash records are preserved and reported for review. Asset rename keeps the file in the same project folder, retains its extension, and preserves ratings and render provenance. For a renamed generated asset, the jobs API reports its current `output` path and includes `originalOutput` with the original render location.

### 4. Check settings and server health

Use the settings control to request browser notification permission, send a test notification, and control the Windows keep-awake feature. Open **Diagnostics** for server details, log filtering, pausing, and copying logs for troubleshooting.

## Models and services

These are the workflows represented in the interface. **Listing a model here does not mean it is installed, running, or integrated.** Availability, licensing, hardware requirements, and Windows on Arm support need to be verified for each integration.

| Studio area | Models or services represented | Intended use |
| --- | --- | --- |
| Images | Qwen Image 2.1 | Image and concept creation |
| 3D models | TRELLIS.2, Hunyuan3D 2.1 | Hunyuan untextured shape generation works; TRELLIS.2 and texturing remain previews |
| Character rigging & motion | HY-Motion 1.0, NVIDIA MotionBricks | Experimental HY-Motion text-to-BVH and MotionBricks SOMA BVH transitions; automatic rigging and retargeting are not connected |
| Video | MiniMax H3 | Video generation |
| Music | YuE2 | Music creation |
| Sound effects | Stable Audio 3 | Sound generation |
| Voices | Qwen3-TTS, NVIDIA Nemotron ASR Streaming | Preset-voice speech generation plus local streaming transcription API |
| Segmentation | SAM 3.1 | Image segmentation |
| Game logic | Mammoth-1 | A Jev-style decision service |

The central storage location is `models/` inside the studio folder. TRELLIS.2 and its supporting encoder and decoder, Qwen3-TTS CustomVoice, Nemotron ASR, Hunyuan shape, HY-Motion, MotionBricks, and SAM checkpoints are stored there. The model-management page measures managed model file sizes asynchronously, without following links. The total also includes the separate SAM 3 checkpoint. File sizes are estimates of content, not guaranteed reclaimed disk space. Other existing model files remain in their original applications. See [model sources and restoration](docs/MODEL_SOURCES.md) for exact repositories, recorded revisions, representative hashes, and download steps.

To reclaim storage, open **Models & services**, choose a supported managed model and review its removal dialog. Stop its Forge-managed service first if needed, then select **Permanently delete model**. This removes the model folder, not project assets; reinstall the model to use it again. Forge refuses removal if the service is running or starting, a custom endpoint is configured, the model folder contains links, or its location cannot be verified. It stages the folder and journals cleanup so an interrupted removal can resume without deleting a replacement model. Models in other applications, TRELLIS.2's preview files, and the separate SAM 3 checkpoint are not removed by this control. An external or unverified service must be stopped separately.

The existing local applications are `Qwen Image Studio`, `Snapdargon-DJ`, `Stable Audio Lab`, `H3 Studio`, and `Mammoth Studio` on the Desktop. Forge reads their available status APIs and has initial image, music, sound-effects, video, voice, and Mammoth adapters. **Start connected services** launches eight engine services without loading their models; an existing service is left alone. Unexpected exits from services started by the current runtime are retried up to three times, without automatic model loading.

If YuE2 is running, its model can also be loaded from **Models & services**. Forge first checks free GPU memory against the existing CUDA pipeline's 24 GiB budget plus a 2 GiB reserve. For the first Qwen Image render, Forge checks a conservative, uncalibrated 48 GiB working budget plus a 2 GiB reserve. One isolated 512×512, 12-step run sampled a peak of 34,900 MiB across all GPU processes; other settings and workloads can use more. Stable Audio uses an uncalibrated 20 GiB working budget plus a 2 GiB reserve. Qwen3-TTS uses an uncalibrated 12 GiB working budget plus a 2 GiB reserve. For video, Forge checks the H3 engine’s configured 6 GiB VRAM limit plus a 2 GiB reserve immediately before submission. If memory is short, a dialog lists known loaded models. It can stop a supported, idle image, music, sound, or voice service started by the current Forge supervisor when you select it; stopping the service frees its model memory and leaves its model files on disk. Externally started services and other engine types must currently be managed in their own applications. The Forge-managed image worker blocks new requests and checks both active and queued work before stopping; externally started image services are never stopped. The memory check is a snapshot, not a reservation against other processes. Manual and queue-triggered YuE2, Stable Audio, and Qwen3-TTS loads pause later renders until the worker reports that loading finished or failed; the barrier survives cancellation and runtime restarts. If a crash leaves it stuck, use **Clear after checking** only after verifying the named engine is neither loading nor queued to load.

Memory admission currently supports a single identifiable NVIDIA GPU; the separately reported NPU is excluded. If multiple GPUs are present or the target GPU's free memory cannot be verified, Forge refuses the load rather than using a different device's reading. Per-engine GPU UUID mapping for multi-GPU systems is not yet implemented. When memory is short, the dialog also identifies busy services such as an active video render, which must finish before they can be stopped.

The image panel can override output width, height, and sampling steps. Dimensions must be multiples of 32. An optional negative prompt enables classifier-free guidance above 1; this increases render time, and real negative-prompt inference has not yet been verified in Forge. Leave the negative prompt blank for Qwen's default unguided mode. The video panel offers H3's supported 8, 12, 20, and 30 sampling steps; its current service fixes resolution by aspect and does not expose a seed. Image and video settings are retained in queue jobs and reruns, and estimates match the selected settings.

Music fine-tuning exposes duration, synthesis steps, guidance, negative style, and title. Sound effects accept custom duration and generation steps; preset voices expose the speech token limit. Hunyuan shape generation exposes denoising steps and mesh resolution. These settings are saved with queued jobs and retained for reruns. Their newly exposed options have been checked through request and worker-protocol tests; new GPU renders were not run for every combination.

Qwen3-TTS currently uses the 1.7B CustomVoice model with nine preset speakers and optional voice direction. It returns a completed WAV, not a live stream; voice cloning and voice design require other models and are not connected. Its isolated Python environment currently shares CUDA libraries from the existing `Snapdargon-DJ/.runtime` installation, which must remain available.

SAM 3.1 is connected for text-prompted still-image segmentation. Choose one PNG, JPEG, or WebP image, describe the object, select a transparent cutout or mask, and adjust confidence. Results are saved under the project's `masks/` folder. The SAM 3.1 checkpoint and the separate SAM 3 checkpoint were verified against their upstream SHA-256 hashes. A real Windows ARM64 test loaded SAM 3.1, isolated a truck in Meta's example image, and saved a transparent PNG through the MCP and durable queue; its background alpha was verified. That single sample does not establish general output quality. Forge starts the isolated worker on demand, checks 9 GiB free system memory and an estimated 12 GiB GPU budget plus 2 GiB reserve before loading, then checks additional working memory before a render. These budgets are conservative estimates, not reservations. A busy Forge-managed SAM worker cannot be offloaded. The Python 3.14/NumPy 2 environment is outside SAM's declared NumPy range and remains experimental. Point and box prompts and video tracking are not connected.

HY-Motion 1.0 is an experimental text-to-human-motion workflow that exports a 30 fps BVH skeleton to the project's `motion/` folder. Its checkpoint and Qwen3-8B and CLIP text encoders are stored under `models/HY-Motion/` and were verified against upstream file hashes. One real standalone Windows ARM64 test produced a 45-frame clip using eight sampling steps; motion quality has not been assessed. The worker, HTTP interface, queue, and MCP adapter have automated tests with a substitute model. An isolated real queue attempt stopped safely when available system memory fell below the encoder-loading threshold, so a complete real queued render remains unverified. Loading requires at least 9 GiB free system memory and an estimated 26 GiB GPU budget plus 2 GiB reserve; rendering checks additional memory. These estimates are not reservations. Automatic rigging and retargeting are not connected.

MotionBricks is an experimental SOMA transition workflow. Its SOMA checkpoints and the SOMA and G1 ONNX models are stored under `models/MotionBricks/` and verified against NVIDIA's published hashes. The isolated worker uses NVIDIA's original SOMA PyTorch graph on CUDA, with CPU inference disabled. A real isolated Forge queue test produced a SOMA BVH clip on CUDA from NVIDIA's evaluation-only sample poses; visual quality has not been assessed. The worker can be started and safely offloaded by the studio, and provides an experimental loopback HTTP endpoint for BVH transitions. Loading checks 7 GiB free system memory and 8 GiB GPU memory, and rendering checks 4 GiB system and 3 GiB GPU memory. These budgets are estimates, not reservations. The BVH workflow is connected to the render queue, UI, HTTP and MCP, with a GPU-memory offload dialog. It does not perform the official engine's endpoint correction or retarget characters. G1 CUDA inference remains unconnected. The original sample-motion license restricts those samples to evaluation and testing. Earlier TensorRT-RTX tests failed with CUDA error 716 inside its packed model weights; DirectML required CPU fallback, so neither path is enabled.

For local integration testing outside the queue, start the engines from Forge and use the MotionBricks worker at `http://127.0.0.1:8287`. `POST /api/model/load` with `{"rig":"soma"}` starts an asynchronous model load; poll `GET /api/status` for `loaded: true`. Then `POST /api/generate-bvh` with JSON containing `bvh` (the source BVH text), `context_frame` and `target_frame` (zero-based frame indices at 30 fps), and optional `min_tokens` and `max_tokens` (6–16). Each selected window needs four frames. The SOMA BVH must be Y-up in centimeters, contain the 30 named SOMA joints, and use 30, 60, or 120 fps; input is limited to 10 MiB. Poll `GET /api/jobs/{id}` and retrieve the finished clip from `GET /api/jobs/{id}/output`. This direct worker API does not participate in Forge's durable queue or its model-load offload dialog; the worker's own memory checks still apply.

Hunyuan3D 2.1's shape and VAE checkpoint files have been downloaded to `models/Hunyuan3D-2.1/` and verified against their upstream SHA-256 checksums. An experimental, isolated Windows ARM64 shape backend uses memory-mapped loading and produced a 38,848-vertex untextured GLB from the upstream example image at 30 steps and 128 resolution. Its Pillow preprocessing fallback is not pixel-identical to OpenCV and has not been assessed for output quality; an available ARM64 OpenCV wheel required CPU features this machine did not expose. The backend shares CUDA libraries from `Qwen Image Studio/.venv`. It is connected to the studio queue, UI, HTTP API, and MCP. Forge checks available host and GPU memory before loading and checks additional working memory before rendering. Resolution 128 has been tested; 256 and 384 are experimental. The texture model has not been installed or tested. The experimental TRELLIS.2 integration uses a native Windows port; upstream documents Linux support.

The NVIDIA Nemotron Speech Streaming 0.6B English model is stored under `models/nemotron-speech-streaming-en-0.6b/`; its NVIDIA NeMo-Speech.cpp 0.3.0 Windows ARM64 runtime is under `.forge-runtime/nemo-speech-0.3.0/`. Both were verified against upstream SHA-256 checksums. Start it from **Models & services** or `POST /api/runtime/models/asr/load`. Starting this native server loads its model, so Forge first reserves the render queue and checks an uncalibrated 4 GiB budget plus a 2 GiB reserve. The queue remains paused until the expected streaming model reports ready; an uncertain startup retains the barrier for review. The service is not automatically restarted after a crash because a restart would need a fresh GPU check. Forge-managed ASR runs behind a local guard that refuses offload while HTTP or WebSocket clients are connected; an idle service can be selected in the GPU-memory dialog. On Windows, the guard owns the CUDA engine through a kill-on-close job to prevent an orphaned model process after a guard crash. Externally started speech services are not controlled by Forge.

On Windows, H3 services started by Forge run behind a guard that owns both the H3 server and its renderer in a kill-on-close job. If the guard or H3 server crashes, its renderer is stopped and the supervisor can restart the service without automatically resubmitting the old render. Overlapping video uploads are checked again immediately before launching a renderer. The guard uses the existing H3 files without editing them and refuses to start if the expected H3 server code changes. A separately started H3 service is not modified or managed by Forge. The guard, restart, and crash cleanup have been tested with a substitute renderer; the real H3 server has been smoke-tested behind the guard without running a video render.

Mammoth can be started from the game-logic panel, `POST /api/runtime/models/game/load`, or the `forge_load_game_model` MCP tool. The managed worker imports the existing Mammoth Studio app without its automatic download or model load, checks for CUDA and llama.cpp GPU offload, and loads only after Forge checks an estimated 24 GiB GPU budget plus a 2 GiB reserve and 6 GiB of free system memory. These are uncalibrated estimates, not reservations. A persistent queue barrier protects uncertain loads; a managed worker refuses to stop while loading or handling decisions, including work left running after an HTTP cancellation. An independently started Mammoth service is left untouched. The guard has been tested with the real application unloaded and with simulated loads and decisions; a full managed GPU model load has not yet been verified. The existing external Mammoth decision bridge has been verified separately. After a failed managed load, offload the idle worker and retry with a fresh process. If a crash leaves a barrier stuck, check the worker and logs before explicitly clearing it.

The **Voices** page offers live microphone transcription with partial and final English text, plus local audio-file transcription (up to two minutes and 25 MiB). It requests microphone access only when you start recording, releases the microphone on stop, cancellation, error, or navigation, and can copy the finished text, place it in the voice-generation field, or save it as a project text asset. The speech service starts after the GPU memory check; if the GPU is short of memory, Forge offers its offload dialog. Microphone audio is sent only to the local speech service. Transcripts stay in the browser until you choose to save or copy them. Saved transcripts, chat responses, and decision JSON appear under the project’s `text/` folder and can be previewed, rated, renamed, downloaded, or moved to trash in the asset library.

Use `POST /api/runtime/asr/transcribe` with `{"projectId":"...","path":"voices/line.wav"}` to transcribe a project WAV up to 32 MiB. MCP exposes `forge_load_asr_model` and `forge_transcribe_project_audio`. Realtime clients connect to `ws://127.0.0.1:5173/api/asr/realtime` and use NVIDIA's PCM16 WebSocket protocol: await `session.created`, send `session.update`, send binary PCM16 frames, and send `input_audio_buffer.commit` to receive a final transcript. The proxy only accepts local requests and same-origin browser connections.

Each creation panel shows matching recent assets from the selected project. Keep and rating are saved with the project. Trash can be undone immediately or restored later through **Project trash** in the asset library. Rerun and refinement require the matching completed job to be present in the latest 200 queue entries. Images can also be added as references for another image render.

Engine workers run as separate processes. The main Forge supervisor retains their process handles when the HTTP host or runtime restarts, so it can keep managing its own workers after those failures. The HTTP and runtime supervisors retry failed process starts with backoff, including operating-system spawn failures that do not emit an exit event. A fatal HTTP configuration error stops retries so the startup issue can be fixed. If the main supervisor itself stops or restarts, surviving engines are treated as externally managed until restarted through Forge; it will not claim ownership or stop them automatically. Stopping the studio does not stop those engine processes.

## Notifications and keep-awake

Browser notifications require permission and an open studio page. You can test permission and adjust preferences in settings. Job and queue completion can be observed while the page is open; completions that occur while it is closed are not replayed as notifications.

On Windows, keep-awake uses the local studio server to prevent **idle system sleep** while enabled. The display can still turn off, and manual sleep or shutdown is unaffected. The keep-awake process is cleaned up when the server stops.

## Diagnostics and logs

The **Diagnostics** panel is the quickest place to gather information for an agent or a developer. It shows the studio server's address, port, process ID, project directory, Node version, and start time, along with available engine log sources and port checks.

Port reachability only means that something is listening on that port; it does not prove the expected engine is healthy or that a model is ready. Some existing engine logs are available when their files exist. A dedicated Qwen log source has not yet been configured.

Use the panel to filter or pause the stream and copy relevant output. The server captures studio logs and browser errors as well as selected local engine logs. Runtime worker output and worker restart events are appended to `.forge-runtime/runtime-worker.log`, which is available in Diagnostics, `GET /api/logs?source=runtime-worker`, and the `forge_logs` MCP tool. The log writer limits its in-memory buffer and records when output is dropped because storage is slow; it falls back to the process console if the log file cannot be opened. The raw file is not redacted. Known secret patterns are redacted on a best-effort basis in the API and UI, but logs can still contain prompts and other private information; review them before sharing.

For local inspection, the server exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/diagnostics` | Server metadata and known service reachability |
| `GET /api/logs` | Recent log snapshot; accepts an optional `source` query parameter |
| `GET /api/logs/stream` | Live log stream using server-sent events |
| `GET /api/projects` | Project and indexed asset listing |
| `GET /api/projects/:id/asset?path=...` | A project asset by its URL-encoded relative path |
| `POST /api/projects/:id/assets/metadata` | Update an asset’s keep status or rating |
| `POST /api/projects/:id/assets/trash` | Move an asset to the project’s recoverable trash |
| `GET /api/projects/:id/assets/trash` | List recoverable trash items and warnings |
| `POST /api/projects/:id/assets/restore` | Restore a trashed asset without overwriting an existing file |
| `POST /api/projects/:id/assets/clear-trash` | Permanently remove valid trash items with explicit confirmation |
| `GET /api/power` | Current keep-awake state |
| `GET /api/runtime/health` | Supervised runtime process status |
| `GET /api/runtime/hardware` | NVIDIA GPU memory snapshot and project volume free space when available |
| `GET /api/runtime/services` | Observed engine status and planned services |
| `GET /api/runtime/jobs` | Durable render jobs |
| `GET /api/runtime/jobs/:id` | One render job |
| `POST /api/projects/:id/references` | Stage a raw PNG, JPEG, or WebP image or video reference in the project |
| `POST /api/projects/:id/references/from-asset` | Snapshot a project image asset as an image or video reference |
| `POST /api/projects/:id/assets/rename` | Rename an indexed project asset in place, retaining its extension and metadata |
| `POST /api/runtime/jobs` | Queue an image, music, sound-effects, video, voice, Hunyuan shape, SAM segmentation, HY-Motion, or MotionBricks job |
| `POST /api/runtime/game/decide` | Send a structured decision to Mammoth-1 |
| `POST /api/runtime/models/game/load` | Start and request a managed Mammoth model load after checking memory |
| `POST /api/runtime/models/game/clear-load-barrier` | Clear a stuck Mammoth load barrier after confirming it is not loading |
| `POST /api/runtime/estimate` | Estimate a render using completed jobs with matching settings |
| `POST /api/runtime/models/music/load` | Check GPU memory and request YuE2 model loading in the running service |
| `POST /api/runtime/models/music/clear-load-barrier` | Clear a stuck model-load barrier after explicit confirmation that YuE2 is not loading or queued to load |
| `POST /api/runtime/models/sfx/load` | Check GPU memory and request Stable Audio loading; the optional token is never stored in the queue |
| `POST /api/runtime/models/sfx/clear-load-barrier` | Clear a stuck Stable Audio load barrier only after explicit confirmation that it is not loading |
| `POST /api/runtime/models/segmentation/load` | Check GPU and host memory and load the running SAM worker |
| `POST /api/runtime/models/segmentation/clear-load-barrier` | Clear a stuck SAM barrier after verifying it is not loading |
| `POST /api/runtime/models/3d-hunyuan/load` | Check GPU and host memory and load the running Hunyuan shape worker |
| `POST /api/runtime/models/3d-hunyuan/clear-load-barrier` | Clear a stuck Hunyuan barrier after verifying it is not loading |
| `POST /api/runtime/models/motion-hy/load` | Check GPU and host memory and load the HY-Motion worker |
| `POST /api/runtime/models/motion-hy/clear-load-barrier` | Clear a stuck HY-Motion barrier after verifying it is not loading |
| `POST /api/runtime/models/asr/load` | Check GPU memory and start Nemotron ASR with its model |
| `POST /api/runtime/models/asr/clear-load-barrier` | Clear a stuck ASR load barrier after explicitly checking the worker is not loading |
| `GET /api/runtime/model-storage` | Report the scan state, paths and measured sizes of Forge-managed model folders |
| `POST /api/runtime/models/:id/remove` | Permanently remove a supported, stopped Forge-managed model; requires `{"confirmation":"permanently-delete-model"}`. Set `retry: true` to retry a failed staged cleanup. |
| `POST /api/runtime/asr/transcribe` | Transcribe a WAV asset within a selected project |
| `POST /api/projects/:id/assets/create-text` | Save a transcript, chat reply, or structured decision in the project |
| `WS /api/asr/realtime` | Live PCM16 transcription with partial and final results |
| `POST /api/runtime/models/tts/load` | Check GPU memory and request Qwen3-TTS model loading |
| `POST /api/runtime/models/tts/clear-load-barrier` | Clear a stuck speech-model barrier after checking it is not loading |
| `POST /api/runtime/engines/start-all` | Start connected engine services without loading models; ASR remains on demand |
| `POST /api/runtime/models/:id/offload` | Stop a supported, idle service owned by the current runtime (`images`, `music`, `sfx`, `tts`, `3d-hunyuan`, `segmentation`, `motion-hy`, `motion-bricks`, `asr`, or `game`) |
| `POST /api/runtime/jobs/:id/cancel` | Cancel a job that has not been submitted |
| `POST /api/runtime/jobs/:id/retry` | Retry a failed job, reusing its engine job when known |
| `POST /api/runtime/jobs/:id/resolve` | Resolve an interrupted job after checking the remote engine |

For example, in PowerShell:

```powershell
Invoke-RestMethod 'http://127.0.0.1:5173/api/diagnostics'
curl.exe -N 'http://127.0.0.1:5173/api/logs/stream'
```

These endpoints support the local preview. They are not a production authentication or remote-access system; do not expose the development server to an untrusted network.

### Use assets as inputs

In image, video, 3D, segmentation, MotionBricks and speech-to-text workflows, choose **Choose from asset library** to browse supported files from any project. The picker filters by accepted formats and size; selecting a file does not start a render. Image and BVH inputs are copied into the destination project's queued input snapshots when the render is submitted. Audio transcription supports files that the browser can decode, up to two minutes and 25 MiB. MotionBricks requires a SOMA BVH skeleton; the file extension alone does not establish skeleton compatibility. Select reference files again after refreshing the page.

### API keys

Open **Studio settings → API keys** to save, replace, or remove OpenAI and Hugging Face keys. The studio encrypts each key with Windows Data Protection API (DPAPI) under the current Windows user before storing it in `.forge-runtime/credentials/keys.sqlite`. Saved values are never returned to the browser. The encrypted database alone cannot be unlocked from a different Windows account or computer; a Windows profile or recovery-key change may also make it inaccessible. Other processes running as your Windows user can potentially use that user's credentials.

OpenAI chat uses a temporary key entered in its connection panel first, then the saved key, then `OPENAI_API_KEY`. Forge-managed Stable Audio uses a temporarily supplied Hugging Face token first, then the saved token, then the existing Desktop shared Markdown credential lookup. External sound services keep their own credentials. Saving a key is explicit; existing Markdown files and environment variables are not imported or removed. Removing a saved key removes it from the database; a configured environment variable or shared Markdown token may still be used as a fallback. Store backups with the associated Windows profile and protect them appropriately.

### Navigation and shareable URLs

Each studio panel has its own path, such as `/images`, `/3d`, `/assets`, or `/models`. The selected project and relevant view options use URL parameters: asset collection, filters and preview; model catalog filters and file details; diagnostic source and error filter; chat conversation; and the 3D or motion model. Browser Back, Forward and refresh restore these views, as well as studio settings, project creation, asset inspection and actions, queue and trash confirmation panels, and the main configuration menus. Live GPU-memory conflict alerts depend on current runtime state and are not restored from a link. Older panel links using a hash redirect to their new path. Project and conversation links refer to data on this computer and are only useful where that data is available. Prompts, model credentials and uploaded files are not placed in the URL.

### Model catalog API

`GET http://127.0.0.1:5173/api/models` returns the shared model catalog, including each model's purpose, inputs, outputs, engine, related MCP tools, and the latest available service and storage observations. The catalog also identifies supporting checkpoints. A reachable service does not by itself mean its model is loaded; unknown observations are reported as such. If the runtime is unavailable, the static catalog remains available with `runtimeAvailable: false`.

```powershell
Invoke-RestMethod 'http://127.0.0.1:5173/api/models'
```

### MCP for agents

The same service exposes Streamable HTTP MCP at **`http://127.0.0.1:5173/mcp`**. Point an MCP client that supports the **2026-07-28 MCP protocol** and Streamable HTTP at that address. Older protocol handshakes are rejected for both HTTP and stdio; upgrade older clients. It is local-only, checks browser origins, and is not intended to be exposed to an untrusted network.

For clients that require stdio, start Forge and configure the included bridge using Node and the absolute path to `runtime/mcp.js`. For example:

```json
{
  "mcpServers": {
    "forge": {
      "command": "node",
      "args": ["C:\\Users\\mreca\\Desktop\\Game Development Studio\\runtime\\mcp.js"],
      "env": { "FORGE_STUDIO_URL": "http://127.0.0.1:5173" }
    }
  }
}
```

The read-only `forge_models` tool exposes the same model catalog as the HTTP API. The bridge also exposes service, GPU, runtime, project, diagnostic, log, and job reads; project creation; supported render submissions including MotionBricks; asset ratings, keep status, rename and trash; managed model inventory and removal; model loading and offloading; project WAV transcription; Mammoth decisions; and queue controls. `forge_create_project` returns the project ID used by the render tools. `forge_update_asset` accepts a project-relative asset path and a rating, keep status, or both; set the rating to `null` to clear it. It only connects to a local HTTP studio origin. Render requests and logs can contain private content.

## Files and persistence

### Automatic model management

The render queue starts its supported engine and loads the model when a job needs it. Models can stay loaded for reuse. If a job does not have enough reported GPU memory, Forge tries to make room by stopping one verified idle, Forge-managed engine at a time, then checks memory again before continuing. It favors keeping models needed by the next queued jobs. The queue shows what it is doing; model files remain on disk.

Automatic stopping is limited to guarded image, voice, 3D, segmentation, and motion workers, whose stop operation atomically rejects active work. Forge never automatically stops externally managed services, realtime speech recognition, or the game-logic service. YuE2 and Stable Audio can still be started on demand, but their current companion services lack the guarded stop needed for automatic offloading; the memory dialog offers manual choices if they are blocking a render. Memory readings are snapshots, and a render can still require attention if memory is unavailable or an engine cannot safely stop. System-memory admission checks remain separate.

If a Forge-started service stops responding, open **Models & services** and choose **Force stop…** for that service. After confirmation, Forge verifies its recorded Windows process identity and terminates its verified process tree. An affected render is marked **interrupted** and blocks the queue until you review and resolve it; any active work may be lost. Saved assets and model files remain on disk, and GPU/system memory readings can take a moment to update. The control is unavailable when ownership cannot be verified or the service was started outside Forge. If a model-load barrier still needs review, inspect the engine and use the existing barrier control before continuing.

### Converting image and audio assets

Open a project asset in the library, or use **Convert** beside a recent creation. Choose a format and select **Convert & save copy**. The original stays untouched; each copy gets a unique name in the same project folder and can be downloaded from the result or asset library. Images can be saved as PNG, lossless WebP, JPEG, BMP, or TGA. Audio can be saved as 24-bit WAV, FLAC, MP3, Ogg Vorbis, or Ogg Opus. Forge creates a thumbnail preview for TGA files. JPEG and BMP fill transparency with the selected background color. Opus is resampled to 48 kHz when its input rate is unsupported.

JPEG encoding attempts NVIDIA GPU acceleration with nvJPEG through the installed CUDA-enabled torchvision, then falls back to the CPU if unavailable. The result reports the encoder actually used. Other formats use CPU codecs. Conversion is separate from the render queue.

On this installation conversion uses the existing `Snapdargon-DJ/.runtime/python.exe` with Pillow, soundfile/libsndfile, NumPy, and optionally CUDA PyTorch/torchvision. Set the `FORGE_TRANSCODE_PYTHON` environment variable before starting Forge to use another compatible Python runtime. Missing codecs or an unavailable runtime result in an error in the conversion panel; no original is overwritten.

### Visual asset thumbnails

The library, project covers, and recent-creation strips create thumbnails as visual assets come into view. Forge takes an image or video frame, renders supported 3D models, or captures the first skeleton pose for BVH motion. Project thumbnails are cached under the project's hidden `.forge-thumbnails` folder and regenerated when the source file changes. Opening an asset still uses the full image, video, or interactive 3D/motion viewer. The thumbnail renderer limits model files to 64 MiB and only loads embedded model resources; a file that cannot be decoded or uses external resources shows a preview-unavailable placeholder.

Use **Full screen** on a 3D or motion preview in the library or a recent-creation panel to inspect it in a larger modal. Drag to rotate, use the on-screen controls to rotate or zoom, and pause or play motion. Close the modal with **Close** or Escape to return to the same asset.

| Location | Purpose |
| --- | --- |
| `src/` | React interface, navigation, notifications, and client logging |
| `projects.js` | Local project creation and asset discovery |
| `diagnostics.js` | Server metadata and log streaming |
| `server.js`, `runtime/http-server.js` | One supervised local service for the React app, HTTP API, and HTTP MCP |
| `vite.config.js` | Development server with hot reload |
| `runtime/` | Supervised runtime, GPU monitor worker thread, durable render queue, and MCP bridge |
| `public/samples/` | Assets included for exploring the library |
| `projects/` | Your project folders and manually added or future generated assets |
| `.forge-runtime/` | Launcher state, server logs, and persistent render queue database |
| `models/` | Forge-managed model checkpoints; other engines may use their existing locations |

Drafts, queue drafts, selected project, notification preferences, and preview ratings are stored in browser local storage. Clearing browser data or switching to a different browser or port can make those settings unavailable. Project files live on disk separately.

`projects/`, `.forge-runtime/`, `node_modules/`, and `dist/` are ignored by Git. Back up `projects/` separately if your assets matter to you; committing the source code will not include them.

## Troubleshooting

**The page will not open.** Run the start script again, check the address it prints, and inspect the log path it reports. Make sure Node.js is available and run `npm install` if dependencies are missing.

**The port is in use.** Start on a different port with `-Port 5199` and open the printed address. Use the same port when stopping the server. A different port has separate browser-local settings.

**A music job is waiting for its engine.** Forge starts YuE2 and requests the model automatically. Check Diagnostics if startup or loading fails. If GPU memory is insufficient, use the memory dialog to offload an eligible idle model or free memory externally, then retry.

**A job is interrupted.** Check the relevant engine's own queue and history for the corresponding render before resolving the item in Forge. An interrupted job blocks later jobs so an uncertain submission is not silently duplicated.

**An asset does not appear.** Check that it is inside a project folder and uses one of the indexed formats listed above. Allow a few seconds for the project listing to refresh.

**Notifications do not appear.** Check the browser's notification permission and use the test control. Keep the studio page open while a job completes.

**A model cannot be deleted from the UI.** Check that it is in Forge-managed storage, its service is stopped, and no custom endpoint or filesystem links prevent removal. Models stored in other applications must be managed there.

**You need help debugging.** Open Diagnostics, copy the relevant logs and server metadata, and include what you clicked and the time of the issue. Check logs for private content before sharing.

## Roadmap

The interface establishes the intended workflow. The next phase is to connect the actual services and verify them on the target hardware:

1. Add model adapters and explicit configuration for the existing local applications and future model services.
2. Build a central model inventory and managed `models/` storage, with accurate size, readiness, and safe deletion.
3. Implement one-click engine startup with models loaded as needed and resource-aware lifecycle management.
4. Replace queue drafts with durable, sequential jobs, real progress and cancellation, and estimates based on measured runs.
5. Save outputs into the selected project and connect completion events to notifications.
6. Expand model ratings, 3D indexing, and 3D previews.
7. Validate rigging, motion, segmentation, speech, and game-logic workflows against their actual model capabilities and platform requirements.

## Built with

React, Vite, JavaScript, CSS, and Lucide icons. The local development server also provides the current project, diagnostics, logging, and Windows power-control services.

## Chat and Qwen3.8

The Chat workspace supports streamed conversations, project-scoped browser history, text/JSON/JSON-schema responses, and OpenAI-compatible servers. Configure an OpenAI API key in the panel for the current page session, or set `OPENAI_API_KEY` in the studio server environment. The key is not saved with chat history. ChatGPT/Codex sign-in is not currently connected; this integration uses the API key route. Conversations are browser-local, not files in project folders.

Sending a message to the default local Qwen alias starts its managed GPU server on demand if it is not already running. The message remains in the composer during startup and is sent when the server is ready. If memory is insufficient, select an eligible idle Forge-managed service in the memory dialog or cancel and keep the unsent message. Other compatible endpoints are never started by this flow.

The local Qwen button uses the existing file `C:\Users\mreca\Desktop\LMStudio\lmstudio-community\Qwen3.8-27B-GGUF\Qwen3.8-27B-Q4_K_M.gguf`; LM Studio is not the inference server. The installed GGUF metadata includes one next-token prediction layer. Forge starts the official native Windows ARM64 CUDA llama.cpp server with `--device CUDA0 --n-gpu-layers all --fit off --ctx-size <selected> --parallel 1 --spec-type draft-mtp --spec-draft-n-max 3`. This config requests MTP speculation; confirm activation and performance in `.forge-runtime/engine-chat.log` after a successful model load. Forge reserves the render queue while starting and checks an estimated system and GPU memory budget that grows with the selected context size; at 4K, the admission thresholds are 21 GiB of free system memory and 21 GiB of free GPU memory, including a 2 GiB GPU reserve. These are snapshots, not reservations. The estimated 18.75 GiB total at 4K came from LM Studio's offline resource estimator. The bundled `llama-fit-params` reports a 405 MiB FP16 context allocation at 4K and about 64 MiB more for each additional 1,024 tokens; the on-screen total also allows for a small increase in compute memory. Actual use, including speculative decoding overhead, is not yet calibrated. The selected context applies on the next start; prompt, history, reasoning, and output share that limit. Maximum output tokens is a per-request cap and can be smaller than the context. The Force stop control applies only to a process whose ownership Forge can verify. An uncertain load or an unowned service may need review before the queue continues.

The native runtime is the official [llama.cpp b12180 release](https://github.com/ggml-org/llama.cpp/releases/tag/b12180), downloaded as `llama-b12180-bin-win-cuda-13.5-arm64.zip` (SHA-256 `86953cf12dd867676b387f2d319a2bfff918065163a5e48bda3a463c64f47d76`) and `cudart-llama-bin-win-cuda-13.5-arm64.zip` (SHA-256 `f89e7b2457f627d052dd99f42205ddfd01964454809754cdc649cffc74320dca`). Both archives were verified against the release's published digests before extraction. The [Qwen3.8 GGUF source](https://huggingface.co/lmstudio-community/Qwen3.8-27B-GGUF) remains in the existing model library and was not duplicated.

A compatible server such as vLLM can be connected over localhost or a private IPv4 network. [vLLM documents Linux as its supported platform](https://docs.vllm.ai/en/stable/getting_started/installation/gpu/); Forge does not use WSL or start vLLM on Windows. For external servers, GPU offload, model loading, speculative decoding, and render-queue coordination are configured and verified on that server, not by Forge.

Chat response controls are beside the message box: text, JSON object, or a strict JSON schema, plus model-default/off/low/medium/high thinking. For the Forge-managed local server, low/medium/high request thinking budgets of 256/768/1536 tokens; actual behavior depends on the model and server. The speculative-decoding switch applies to the next local Qwen start and requires stopping an already-running instance first. Other compatible servers control their own decoding settings and may not implement these fields.

The render queue appears in the asset library and creation panels. “Hide current rows” only hides the current job IDs in this browser; it never stops work and can be undone with “Show hidden.” “Clear waiting renders” requires typing CLEAR and cancels eligible queued/waiting jobs across projects. Running jobs, jobs with a remote ID, and uncertain jobs are left alone; completed assets and job records are kept.
