# Roadmap and to-do list

Planned work that is not built yet. Each entry says what it is, where it comes from, what is known,
what is unverified, and a first sketch of the integration. Move an entry to the studio guide when it
ships. Facts below were read from the upstream pages on the date shown and have not been run on this
machine unless an entry says so.

## Planned integrations

### OmniSVG: text and image to SVG (not started)

- **Added:** 2026-11-08.
- **What it is:** a family of end-to-end multimodal SVG generators built on pre-trained
  vision-language models. It generates SVG from text or from an image, from simple icons up to
  detailed illustrations and anime-style characters. NeurIPS 2025.
- **Source:** <https://github.com/OmniSVG/OmniSVG> (paper: <https://arxiv.org/abs/2504.06263>).
  Licence: Apache 2.0 (as reported by the repository). Last upstream push seen: 2026-03-01.
- **Weights (Hugging Face, sizes from the upstream README):**

  | Model                   | Size    | Notes            |
  | ----------------------- | ------- | ---------------- |
  | `OmniSVG/OmniSVG1.1_8B` | 17.2 GB | newest, largest  |
  | `OmniSVG/OmniSVG1.1_4B` | 7.69 GB | newest, smaller  |
  | `OmniSVG/OmniSVG` (3B)  | 8.49 GB | original release |

  Datasets MMSVG-Icon and MMSVG-Illustration and the MMSVGBench benchmark are published separately
  and are not needed for inference.

- **Related model to consider later:** OmniLottie (<https://github.com/OpenVGLab/OmniLottie>), from
  the same group, generates Lottie animations. Not evaluated.
- **Known requirements (from the README):** Python 3.10 environment, the Cairo system library for
  `CairoSVG`, and a CUDA GPU for inference.
- **Unverified here:** whether the dependency set (CairoSVG and its native Cairo library, the
  attention and VLM stack) installs and runs on native Windows ARM64 with the Blackwell GPU; real
  memory use per model size; output quality; the exact input formats the inference script accepts.
  A first task is a CPU-free dry check of the dependency list against the Windows ARM64 notes in
  [WINDOWS_ARM64.md](WINDOWS_ARM64.md).
- **Native ARM64 feasibility check (2026-11-10):** the existing TRELLIS Python 3.12.10 ARM64
  environment has discoverable `torch`, `transformers`, and `yaml` modules, but not `cairosvg`,
  `qwen_vl_utils`, `shapely`, or `einops` (module discovery only; imports and inference were not
  tested). Upstream specifies Python 3.10, Transformers 4.51.3 and PyTorch 2.3/CUDA 12.1, while the
  TRELLIS environment uses newer versions documented in [WINDOWS_ARM64.md](WINDOWS_ARM64.md).
  Compatibility and a native Cairo library remain unverified. The 4B configuration also requires
  the separate `Qwen/Qwen2.5-VL-3B-Instruct` base model as well as OmniSVG weights; neither was
  found in the studio model inventory. Upstream's inference script falls back to CPU and its decoder
  uses automatic device mapping, so a Forge adapter must explicitly enforce CUDA placement and local,
  offline model paths before enabling this integration. No weights were downloaded or loaded.
- **Integration sketch** (follow the existing patterns, no code written yet):
  1. **Linked source, not vendored:** pin the upstream commit as a linked repository the way
     SeedThree is handled (see [VEGETATION.md](VEGETATION.md) and `install-models.json`), with an
     explicit fetch step and no download during a render.
  2. **Model files:** add an optional entry to `install-models.json` and
     [MODEL_SOURCES.md](MODEL_SOURCES.md) with repository, revision, checksums and sizes. Start with
     the 4B model; offer 8B only if memory allows.
  3. **Worker and queue:** a separately supervised Python worker in its own environment, a new `svg`
     job type in the durable queue, GPU and host-memory admission like the other engines (one model
     loaded at a time, size-aware budget), cancel and restart recovery.
  4. **UI:** a creation page with a prompt, an optional reference image, a size or complexity
     control (token or path budget), seed and variations, the standard help tooltips, inline errors,
     reset to defaults and Reuse settings.
  5. **Output:** SVG files in the project (a new asset category), previewed natively in the
     browser, with generation details recorded in the per-project metadata database. Validate and
     sanitise the SVG before saving (no scripts, no external references).
  6. **Tooling:** MCP tools `forge_queue_svg` and a schema or status tool, docs, and tests with a
     substitute worker plus a real-engine test plan.
- **Open questions:** which weights to ship as the default; whether image-to-SVG is worth a separate
  mode; whether to rasterise a PNG preview alongside the SVG; how to expose the upstream sampling
  controls; whether to chain it after Qwen Image for a "describe, draw, vectorise" flow using the
  queue chaining that already exists.

### AVTR-1: talking and listening portrait avatars (not started)

- **Added:** 2026-11-08.
- **What it is:** a flow-matching autoregressive model for live dialogue. Given a portrait image and
  one or two audio streams, it renders lip-synced speech and "active listening" (the avatar reacts
  to the other speaker's audio) at 25 fps. It works in 5-frame chunks of 200 ms. Offline mode makes
  a video from a speech track, optionally with a second audio track to listen to, or idle motion for
  a set duration with no audio. There is also an interactive WebRTC streaming demo.
- **Source:** <https://github.com/avaturn-live/avtr-1> (weights:
  <https://huggingface.co/avaturn-live/avtr-1>; project page:
  <https://avaturn-live.github.io/avtr-1-projectpage/>). Last upstream push seen: 2026-09-25. The
  README lists a technical report and a production back end as "coming soon". The renderer also
  downloads LivePortrait weights repackaged as ONNX from `digital-avatar/ditto-talkinghead`.
- **Licences, read before building anything (three components, separate terms):**

  | Part                                                   | Licence                                                                                    | Consequence for Forge                                                                |
  | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
  | `src/avtr1_renderer/` (inference pipeline)             | PolyForm Noncommercial 1.0.0 with required notice                                          | no commercial use without a licence from Goodsize Inc.                               |
  | `src/avaturn_live_streamer/` (streaming orchestration) | PolyForm Noncommercial 1.0.0, plus a patent notice (a narrow noncommercial patent licence) | same, and the streamer is covered by pending patents                                 |
  | Weights and `scripts/`                                 | AVTR-1 Community License Agreement (`LICENSE-MODEL.md`)                                    | read the use restrictions and the definition of derivatives before shipping anything |

  Forge is a studio for making game assets, so a noncommercial-only component needs a clear note in
  the UI and docs, and users who sell their output would need their own licence from the vendor
  (contact and licensing pages are in the upstream `LICENSE-*.md` files). Do not vendor or
  redistribute the source or weights; link them the way SeedThree is linked.

- **Known requirements (from the upstream README):** Linux, an NVIDIA GPU (Ampere or later
  recommended), CUDA 12.x and TensorRT 10.x, the `pixi` package manager, a Hugging Face login to
  download weights, and TensorRT engines built locally for the exact GPU. Upstream timings run from
  84 ms per 5-frame chunk (L40) to 232 ms (RTX 4060), so real time needs a chunk under 200 ms.
- **Unverified here, and the main risk:** the stack is Linux-only as documented. Forge targets
  native Windows ARM64 with an NVIDIA Blackwell GPU and does not use WSL. Whether TensorRT 10.x,
  the engine build scripts and the pixi environment can run natively on Windows ARM64 at all is
  unknown, and it may be a blocker. Real latency, memory use and output quality on this machine are
  also unknown.
- **Integration sketch** (no code written yet; do the feasibility check in step 0 first): 0. **Feasibility check:** compare the upstream dependency list (TensorRT, pixi environment,
  engine build scripts) with [WINDOWS_ARM64.md](WINDOWS_ARM64.md). If it cannot run natively,
  record why and stop; do not fall back to WSL or CPU inference.
  1. **Linked source and weights:** pin the upstream commit as a linked repository (as for
     SeedThree), add an optional entry with repository, revision, checksums and sizes to
     `install-models.json` and [MODEL_SOURCES.md](MODEL_SOURCES.md), and an explicit fetch and
     engine-build step. Never download weights or build engines implicitly during a render.
  2. **Worker and queue:** a separately supervised worker and a new `avatar` job type in the durable
     queue, with GPU and host-memory admission, one model loaded at a time, cancel and recovery.
     Offline generation only at first; the interactive WebRTC streamer and TURN setup are out of
     scope.
  3. **Inputs:** a portrait image from the project, a speech audio asset (for example one made by
     the Voices page), an optional second audio asset to listen to, an avatar and background choice,
     and a duration for idle motion.
  4. **UI and output:** a creation page with the standard help, inline errors, reset to defaults and
     Reuse settings; MP4 output in the project's video folder with generation details (source
     portrait, audio assets, upstream commit, licence notice) in the metadata database.
  5. **Consent and labelling:** the page must say the portrait needs the permission of the person
     shown, and must not offer cloning of a real person's voice together with their likeness without
     that note. Consider a visible "synthetic" marker in the generation details.
  6. **Tooling:** MCP tools, docs, and tests with a substitute worker, plus a real-engine test plan.
- **Open questions:** whether the noncommercial licence is acceptable for the way Forge is used;
  whether a Windows ARM64 build is feasible; how it chains with Qwen3-TTS for "type text, get a
  talking avatar" using the queue chaining that already exists; which avatars and backgrounds ship
  with the weights.

### MoCapAnything V2: video to motion capture for arbitrary skeletons (not started)

- **Added:** 2026-11-08.
- **What it is:** an end-to-end model (`video2pose2rot`) that predicts animation-ready joint
  rotations (BVH) from a monocular video and a reference skeleton. It handles humans, animals,
  objects and custom rigs without a template body model, and the authors report it as roughly 20
  times faster than mesh-based pipelines. A reference frame of a matching species guides the
  skeleton and scale. A "Bring your own rig" flow preprocesses a rigged FBX character into the
  skeleton topology, joint-name embeddings and reference poses that inference needs. The upstream
  demo also has "Dance Anything" (a dance video with music, SAM2 picks the dancer, the target
  creature performs it, with the original audio re-muxed).
- **Source:** <https://github.com/phongdaot/MocapAnything> (project page:
  <https://animotionlab.github.io/MoCapAnythingV2/>; paper: <https://arxiv.org/abs/2604.28130>;
  weights: <https://huggingface.co/kehong/MoCapAnythingV2-weights>; demo data:
  <https://huggingface.co/datasets/kehong/MoCapAnythingV2-data-sample>). SIGGRAPH Asia 2026.
  Last upstream push seen: 2026-09-04. The authors say the release is a clean reimplementation, not
  the original research code, and document what it reproduces in `RUN.md`.
- **Licences, read before building:**

  | Part                                               | Licence                                                           | Consequence for Forge                                                |
  | -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
  | Repository code                                    | MIT (Copyright 2026 Kehong Gong)                                  | fine to link and call                                                |
  | `preprocess/briarmbg.py` and RMBG-1.4 weights      | BRIA AI's own terms, not MIT                                      | check before using the background-removal step; may be noncommercial |
  | `facebook/dinov2-large`, `facebook/sam2.1-hiera-*` | their upstream licences, listed in the repo's third-party notices | record each in [MODEL_SOURCES.md](MODEL_SOURCES.md)                  |
  | Pretrained weights                                 | see the Hugging Face model card (not read yet)                    | confirm the weights licence before shipping any download step        |
  | Full training data (about 25 GB, gated)            | needs Truebones Zoo purchased separately                          | not needed for inference; do not integrate                           |

  The full licence text for the third-party items is in the repository's `LICENSE` file.

- **Known requirements (from the upstream README and `RUN.md`):** Python with PyTorch built for the
  local CUDA, `requirements.txt` (pinned, including a git-pinned OpenAI CLIP), weights downloaded
  to `./checkpoints/`, optional demo data, optional portable Blender 4.x or 5.x (`BLENDER_BIN`) for
  the textured mesh render and the custom-rig preprocessing, and optional SAM2 for Dance Anything.
  Without Blender it still produces pose `.npy`, BVH and skeleton videos. The documentation is
  written for Linux shells (bash scripts).
- **Unverified here:** whether the pinned requirements and the custom CUDA operations install on
  native Windows ARM64 with the Blackwell GPU (Forge uses no WSL and no CPU fallback for
  inference); real memory use and speed on this machine; output quality on game characters; the
  weights licence; and how well it follows a user-supplied FBX rig. The first task is a dry check
  of `requirements.txt` against [WINDOWS_ARM64.md](WINDOWS_ARM64.md).
- **How it fits:** Forge already makes BVH motion from text (HY-Motion) and from keyframe poses
  (MotionBricks) and plays BVH in the viewer. This adds a third source: motion captured from a
  video. The Motion page is the natural home, as a "From video" mode.
- **Integration sketch** (no code written yet): 0. **Feasibility check** as above; stop and record why if it cannot run natively.
  1. **Linked source and weights:** pin the upstream commit as a linked repository (as for
     SeedThree), add optional entries for the weights, the RMBG and DINOv2 and SAM2 checkpoints
     with revisions, sizes and checksums to `install-models.json` and `MODEL_SOURCES.md`, and an
     explicit fetch step. No implicit downloads during a render.
  2. **Worker and queue:** a separately supervised worker and a new `mocap` job type in the durable
     queue, with GPU and host-memory admission, one model loaded at a time, cancel and recovery.
     Video preprocessing (frame extraction, resizing, background removal) stays on the CPU and is
     separate from inference.
  3. **Inputs:** a project video, a target skeleton (the released creature rigs, or a user-supplied
     rigged FBX that Forge preprocesses once and caches per project), and a reference frame; choose
     a clip range and frame rate. Blender-dependent steps are optional and clearly marked.
  4. **UI and output:** a "From video" mode on the Motion page with the standard help, inline
     errors, reset to defaults and Reuse settings; BVH output saved to the project's motion folder,
     playable in the viewer, with the source video, skeleton and upstream commit recorded in the
     metadata database.
  5. **Chaining:** use the queue chaining that already exists to feed a clip made on the Video
     page straight into motion capture.
  6. **Tooling:** MCP tools, docs, and tests with a substitute worker, plus a real-engine test plan.
- **Open questions:** whether the dependencies run natively on Windows ARM64; the weights licence
  and the BRIA terms for the background-removal step (it could be replaced by Forge's own SAM 3.1
  cutout); whether to expose "Dance Anything" (it needs SAM2 and re-muxes audio); how to accept and
  cache user-supplied FBX rigs without making Blender a hard requirement.

### UniMate: text to animation for any skeleton (not started)

- **Added:** 2026-11-08.
- **What it is:** one model that animates diverse rigged skeletons (bipedal, quadrupedal, avian,
  marine, insectoid, serpentine and articulated rigid objects) from a text prompt, in real time,
  with no per-skeleton retraining and no test-time optimisation. Given a rigged GLB, glTF or FBX and
  a prompt such as "An object trots forward", it produces joint motion, and the upstream scripts
  can drive the character's mesh and write an animated GLB and FBX per motion. Training is flow
  matching with a graph-attention transformer and a `flan-t5-base` text encoder. SIGGRAPH Asia 2026.
- **Source:** <https://github.com/Friedrich-M/UniMate> (project page:
  <https://linzhanmou.com/unimate/>; paper: <https://arxiv.org/abs/2609.05415>; checkpoints:
  <https://huggingface.co/Linzhan/UniMate>; dataset: <https://huggingface.co/datasets/Linzhan/UniML3D>).
  Licence: MIT (Copyright 2026 Linzhan Mou). Last upstream push seen: 2026-10-08. The authors call
  it an early step toward text-to-animation for any skeleton and say many motions and skeletons
  still fail.
- **Weights and data:** the released checkpoint `unimate_uniml3d_f60_v3` (configuration,
  normalisation statistics and the step-150000 checkpoint; the file size was not read, check the
  model card). Inference on your own rig needs only the checkpoint and the `rig_preprocess` step.
  The UniML3D dataset is about 88 GB and is needed only to animate its bundled skeletons or to
  train; do not integrate it. The dataset mixes Truebones, Mixamo and Objaverse-XL sources; check
  each source's licence before relying on the checkpoint's outputs commercially.
- **Bring your own rig:** `data_process/rig_preprocess` turns any rigged GLB, glTF or FBX (animated or
  not) into an asset directory, with a review step for its joint labels and facing. That review
  step suggests a small interactive UI in Forge.
- **Known requirements (from the upstream README and `requirements.txt`):** a Python 3.10 conda
  environment, `pip install -r requirements.txt --no-build-isolation` with `setuptools<81`, PyTorch
  2.5.1 built for CUDA 12.4 (`+cu124` wheels), the Blender `bpy` Python wheel from Blender's own
  wheel index (cp310), OpenAI CLIP, and the `flan-t5-base` text encoder fetched from Hugging Face.
  The scripts are bash.
- **Unverified here:** whether `torch==2.5.1+cu124`, the `bpy` wheel and the other pins are
  available for native Windows ARM64, and whether they work with the Blackwell GPU (Forge already
  runs a newer torch there, so the pins would need relaxing and retesting); real speed and memory;
  the quality of the motion on game characters; the checkpoint size. The first task is a dry check
  of `requirements.txt` against [WINDOWS_ARM64.md](WINDOWS_ARM64.md).
- **How it fits:** it is a third text-to-motion model next to HY-Motion (humanoid text-to-motion)
  and MotionBricks (keyframe-conditioned motion). Its distinguishing feature is animating a
  user-supplied non-humanoid rig, so it belongs on the Motion page as a model choice that takes a
  target rig. It could also share the rig-preprocessing step with MoCapAnything V2 (above), which
  needs the same kind of skeleton description.
- **Integration sketch** (no code written yet): 0. **Feasibility check** as above; if the dependency set cannot run natively, record why and
  stop. No WSL, no CPU inference.
  1. **Linked source and weights:** pin the upstream commit as a linked repository (as for
     SeedThree); add the checkpoint and the text encoder to `install-models.json` and
     [MODEL_SOURCES.md](MODEL_SOURCES.md) with revisions, sizes and checksums; explicit fetch only.
  2. **Worker and queue:** a separately supervised worker and a new job type in the durable queue
     (or a model option on the existing motion jobs), with GPU and host-memory admission.
  3. **Rigs:** accept a rigged GLB, glTF or FBX from the project, run `rig_preprocess` once, cache
     the processed asset directory per project, and show the joint-label and facing review step as
     a small UI before the first run. Treat Blender (`bpy`) as an optional dependency if possible.
  4. **Inputs and output:** a prompt, number of repetitions, seed and frame count (60-frame clips
     upstream); output BVH and an animated GLB, saved in the project's motion folder, playable in
     the viewer, with the rig, prompt and upstream commit recorded in the metadata database.
  5. **Tooling:** MCP tools, docs, standard help and inline errors, and tests with a substitute
     worker plus a real-engine test plan.
- **Open questions:** whether it runs natively on Windows ARM64; which rigs fail (the authors say
  many do); whether to share the rig-preprocessing and review UI with MoCapAnything V2; how to
  present clips that fail to animate a given rig.

### Pixal3D: pixel-aligned 3D generation from one or several images (not started)

- **Added:** 2026-11-08.
- **What it is:** an image-to-3D generator from Tencent ARC Lab and Tsinghua. Instead of loosely
  injecting image features through attention, it lifts pixel features into 3D by back-projection, so
  the geometry stays aligned with the input picture. It is a three-stage cascade (sparse structure,
  then shape up to 1024, then texture up to 1024) that produces a GLB mesh. The `main` branch is
  built on the TRELLIS.2 backbone; the `paper` branch is the original Direct3D-S2 version used for
  the SIGGRAPH 2026 results. It also has a **multi-view mode** (`inference_mv.py`): a directory of
  views plus a `transforms.json` with each camera, conditioned all at once, using separate
  multi-view weights from the same Hugging Face repository.
- **Source:** <https://github.com/TencentARC/Pixal3D> (project page:
  <https://ldyang694.github.io/projects/pixal3d/>; paper: <https://arxiv.org/abs/2605.10922>;
  models: <https://huggingface.co/TencentARC/Pixal3D>; demo:
  <https://huggingface.co/spaces/TencentARC/Pixal3D>). Licence: MIT (Copyright 2026 Tencent). Last
  upstream push seen: 2026-09-01. The `NOTICE` file lists third-party components that stay under
  their own licences (read it before shipping) and a responsible-use note: no non-consensual or
  sexualised depictions of real people, no content involving minors, no impersonation.
- **Why it matters for Forge:** it shares its backbone and installation with TRELLIS.2, which Forge
  already runs on native Windows ARM64 (including the patched native extensions). It is the most
  direct candidate for the 3D **multi-view input** gap listed in the studio guide (multi-view input
  was "not installed" for Hunyuan3D; Pixal3D would provide it without a new model family), and it
  offers a pixel-aligned alternative when TRELLIS.2 output drifts from the reference image.
- **Known requirements (from the upstream README):** the TRELLIS.2 environment first, then
  `requirements.txt` (MoGe from git, pinned `pillow`, `trimesh`, `transformers==4.57.3`,
  `diffusers==0.37.1`, `kornia`, `timm` and others; the pins may clash with Forge's existing
  TRELLIS.2 environment and would probably need a separate environment), `natten==0.21.0` built
  from source for the local CUDA architecture, and a prebuilt `utils3d` wheel fetched from a GitHub
  release. Default resolution is 1536 (standard mode) or 1024 (`--low_vram`, which loads models on
  demand). FlashAttention is optional: `ATTN_BACKEND=sdpa` uses PyTorch's built-in attention.
- **Unverified here:** whether `natten` builds for native Windows ARM64 with the Blackwell
  architecture; whether the pinned requirements install beside Forge's TRELLIS.2 packages; peak GPU
  and host memory for 1536 and for multi-view; speed; quality against TRELLIS.2 on the same
  inputs; the weights' licence on the model card (not read yet); which background-removal model it
  loads and whether that needs gated access (compare the note on gated background removal in the
  TRELLIS.2 section of the guide). A first task is a dry check of the requirements against
  [WINDOWS_ARM64.md](WINDOWS_ARM64.md) and the TRELLIS.2 build notes.
- **Integration sketch** (no code written yet): 0. **Feasibility check** as above, especially `natten` and `utils3d` on Windows ARM64. Stop and
  record why if it cannot run natively. No WSL, no CPU inference.
  1. **Linked source and weights:** pin the upstream commit as a linked repository (as for
     SeedThree); add the single-view and multi-view checkpoints to `install-models.json` and
     [MODEL_SOURCES.md](MODEL_SOURCES.md) with revisions, sizes and checksums; explicit fetch and
     build steps only.
  2. **Engine and queue:** a model option beside TRELLIS.2 on the 3D page, run in its own
     supervised worker (or the TRELLIS worker if the environments can be shared), with the
     existing size-aware GPU admission, one model loaded at a time, a low-VRAM switch, cancel and
     recovery, and a pipeline-resolution control (1024 or 1536).
  3. **Single image:** reuse the existing 3D inputs (a transparent image, or "Remove the background
     first" through the queue chaining that already exists, or text-to-3D through Qwen Image).
  4. **Multi-view:** a new input mode that takes two to eight project images with a camera for each.
     Start with the common case of four views 90 degrees apart at eye level, where the upstream
     example `transforms.json` can be reused as is; the first view must be the front view. Offer a
     way to feed it from a multi-view image model later.
  5. **Output:** GLB in the project's 3d folder with generation details (views, resolution, upstream
     commit, licence notice) in the metadata database, plus the same triangle budget and format
     conversion the 3D page already offers.
  6. **Tooling:** MCP tools, docs, standard help and inline errors, and tests with a substitute
     worker plus a real-engine test plan.
- **Open questions:** shared or separate environment with TRELLIS.2; the weights licence; the
  quality gain over TRELLIS.2 on game props; how to collect camera parameters for user-supplied
  multi-view sets; whether to add the original Direct3D-S2 `paper` branch (probably not).

### ACE-Step 1.5: fast local music generation, editing and stems (not started)

- **Added:** 2026-11-08.
- **What it is:** an open music foundation model from ACE Studio and StepFun. A language model
  (0.6B, 1.7B or 4B parameters, pretrained from Qwen3) acts as a planner that turns a short
  request into a full song blueprint, and a diffusion transformer (DiT) renders the audio. The
  upstream README claims commercial-grade quality, under 2 seconds per full song on an A100 and
  under 10 seconds on an RTX 3090, 10 seconds to 10 minutes of audio, up to 8 songs per batch, lyrics
  in more than 50 languages, and control of duration, BPM, key and time signature. These are the
  authors' claims and have not been measured here.
- **Source:** <https://github.com/ace-step/ACE-Step-1.5> (weights:
  <https://huggingface.co/ACE-Step/Ace-Step1.5>; paper: <https://arxiv.org/abs/2602.00744>; project
  page: <https://ace-step.github.io/ace-step-v1.5.github.io/>). Licence: MIT for the repository.
  Last upstream push seen: 2026-11-08. The README includes a disclaimer about unintentional
  copyright similarity and warns that only the GitHub Pages site is official (several look-alike
  domains are listed). The licence of each weight file is on its Hugging Face model card and has
  not been read yet.
- **Models:** DiT `acestep-v15-base`, `acestep-v15-sft` and `acestep-v15-turbo` (about 2B, about
  4.7 GB of weights), and the XL series `acestep-v15-xl-base`, `-sft` and `-turbo` (4B, about 9 GB
  in bf16). Turbo uses 8 steps and no classifier-free guidance; base and sft use 50 steps. Only the
  base models do extract, lego and complete. LM models: `acestep-5Hz-lm-0.6B`, `-1.7B` and `-4B`
  (the 4B is strongest for audio understanding and melody copying). Upstream guidance is XL
  sft with the 4B LM and everything resident at 24 GB of GPU memory or more, which fits this
  machine's 96 GiB GPU.
- **Why it matters for Forge:** the current Music page uses YuE2 (an external app, about 67 s for a
  15 s track in the real test). ACE-Step is far faster by its own numbers, and it adds features
  YuE2 does not offer here:

  | Feature                                                           | In ACE-Step 1.5 | In Forge today                 |
  | ----------------------------------------------------------------- | --------------- | ------------------------------ |
  | Text to music with lyrics and metadata (BPM, key, time signature) | yes             | partly (YuE2 lyrics and style) |
  | Cover generation from existing audio                              | yes             | no                             |
  | Repaint and local edit of a region                                | yes             | no                             |
  | Track separation into stems                                       | yes             | no                             |
  | Multi-track "add a layer" generation                              | yes             | no                             |
  | Vocal to background music (Vocal2BGM)                             | yes             | no                             |
  | Reference audio for style                                         | yes             | no                             |
  | Audio understanding (BPM, key, caption from audio)                | yes             | no                             |
  | LRC lyric timestamps for generated music                          | yes             | no                             |
  | Quality scoring of generated audio                                | yes             | no                             |
  | LoRA training (8 songs, about an hour on a 3090 with 12 GB)       | yes             | no                             |
  | Batch of up to 8 songs                                            | yes             | variations as sibling jobs     |

- **Known requirements (from the upstream README):** Python 3.11 or 3.12, the `uv` package manager
  (`uv sync`), a CUDA GPU recommended (it also supports MPS, ROCm, Intel XPU and CPU), models that
  download on first run, and an optional `vllm` backend for the language model (the `pt` backend is
  the alternative). It ships a REST API server (`uv run acestep-api`, default port 8001; also
  Windows launch scripts `start_api_server.bat` and `start_gradio_ui.bat` and a Windows portable
  package) that is a good fit for the way Forge already talks to external engines: submit with
  `POST /release_task`, poll `POST /query_result` until the status is succeeded or failed, then
  download the audio from `GET /v1/audio?path=...`; `GET /v1/models` lists the loaded DiT models;
  an optional API key is supported.
- **Unverified here:** whether `uv sync`, the torch wheels and every dependency install on native
  Windows ARM64 with the Blackwell GPU (Forge uses no WSL and no CPU inference); whether the `vllm`
  backend works there (the `pt` backend may be needed); real speed and memory; output quality
  against YuE2; the weights' licences; how the API reports progress and errors; whether loading
  the language model and the DiT together fits comfortably beside other Forge engines. A first
  task is a dry check of `requirements.txt` and `pyproject.toml` against
  [WINDOWS_ARM64.md](WINDOWS_ARM64.md).
- **Protocol and platform check (2026-11-10):** upstream commit
  `ca1e85fe9430179831e6bc6be790c332190a3866` returns an empty result with status 0 for an
  unknown task ID, and may return status 2 for a cache timeout rather than a confirmed failure.
  `runtime/acestep-protocol.js` conservatively interprets these responses and restricts output
  URLs to the relative audio endpoint; it is a protocol helper only, not a connected engine.
  Upstream's Windows dependency markers select PyTorch 2.7.1 with CUDA 12.8 without a separate
  ARM64 path. The official CUDA 12.8 package indexes had no `win_arm64` wheels for either
  `torch` 2.7.1 or `torchaudio` 2.7.1 when checked. Compatibility with the existing native ARM64
  CUDA runtime remains unverified. The upstream API module imported without loading a model in a
  Python 3.14 ARM64 environment sharing the installed Snapdargon-DJ CUDA packages and using a
  separate `.forge-runtime/acestep-packages` overlay; Python 3.14 is outside upstream's supported
  range, and an import does not verify inference. The minimal turbo, VAE and text encoder files
  were explicitly downloaded to `models/ACE-Step-1.5` from revision
  `19671f406d603126926c1b7e2adc169acbcade22` (about 5.89 GiB); the turbo checkpoint's SHA-256
  `3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7` matched upstream.
  No language model was downloaded. Upstream can download automatically and falls back to CPU even
  when CUDA is requested, so an adapter must prevent both before starting it. No ACE-Step model was
  loaded or tested; free host RAM was too low for a safe model load during this check.
- **Integration sketch** (no code written yet): 0. **Feasibility check** as above; if it cannot run natively, record why and stop.
  1. **Linked source and weights:** pin the upstream commit as a linked repository (as for
     SeedThree) rather than vendoring it, add the DiT and LM checkpoints to `install-models.json`
     and [MODEL_SOURCES.md](MODEL_SOURCES.md) with revisions, sizes and checksums, and an explicit
     fetch step. The upstream "models auto-download on first run" behaviour must be turned off or
     redirected into `models/` so a render never starts a download.
  2. **Engine:** a managed engine definition in Forge's engine list, supervised like the others,
     that starts the upstream API server on loopback with the API key set, with size-aware GPU
     admission, one model loaded at a time, offload and recovery; the music job module talks to
     `/release_task` and `/query_result` the way `music-job.js` talks to YuE2 today.
  3. **Music page:** a model switch (YuE2 or ACE-Step) with the standard help, inline errors, reset
     to defaults, seed, variations and Reuse settings; ACE-Step controls for duration (10 s to 10
     min), BPM, key, time signature, steps (8 for turbo, 50 otherwise) and LM size.
  4. **Editing actions on a music asset** in the library and Recent creations, as already done
     for YuE2 extend and re-synthesize: Cover, Repaint a region (start and end seconds), Separate
     into stems (each stem saved as a project audio asset), Make backing music from a vocal, and
     Analyse (BPM, key, caption, LRC).
  5. **Provenance:** record the model, LM size, seed, parameters and the upstream commit in the
     per-project metadata database; derived assets record their parent.
  6. **Tooling:** MCP tools, docs, and tests with a substitute API server plus a real-engine test
     plan. LoRA training is a later, separate item.
- **Open questions:** whether it can replace YuE2 or should sit beside it; which DiT and LM
  sizes to ship by default (turbo plus the 1.7B LM is the cheapest useful pairing); how to keep
  the language model and the DiT from holding too much memory next to the image and 3D engines
  (the chain-unload rule already frees a finished first stage); the licensing of generated
  output and the copyright-similarity disclaimer, which should be shown in the UI.

### Image super-resolution: VOSR and FiDeSR (not started)

- **Added:** 2026-11-08.
- **Why:** Forge has no general image upscaler or restorer today. The only upscaling in the repo is
  the small Real-ESRGAN x4plus network that the Hunyuan3D texture stage uses internally for
  textures. A real super-resolution feature would let users enlarge and clean up generated
  images, sprites, textures, texture maps, extracted video frames and low-quality reference
  pictures, and it would chain after Qwen Image or before a 3D job through the queue chaining that
  already exists. The two candidates below are both diffusion-based and recent (CVPR 2026).
  Evaluate them together and ship the better one first, not both.

#### Candidate 1: VOSR (preferred first)

- **What it is:** a "vision-only" generative model for image super-resolution that needs no text
  prompt or text encoder. Versions: VOSR 2.0 (a one-step 1.4B DiT with improved fine-structure
  restoration, the default), and 0.5B and 1.4B models each in multi-step (25 steps by default) and
  one-step (distilled) form. It has tiled inference for large images (DiT tiles plus a tiled VAE,
  the README says the Qwen VAE fits full-image encode up to about 8K inputs) and two controls for
  the faithfulness versus detail trade-off in multi-step mode (`--cfg_scale` and
  `--weak_cond_strength_aelq`). The authors also publish a real-world paired benchmark, ScreenSR.
  CVPR 2026, from Hong Kong Polytechnic University and OPPO Research.
- **Source:** <https://github.com/cswry/VOSR> (paper: <https://arxiv.org/pdf/2604.03225>; weights:
  <https://huggingface.co/CSWRY/VOSR>, also on ModelScope). Code licence: Apache 2.0. Last upstream
  push seen: 2026-09-08. The weights licence and file sizes were not read; the checkpoint folder
  also needs a Qwen-Image 2D VAE (the 1.4B models), the SD 2.1-base VAE and a lightweight decoder
  (the 0.5B models) and DINOv2 weights, each under its own licence.
- **Known requirements (from the upstream README and `requirements.txt`):** Python 3.8 (conda), pinned
  `torch==2.5.1+cu121`, `torchvision==0.20.1`, `triton==3.1.0`, `diffusers==0.35.0`,
  `transformers==4.52.0`, `basicsr==1.4.2`, `bitsandbytes==0.45.5`, `pyiqa` and others; single-GPU
  inference with `inference_vosr_onestep.py` (`-c` checkpoint, `-i` input, `-o` output, `-u`
  upscale factor 4, PNG output, wavelet colour alignment by default).
- **Unverified here:** whether the pins install on native Windows ARM64 with the Blackwell GPU (a
  `cu121` torch build has no kernels for that GPU, and Forge already runs a much newer torch, so the
  pins would need relaxing and retesting, along with `triton` and `bitsandbytes`); real speed and
  memory per size; quality on game art (pixel art and flat-colour sprites in particular);
  determinism; the weights licence.

#### Candidate 2: FiDeSR

- **What it is:** a one-step diffusion super-resolution method aiming at high fidelity and detail
  preservation. It builds on PiSA-SR and Stable Diffusion 2.1-base, uses LoRA weights plus an extra
  module (LRRB), tags the input image with the Recognize Anything Model (RAM), and exposes
  `--hf_scale` and `--lf_scale` controls for the high- and low-frequency trade-off. CVPR 2026.
  Single GPU, 512 px processing size and a 4x upscale in the example command.
- **Source:** <https://github.com/Ar0Kim/FiDeSR> (project page:
  <https://diffusion-sr.github.io/FiDeSR/>; checkpoint `fidesr.pkl`:
  <https://huggingface.co/jmjin2/FiDeSR>). The README says Apache 2.0, but GitHub detects no
  `LICENSE` file in the repository, so the licence is unclear until the authors add one; confirm
  before using or redistributing. Last upstream push seen: 2026-06-17. It also needs SD 2.1-base
  (its own model licence), the RAM Swin-Large checkpoint and the PiSA-SR lineage, each under its own
  terms.
- **Known requirements (from the upstream README and `requirements.txt`):** Python 3.10 (conda) and
  very old pins: `torch==2.0.1`, `xformers==0.0.20`, `diffusers==0.25.0`, `transformers==4.28.1`,
  `peft==0.9.0`, `numpy==1.23.5` and others.
- **Unverified here, and the main risk:** torch 2.0.1 and xformers 0.0.20 predate Blackwell and
  cannot run on this GPU, so the code would have to be ported to Forge's modern torch stack and
  tested; RAM tagging needs the `ram` package; real quality; the licence gap above.

#### Integration sketch (no code written yet; it applies to whichever model wins)

0. **Feasibility check:** compare each requirements file with [WINDOWS_ARM64.md](WINDOWS_ARM64.md),
   and run a tiny CPU-free dry import check. Choose the model that can run natively with the least
   porting. VOSR 2.0 is the likelier first choice (newer pins, Apache code, one step, tiling,
   no tagger). If neither runs natively, record why; no WSL, no CPU inference.
1. **Linked source and weights:** pin the upstream commit as a linked repository (as for
   SeedThree), add optional entries for the checkpoints and the VAE and decoder files with
   revisions, sizes and checksums to `install-models.json` and [MODEL_SOURCES.md](MODEL_SOURCES.md),
   and an explicit fetch step. No download during a render.
2. **Engine and queue:** a managed engine (or a worker) with a new `upscale` job type in the durable
   queue, size-aware GPU and host-memory admission (a function of output megapixels), tiling for
   large images, cancel and recovery, one model loaded at a time.
3. **UI:** an "Upscale" action on any image asset (Asset library, Recent creations, preview) and a
   small creation page with the scale factor (2x and 4x), a fidelity-versus-detail control (the
   upstream knobs, with plain-language labels), a tile size, an output format, and a before and
   after comparison slider in the preview. Standard help, inline errors, reset to defaults, Reuse
   settings and a recorded parent asset in the metadata database.
4. **Chaining and tooling:** allow an upscale step at the end of an image chain (text to image,
   then upscale) and before the 3D chain steps, as well as on Hunyuan or TRELLIS texture maps; MCP
   tools; docs; tests with a substitute worker plus a real-engine test plan.
5. **Quality checks to run on this machine before committing to a model:** the same five or six
   low-resolution game-art inputs through each candidate and through the existing Real-ESRGAN
   x4plus as a baseline, compared by eye and with PSNR, SSIM and LPIPS against known ground truth
   where it exists; record time and peak memory per megapixel.

- **Open questions:** which candidate wins on game art; the weights licences (and FiDeSR's missing
  licence file); whether to also expose the faster 0.5B VOSR for previews; whether pixel-art needs a
  separate non-diffusion path (nearest-neighbour or a dedicated model) so it is not smoothed.

### WhisperX: multilingual transcription with accurate word timing and speakers (not started)

- **Added:** 2026-11-08.
- **What it is:** an automatic speech recognition toolkit built around OpenAI's Whisper. It
  transcribes in batches through the `faster-whisper` backend, aligns each word to the audio with
  a phoneme model (wav2vec2) so the word timestamps are accurate, uses voice-activity detection to
  cut hallucinations and enable batching, and can label who is speaking (speaker diarization with
  `pyannote-audio`). Upstream's v3 claims about 70 times real time with `large-v2`, under 8 GB of
  GPU memory for `large-v2` at beam size 5, and a 2026 "interleaved context" option that carries
  context between segments for better punctuation and proper nouns. These are the authors' claims
  and have not been measured here. Accepted at INTERSPEECH 2023.
- **Source:** <https://github.com/m-bain/whisperX> (paper: <https://arxiv.org/abs/2303.00747>).
  Licence: BSD 2-Clause for the repository. Last upstream push seen: 2026-10-22. The Whisper
  weights are OpenAI's and carry their own licence (read the model card before shipping a
  download step). The alignment models are per language (torchaudio pipelines for English, French,
  German, Spanish and Italian, and Hugging Face models for many others).
- **Why it matters for Forge:** the current speech recognition engine is NVIDIA Nemotron Speech
  Streaming 0.6B, an English-only model tuned for streaming. WhisperX would add:

  | Capability            | WhisperX                                          | Forge today (Nemotron)  |
  | --------------------- | ------------------------------------------------- | ----------------------- |
  | Languages             | many (Whisper's set, language-specific alignment) | English only            |
  | Word-level timestamps | yes, phoneme-aligned                              | approximate word timing |
  | Speaker labels        | yes (diarization)                                 | no                      |
  | Subtitle output       | SRT with word highlighting; other formats         | no                      |
  | Long audio            | batched, fast                                     | streaming, real-time    |

  Useful places in the product: subtitles for the Video page's output, transcribing dialogue
  with several speakers, transcribing reference clips in other languages, and filling in the
  required **reference transcript** for voice cloning automatically instead of asking the user to
  type it (the clone mode needs the exact words spoken in the clip).

- **Known requirements (from the upstream README):** `pip install whisperx` or `uvx whisperx`
  (PyPI, so the dependency set is resolved by `uv`), the CUDA toolkit 12.8 for GPU use, ffmpeg and
  possibly Rust for some builds, and an optional `whisperx[fast]` extra (Numba) that speeds up
  alignment by a stated 30 to 100 times. Speaker diarization needs a Hugging Face access token and
  acceptance of the user agreements for the gated `pyannote` models; those terms are separate from
  WhisperX's own licence and the token must go through Forge's credential service, never a command
  line or log.
- **Unverified here, and the main risks:** whether `faster-whisper` and its CTranslate2 runtime have
  CUDA builds for native Windows ARM64 with the Blackwell GPU (Forge uses no WSL and no CPU
  inference, so a CPU-only runtime would not count); whether `torch`, `torchaudio`, `pyannote-audio`
  and `numba` install beside Forge's existing environments (they pin their own versions, so a
  separate environment is likely); real speed, memory and accuracy against Nemotron; the pyannote
  model terms; the Whisper weights licence.
- **Integration sketch** (no code written yet): 0. **Feasibility check:** compare the dependency set, especially CTranslate2 and numba, with
  [WINDOWS_ARM64.md](WINDOWS_ARM64.md); stop and record why if it cannot run natively.
  1. **Linked source and weights:** install it as a pinned dependency in its own environment,
     recorded in `install-models.json` and [MODEL_SOURCES.md](MODEL_SOURCES.md) with the Whisper and
     alignment model revisions, sizes and checksums; explicit fetch only, and Hugging Face downloads
     redirected into `models/` so a transcription never starts a download.
  2. **Engine and queue:** a managed worker with a `transcribe` job type in the durable queue (or a
     second engine behind the existing Recognition options), with GPU admission, one model loaded at
     a time, cancel and recovery. Keep Nemotron for live streaming and add WhisperX for file
     transcription.
  3. **UI:** on the Voices page's Recognition options, an engine choice (Streaming English or
     Whisper multilingual), language (auto-detect or chosen), word timing, speaker labels (needs the
     token, with a clear "add a Hugging Face token in Settings" state) and output formats.
  4. **Where results go:** transcripts and SRT or VTT files saved as project assets next to the
     source audio or video with the source and settings recorded in the metadata database; a
     "Transcribe this clip" action on audio and video assets; and the voice-clone mode offering
     "fill in the transcript for me" with an editable result before submitting.
  5. **Tooling:** MCP tools, docs, and tests with a substitute worker plus a real-engine test plan
     (word error rate against the Nemotron baseline on the same clips).
- **Open questions:** whether CTranslate2 runs natively; whether diarization is worth the gated
  model friction; which Whisper size to ship by default; whether to translate to English with
  Whisper's own task option; how it would coexist with the i18n work (transcripts are content,
  not interface text).

### Oxipng: lossless PNG optimisation for generated images and textures (not started)

- **Added:** 2026-11-08.
- **What it is:** a multithreaded, lossless PNG and APNG compression optimiser written in Rust,
  usable as a command-line tool or as a Rust library. It re-encodes the same pixels with better
  filtering and compression, so files shrink without any change to the image. Typical flags:
  `-o 0` to `-o 6` (or `max`) for effort (default `-o 2`), `--strip safe` or `--strip all` to drop
  metadata, `--alpha` to improve compression of images with transparency, and `-z` for Zopfli
  compression. Upstream is clear that it is not a brute-force optimiser, so a higher level is
  almost always but not always smaller.
- **Source:** <https://github.com/oxipng/oxipng>. Licence: MIT. Latest release seen: v10.2.1
  (2026-09-02); last upstream push seen: 2026-11-02. Minimum supported Rust version 1.85.1;
  follows Semantic Versioning.
- **Why it matters for Forge:** Forge produces a lot of PNG: Qwen Image renders (about 0.6 to 1.4
  MB each at 1024 px in the real tests), transparent cutouts and masks from SAM 3.1, panorama and
  texture images, extracted video frames, and thumbnails. A lossless pass saves disk without any
  quality decision, and it is CPU-only file work, which is allowed alongside GPU-only inference.
  It also helps people who export textures and sprites into a game.
- **Two cautions from upstream's own README that the integration must respect:**
  - `--alpha` changes the colour values of fully transparent pixels. That is technically lossy, so
    it must be an explicit opt-in per run. It could matter for cutouts that are later used as
    references for 3D generation (the alpha check treats low alpha as background) or composited in
    another tool, and for outputs that carry metadata the user wants to keep.
  - `--strip` removes metadata chunks. Forge keeps generation details in the per-project SQLite
    database, not in the PNG, so stripping is safe for that, but any chunk another tool added would
    be lost; default to `safe`.
- **APNG:** upstream supports only limited optimisation of animated PNGs; skip APNG by default.
- **Known requirements and platform notes:** a single native executable. The release assets seen
  for v10.2.1 cover Windows x86-64 and 32-bit x86, macOS, Linux (including ARM64 Linux) and Debian
  packages, but **no native Windows ARM64 build**. On this machine the x86-64 build would run
  under Windows' x64 emulation (slower, but it is a small file-by-file tool), or a native ARM64
  executable can be built with `cargo install oxipng` / `cargo build --release` using a Rust
  toolchain. A Docker image exists for Linux only and is not relevant here.
- **Unverified here:** whether the x86-64 build runs correctly under emulation on this Windows
  ARM64 system; whether a native Rust build works; real size savings and speed on Forge's actual
  outputs (photographic renders usually compress poorly with lossless methods, so the gain on
  Qwen images may be modest while masks and flat-colour sprites may shrink a lot); effect on
  thumbnail generation and the viewers (should be none, the pixels are identical).
- **Integration sketch** (no code written yet): 0. **Feasibility check:** download the pinned release asset or build it natively, record its
  SHA-256, and run it on a few real Forge PNGs; compare the decoded pixels before and after to
  confirm they are identical, and record the size change and time.
  1. **Source and pinning:** record the pinned version, source and checksum in
     [MODEL_SOURCES.md](MODEL_SOURCES.md) (or the equivalent tools section) and
     `install-models.json`, fetched explicitly by the installer like other external tools. Never
     download it during a render. Run it with an argument array, never a shell string.
  2. **Where it runs:** a CPU worker step with a bounded thread count so it never competes with a
     render for host memory or CPU, as a new `optimize` job type in the durable queue (or a final
     step after image jobs, off by default).
  3. **UI:** an "Optimise PNG" action on image assets and in the asset converter (lossless, with the
     before and after size shown), plus an optional per-project or per-page setting "Optimise new
     PNGs after saving" with an effort level and a clearly labelled, off-by-default "Allow changes
     to fully transparent pixels (--alpha)" checkbox. Metadata stripping stays off by default and
     defaults to `safe` when enabled.
  4. **Safety and provenance:** write the optimised file atomically next to the original, verify the
     decoded pixels are identical (or that only the allowed alpha pixels differ) before replacing
     anything, and keep the original recoverable in the project's trash. Record the optimisation
     (tool version, flags, bytes saved) in the asset's generation details.
  5. **Tooling:** MCP tool, docs, and tests with a fixture PNG set plus a real-binary test that
     compares decoded pixels.
- **Open questions:** emulated x86-64 or a native build; whether optimising should be automatic for
  masks and thumbnails only; whether to process extracted video frames and texture sets in bulk;
  whether to offer lossy PNG quantisation as a separate, clearly named tool (this entry is
  lossless only).
