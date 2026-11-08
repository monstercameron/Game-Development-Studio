# Model sources and restoration

The canonical local model directory is `Game Development Studio/models`. Qwen Image,
YuE2, Stable Audio, MiniMax H3, Mammoth, HY-World, the Qwen chat GGUF, and the
WorldGen Hugging Face cache live there. Existing standalone applications use
compatibility junctions at their previous model directories; deleting or moving
the Studio model folders also affects those applications. Authentication files
remain in their original Hugging Face home. Shared models are protected from
Studio's model-removal controls until all consumers can be safely coordinated.

Some identical checkpoints use NTFS hard links inside `models`: replacing a file
is safe, but modifying its contents in place changes every linked name. The
one-time migration and cleanup journals are in the Codex workspace's `outputs`
directory. Installed runtimes, native extensions and standalone source remain in
their existing locations.

### Companion application changes in this installation

Several companion applications live outside this repository. A fresh clone does
not contain their source, Python environments, native executables, compatibility
junctions or local patches. Restore and verify those applications separately.
The observed Windows installation has these model-path changes:

- Qwen Image Studio's `app.py` accepts `QWEN_MODEL`; Forge sets it to
  `models/Qwen-Image-2.1`.
- Snapdargon-DJ's `vkyue/webapp/server.py` resolves YuE2 and its VAE from
  `FORGE_MODELS_ROOT` when set, otherwise from its original `models` directory.
- Stable Audio Lab's `download_model.py` uses `FORGE_STABLE_AUDIO_HUB` when
  set. Forge sets that value and `HF_HUB_CACHE` to `models/Stable-Audio-3/hub`.
  Its `HF_HOME` and credentials remain separate.
- H3 Studio's `server.js` accepts `FORGE_H3_MODEL_ROOT` for its diffusion and
  encoder files and `FORGE_H3_VAE_ROOT` for its video and audio VAEs. Its
  guarded startup also relies on the original startup and submission patterns.
- Mammoth Studio's `server.py` accepts `FORGE_MAMMOTH_MODELS` for the tokenizer
  and quantized model. HY-World's segmentation helper accepts
  `FORGE_HYWORLD_SKYSEG`; Forge selects the WorldMirror weights separately via
  `FORGE_HYWORLD_WEIGHTS`.
- ComfyUI's `extra_model_paths.yaml` points its H3 VAE and model paths to
  `models/MiniMax-H3/sol-engine`, and its LoRA and approximate-VAE paths to
  `models/ComfyUI`.

### Companion application patches for image LoRA and source sounds

Two companion apps were extended so Forge can expose engine features they already had. Both
are small additive changes; a stock app ignores Forge's new fields, so Forge checks for the
patch before using it (Qwen Image Studio answers `GET /api/loras`; Stable Audio Lab reports
`audio_input` in `GET /api/status`) and fails the job with a clear message instead of rendering
without the feature. Apply them to a fresh checkout, then restart the app.

**Qwen Image Studio `app.py`** (LoRA). `QwenImage21Pipeline` inherits diffusers'
`QwenImageLoraLoaderMixin`, so `load_lora_weights` and `set_adapters` exist, but diffusers
needs the `peft` package for them and the app's `.venv` does not include it. Install it with
`.venvScriptspython.exe -m pip install peft` (pure Python; not installed by Forge). LoRA files
go in `models/Qwen-Image-2.1-LoRA` (Forge sets `QWEN_LORA_DIR` to it). Compatibility of a
given LoRA with the 2.1 transformer is not verified; it must be trained for Qwen Image 2.1.

```diff
@@ -9,4 +9,6 @@ from pydantic import BaseModel, Field
 ROOT = Path(__file__).resolve().parent
 MODEL = os.environ.get('QWEN_MODEL', str(ROOT / 'models' / 'Qwen-Image-2.1'))
+# Forge additions: optional LoRA files (plain .safetensors names, never paths) from this folder.
+LORA_DIR = Path(os.environ.get('QWEN_LORA_DIR', str(ROOT / 'models' / 'Qwen-Image-2.1-LoRA')))
 app = FastAPI(title='Qwen Image Studio API', version='1.0')
 app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
@@ -30,4 +32,6 @@ class GenerateRequest(BaseModel):
     sigmas: list[float] | None = None
     use_kv_cache: bool = True
+    lora: str | None = Field(default=None, description='A .safetensors file name from GET /api/loras')
+    lora_scale: float = Field(default=1.0, ge=0.0, le=2.0)
     attention_kwargs: dict[str, Any] | None = None
     tensors: dict[str, str] | None = Field(default=None, description='Base64 safetensors files for latents, prompt_embeds, prompt_embeds_mask, negative_prompt_embeds, negative_prompt_embeds_mask')
@@ -43,4 +47,15 @@ def status():
     return {**state, 'model': MODEL, 'model_downloaded': model_ready(), 'busy': lock.locked()}

+def lora_files():
+    try:
+        return sorted(p.name for p in LORA_DIR.iterdir() if p.is_file() and not p.is_symlink() and p.suffix == '.safetensors' and p.name == Path(p.name).name)
+    except OSError:
+        return []
+
+@app.get('/api/loras')
+def loras():
+    # Forge reads this before sending a LoRA, because an app without it would ignore the field.
+    return {'folder': str(LORA_DIR), 'loras': [{'name': name} for name in lora_files()]}
+
 @app.get('/api/jobs/{job_id}')
 def job_status(job_id: str):
@@ -82,4 +97,5 @@ def generate(job_id, request):
             if request.height is not None and (request.height < 32 or request.height % 32): raise ValueError('Height must be a positive multiple of 32.')
             if request.num_inference_steps < 1 or request.num_images_per_prompt < 1: raise ValueError('Steps and image count must be positive.')
+            if request.lora is not None and request.lora not in lora_files(): raise ValueError('Unknown LoRA: choose a name from /api/loras.')
             args = dict(prompt=request.prompt, negative_prompt=request.negative_prompt, image=images or None, width=request.width, height=request.height, output_resolution=request.output_resolution, num_inference_steps=request.num_inference_steps, true_cfg_scale=request.true_cfg_scale, num_images_per_prompt=request.num_images_per_prompt, use_kv_cache=request.use_kv_cache, output_type='pil')
             if request.seed is not None: args['generator'] = torch.Generator(device='cuda').manual_seed(request.seed)
@@ -98,5 +114,18 @@ def generate(job_id, request):
                 return callback_kwargs
             args['callback_on_step_end']=progress
-            with torch.inference_mode(): result = pipe(**args)
+            if request.lora is not None:
+                try:
+                    import peft  # noqa: F401  (diffusers needs it to attach LoRA layers)
+                except ImportError: raise RuntimeError('LoRA needs the peft package: install it into this app\'s .venv (pip install peft).')
+                jobs[job_id].update(message='Applying LoRA')
+                pipe.load_lora_weights(str(LORA_DIR), weight_name=request.lora, adapter_name='forge')
+                pipe.set_adapters(['forge'], adapter_weights=[request.lora_scale])
+            try:
+                with torch.inference_mode(): result = pipe(**args)
+            finally:
+                # Never leave a LoRA attached for the next job.
+                if request.lora is not None:
+                    try: pipe.unload_lora_weights()
+                    except Exception: traceback.print_exc()
             urls=[]
             for i, image in enumerate(result.images):
```

**Stable Audio Lab `app.py`** (audio-to-audio, region replacement, continuation). Uses
`stable_audio_3`'s own `generate(init_audio=..., init_noise_level=..., inpaint_audio=...,
inpaint_mask_start_seconds=..., inpaint_mask_end_seconds=...)`, which the Lab never passed.

```diff
@@ -1,2 +1,4 @@
+import base64
+import io
 import json
 import logging
@@ -8,4 +10,5 @@ import traceback
 import uuid
 from pathlib import Path
+from typing import Literal, Optional

 from fastapi import FastAPI, HTTPException, Request
@@ -87,4 +90,25 @@ class Generation(BaseModel):
     steps: int = Field(default=8, ge=1, le=50)
     seed: int = Field(default=-1, ge=-1, le=2147483647)
+    # Forge additions: start from an existing sound (base64 WAV/FLAC/MP3/Ogg, up to about 32 MB).
+    # variation = audio-to-audio (init_noise_level 0.05-1; lower stays closer to the source),
+    # replace = regenerate inpaint_start..inpaint_end seconds, continue = keep the source and
+    # generate the rest up to `duration`.
+    source_audio: Optional[str] = Field(default=None, max_length=45_000_000)
+    edit_mode: Optional[Literal["variation", "replace", "continue"]] = None
+    init_noise_level: float = Field(default=0.9, ge=0.05, le=1.0)
+    inpaint_start: Optional[float] = Field(default=None, ge=0)
+    inpaint_end: Optional[float] = Field(default=None, gt=0)
+
+
+def load_source_audio(encoded):
+    """Decode a base64 sound into the (sample_rate, channels x samples tensor) the model takes."""
+    import numpy as np
+    import soundfile as sf
+    import torch
+    raw = base64.b64decode(encoded, validate=True)
+    data, sample_rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
+    if data.shape[0] < 1024 or not np.isfinite(data).all():
+        raise ValueError("The source sound is empty or damaged.")
+    return (sample_rate, torch.from_numpy(np.ascontiguousarray(data.T))), data.shape[0] / sample_rate


@@ -99,4 +123,6 @@ def status():
         snapshot = dict(state)
     snapshot["loaded"] = model is not None
+    # Forge checks this before sending a source sound, because older versions ignore the field.
+    snapshot["audio_input"] = True
     return snapshot

@@ -125,9 +151,27 @@ def generate_worker(params, job_id):
         started = time.perf_counter()
         seed = params.seed if params.seed >= 0 else secrets.randbelow(2147483647)
+        source_inputs, source_seconds = {}, None
+        if params.source_audio:
+            source, source_seconds = load_source_audio(params.source_audio)
+            if params.edit_mode == "variation":
+                source_inputs = dict(init_audio=source, init_noise_level=params.init_noise_level)
+            elif params.edit_mode == "replace":
+                if params.inpaint_start is None or params.inpaint_end is None \
+                        or params.inpaint_end <= params.inpaint_start or params.inpaint_end > params.duration:
+                    raise ValueError("Replace needs a start and an end inside the sound duration.")
+                source_inputs = dict(inpaint_audio=source, inpaint_mask_start_seconds=params.inpaint_start,
+                                     inpaint_mask_end_seconds=params.inpaint_end)
+            elif params.edit_mode == "continue":
+                if params.duration <= source_seconds + 0.05:
+                    raise ValueError("To continue a sound, set a duration longer than the source (%.1f s)." % source_seconds)
+                source_inputs = dict(inpaint_audio=source, inpaint_mask_start_seconds=source_seconds,
+                                     inpaint_mask_end_seconds=params.duration)
+            else:
+                raise ValueError("Choose variation, replace or continue for the source sound.")
         audio = model.generate(prompt=params.prompt.strip(), duration=params.duration,
                                steps=params.steps, seed=seed, cfg_scale=1.0,
                                # The library default (about 120 s) would silently cut longer sounds short.
                                sample_size=model.model_config['sample_size'],
-                               chunked_decode=True)
+                               chunked_decode=True, **source_inputs)
         samples = audio[0].detach().float().cpu().transpose(0, 1).numpy()
         import numpy as np
@@ -137,5 +181,7 @@ def generate_worker(params, job_id):
         sample_rate = model.model_config["sample_rate"]
         sf.write(OUTPUT / (stem + ".wav"), samples, sample_rate, subtype="PCM_16")
-        metadata = {**params.model_dump(), "seed": seed, "id": stem, "job_id": job_id,
+        # The source sound is large and already lives in the caller's project; keep it out of the history.
+        metadata = {**params.model_dump(exclude={"source_audio"}), "seed": seed, "id": stem, "job_id": job_id,
+                    **({"source_seconds": round(source_seconds, 2)} if source_seconds is not None else {}),
                     "sample_rate": sample_rate, "seconds_to_generate": round(time.perf_counter()-started, 2),
                     "created": time.strftime("%Y-%m-%d %H:%M:%S"),
```

Where these patches are absent, the original applications may instead need
carefully configured directory junctions to the corresponding central model
folders. Do not create a junction over an existing directory or move a live
model. These notes document the observed integration; they are not an automated
or verified fresh-machine installer for the companion apps.

## World generators

Forge's World studio uses the installed desktop projects directly; their weights are inventoried in Forge's centralized model directory and are protected from Studio removal. WorldGen is based on [ZiYang-xie/WorldGen](https://github.com/ZiYang-xie/WorldGen), its [WorldGen model](https://huggingface.co/LeoXie/WorldGen), [DA-2 depth model](https://huggingface.co/haodongli/DA-2), and the appropriate FLUX model for text or image generation. See `Desktop/WorldGen/WINDOWS-ARM-README.md` and `download_models.py` for the native Windows environment and manual download steps. FLUX models may require accepting their terms and a Hugging Face token. Forge uses the existing cache in offline mode and does not trigger downloads.

For lower-memory FLUX inference, the installed setup additionally uses `models/worldgen/flux1-dev-Q5_0.gguf` from [city96/FLUX.1-dev-gguf](https://huggingface.co/city96/FLUX.1-dev-gguf) and `models/worldgen/flux1-fill-dev-Q5_0.gguf` from [second-state/FLUX.1-Fill-dev-GGUF](https://huggingface.co/second-state/FLUX.1-Fill-dev-GGUF). They are downloaded separately from the supporting FLUX components and panorama LoRAs; their upstream FLUX.1 dev license is non-commercial. With a working Hugging Face CLI, run `hf download city96/FLUX.1-dev-gguf flux1-dev-Q5_0.gguf --local-dir models/worldgen` and `hf download second-state/FLUX.1-Fill-dev-GGUF flux1-fill-dev-Q5_0.gguf --local-dir models/worldgen` from the studio root. These model files are excluded from Git; they are not currently represented as individually removable items in Forge's model catalog. If absent, the adapter uses its full-precision fallback, which may have substantially higher Windows commit-memory demand.

HY-World uses the local `Desktop/HY-World-2.0/compat-port` and its WorldMirror weights. The upstream project and model are [Tencent-Hunyuan/HY-World-2.0](https://github.com/Tencent-Hunyuan/HY-World-2.0) and [tencent/HY-World-2.0](https://huggingface.co/tencent/HY-World-2.0). The port's `download_weights.py --recon-only` documents how to restore the reconstruction weights. Forge's current HY-World integration exposes multi-view and panorama reconstruction (WorldMirror 2.0) with its splat limit, sky removal and confidence filter, not the larger WorldStereo or HY-Pano text-to-panorama pipelines (HY-Pano weights are on disk but not exposed). The worker forces CUDA inference, runs each render in an isolated process, and exports a project PLY. Render-specific logs are available under **Diagnostics → Worlds**.

This is the provenance and recovery record for the Windows ARM64 installation observed on 2026-11-06. A model's presence on disk does not establish that it is connected to Forge or that every setting has been tested. See the main [README](../README.md) for current capabilities. Source repositories and terms can change; review the relevant model card before downloading or using a model.

**Keep existing models, projects, and credentials.** The commands below download only when run deliberately and may consume many gigabytes. Stop the associated Forge-managed service and separately started engine before replacing its files. Stage a restoration in a new directory, check its contents and hashes, and only then place it in the expected location. Do not overwrite an existing model or its Hugging Face `.cache` while an engine or downloader is using it.

## Model inventory

The revision is the downloaded Hugging Face commit recorded in the local `.cache/huggingface/download/*.metadata`; it is matched below to the upstream repository and a representative file's published hash. A metadata file records provenance; it is **not** a substitute for rehashing the actual file after a copy. Each source folder may contain additional configs, tokenizers, and licenses required by the engine.

| Studio model and local folder                                                                            | Upstream model files                                                                                                                                                                                                                                           | Recorded revision                          | Representative SHA-256                                                                      |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Hunyuan3D shape, `models/Hunyuan3D-2.1/`                                                                 | [tencent/Hunyuan3D-2.1](https://huggingface.co/tencent/Hunyuan3D-2.1), `hunyuan3d-dit-v2-1/model.fp16.ckpt`                                                                                                                                                    | `0b94677654c57bb9a6b6845cd7b704ccf551d327` | `6b519fc7242f78e9b5f47ea4d55668fe3d944a2d27332f4ca68d29a6ff603f5e`                          |
| Hunyuan3D Paint PBR texture, `models/Hunyuan3D-2.1/hunyuan3d-paintpbr-v2-1/`                             | [tencent/Hunyuan3D-2.1](https://huggingface.co/tencent/Hunyuan3D-2.1), `hunyuan3d-paintpbr-v2-1/unet/diffusion_pytorch_model.bin` (3.9 GB), VAE, CLIP text encoder, tokenizer, scheduler; Tencent Hunyuan Non-Commercial License (see `LICENSE`, `Notice.txt`) | `0b94677654c57bb9a6b6845cd7b704ccf551d327` | `675a1b5cd0098b2002637c443946529c03c5cd54427f40245263350feb3dd5b8`                          |
| Hunyuan3D Paint DINOv2 image encoder, `models/Hunyuan3D-2.1/dinov2-giant/`                               | [facebook/dinov2-giant](https://huggingface.co/facebook/dinov2-giant), `model.safetensors` (4.5 GB); Apache-2.0                                                                                                                                                | `611a9d42f2335e0f921f1e313ad3c1b7178d206d` | `917d3c470db999d32a312f8542149be91c7cbac61ee8fb4b67ae3d82b79ce21f`                          |
| Hunyuan3D Paint upscaler, `models/Hunyuan3D-2.1/RealESRGAN_x4plus.pth`                                   | [xinntao/Real-ESRGAN v0.1.0 release](https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.1.0), `RealESRGAN_x4plus.pth` (67 MB); BSD-3-Clause                                                                                                                | Release `v0.1.0`                           | `4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1`                          |
| HY-Motion, `models/HY-Motion/HY-Motion-1.0/`                                                             | [tencent/HY-Motion-1.0](https://huggingface.co/tencent/HY-Motion-1.0), `HY-Motion-1.0/latest.ckpt`                                                                                                                                                             | `620dd559f8d964aac2f82f1204fe6a35ad8ad14d` | `4fa91c6085f30c49bccda150b28d6c8d0887dc07e6d5d4ec0055482732635f10`                          |
| HY-Motion CLIP encoder, `models/HY-Motion/clip-vit-large-patch14/`                                       | [openai/clip-vit-large-patch14](https://huggingface.co/openai/clip-vit-large-patch14), `model.safetensors`                                                                                                                                                     | `32bd64288804d66eefd0ccbe215aa642df71cc41` | `a2bf730a0c7debf160f7a6b50b3aaf3703e7e88ac73de7a314903141db026dcb`                          |
| HY-Motion text encoder, `models/HY-Motion/Qwen3-8B/`                                                     | [Qwen/Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B), five SafeTensors shards and tokenizer/config files                                                                                                                                                      | `b968826d9c46dd6066d109eabc6255188de91218` | Multiple shard hashes; inspect upstream metadata for each file.                             |
| Qwen3-TTS CustomVoice, `models/Qwen3-TTS-12Hz-1.7B-CustomVoice/`                                         | [Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice), `model.safetensors` and the separate `speech_tokenizer/` directory                                                                                        | `0c0e3051f131929182e2c023b9537f8b1c68adfe` | `38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137`                          |
| Nemotron streaming ASR, `models/nemotron-speech-streaming-en-0.6b/`                                      | [nvidia/nemotron-speech-streaming-en-0.6b](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), `nemotron-speech-streaming-en-0.6b.q8_0.gguf`                                                                                                     | `ebe59e5a817142986528bbbee5dba8db7b38ed50` | `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d`                          |
| Qwen3-TTS Base (voice cloning, optional, downloaded and verified 2026-11-08; staged, not activated), `models/Qwen3-TTS-12Hz-1.7B-Base/`              | [Qwen/Qwen3-TTS-12Hz-1.7B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base), `model.safetensors` (3,857,413,744 bytes) and `speech_tokenizer/` (682,293,092 bytes); about 4.54 GB in total                                                           | `fd4b254389122332181a7c3db7f27e918eec64e3` | `38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c`                          |
| Qwen3-TTS VoiceDesign (voice design, optional, downloaded and verified 2026-11-08; staged, not activated), `models/Qwen3-TTS-12Hz-1.7B-VoiceDesign/` | [Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign), `model.safetensors` (3,833,402,552 bytes) and `speech_tokenizer/` (682,293,092 bytes); about 4.52 GB in total                                             | `5ecdb67327fd37bb2e042aab12ff7391903235d3` | `391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522`                          |
| SAM 3, `models/sam3/`                                                                                    | [facebook/sam3](https://huggingface.co/facebook/sam3), `sam3.pt`; access approval required                                                                                                                                                                     | `3c879f39826c281e95690f02c7821c4de09afae7` | `9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e`                          |
| SAM 3.1, `models/sam3.1/`                                                                                | [facebook/sam3.1](https://huggingface.co/facebook/sam3.1), `sam3.1_multiplex.pt`; access approval required                                                                                                                                                     | `daa63191845a41281374e725f4c9e51c7a824460` | `0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6`                          |
| MotionBricks SOMA, `models/MotionBricks/checkpoints/`                                                    | [nvidia/MotionBricks](https://huggingface.co/nvidia/MotionBricks), SOMA checkpoint and statistics tree. The representative file is `mmm-v6-soma-pose-nova-4n8g-ea43dd8-fp32-v1/version_0/checkpoints/model-step=1500000.safetensors`.                          | `3cb362d9b95aa40462abcb4d8cfae9ffb6d97410` | `8537d9d33a880ff1df6c16c28ed061d60c461a5918d70b1cf99251ff91a10a10`                          |
| TRELLIS.2, `models/TRELLIS.2-4B/`                                                                        | [microsoft/TRELLIS.2-4B](https://huggingface.co/microsoft/TRELLIS.2-4B), selected image-to-3D checkpoints                                                                                                                                                      | `af44b45f2e35a493886929c6d786e563ec68364d` | The project downloader verifies every selected file against the pinned repository metadata. |
| TRELLIS.2 supporting decoder, `models/TRELLIS-image-large/`                                              | [microsoft/TRELLIS-image-large](https://huggingface.co/microsoft/TRELLIS-image-large), `ckpts/ss_dec_conv3d_16l8_fp16.*`                                                                                                                                       | `25e0d31ffbebe4b5a97464dd851910efc3002d96` | Verified by the project downloader.                                                         |
| TRELLIS.2 DINOv3 image encoder, `models/dinov3-vitl16-pretrain-lvd1689m/`                                | [facebook/dinov3-vitl16-pretrain-lvd1689m](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m), `model.safetensors`; access approval required                                                                                                     | `ea8dc2863c51be0a264bab82070e3e8836b02d51` | `dcb2e45127cccbf1601e5f42fef165eea275c8e5213197e8dcf3f48822718179`                          |

The MotionBricks ONNX files in `models/MotionBricks/` are separate from the SafeTensors checkpoint tree. The currently integrated SOMA path uses NVIDIA's PyTorch graph and the checkpoint tree; the ONNX files and G1 inference are not the connected path. The [upstream repository](https://github.com/NVlabs/motionbricks) documents its ONNX export and separate source and model licenses. Its example poses have their own terms.

TRELLIS.2's upstream pipeline also names [briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0). The saved account received HTTP 403 when last checked. The experimental local backend uses transparent images instead, so that background-removal model is not downloaded by the steps below.

## Download tools and access

The existing Forge TRELLIS environment has `huggingface_hub`; the examples below use the [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/guides/cli). On this computer it is available at `C:\Users\mreca\Desktop\Qwen Image Studio\.venv\Scripts\hf.exe`; check `$hf --help` through PowerShell's call operator as shown below. On another machine, install the CLI using the linked official instructions. For gated repositories, request access on the model card, then use `& $hf auth login` interactively with the authorized account. That CLI login persists a token in the Hugging Face cache. Do not put tokens in source files, model manifests, shell command arguments, or logs.

The dedicated Forge DINOv3 downloader instead reads the existing shared Desktop credentials and passes the token over the child process's stdin. It does not put the token on the command line. Never commit that credentials file or share unreviewed logs.

### TRELLIS.2 public checkpoints and approved DINOv3

From the studio folder, with its current `.forge-runtime/trellis2-venv` in place:

```powershell
cd 'C:\Users\mreca\Desktop\Game Development Studio'
& '.\.forge-runtime\trellis2-venv\Scripts\python.exe' '.\runtime\trellis-download.py'
node '.\runtime\trellis-dinov3-download.js'
```

Both scripts pin revisions, resume Hub downloads, compare downloaded files to upstream hashes, and stop instead of replacing a pre-existing file that fails verification. They target `models/` directly, so do not run them while another download or removal of those directories is active. They require the Python environment documented in [Windows ARM64 notes](WINDOWS_ARM64.md). DINOv3 access must be approved for the token's account.

The 512, 1024, 1024 cascade and 1536 cascade pipelines all read these same checkpoints. The extra 1024 flow models are `slat_flow_img2shape_dit_1_3B_1024_bf16` and `slat_flow_imgshape2tex_dit_1_3B_1024_bf16` (about 2.6 GB each) in `models/TRELLIS.2-4B/ckpts`; they are part of the pinned download and are already present on this machine, so no separate download is involved.

### Other Forge-managed model weights

The following examples restore to a **new staging directory**, not the live folders. Install the HF CLI and authenticate first as needed. Run only the commands for the model being restored; each large download needs sufficient free space. `--revision` preserves the recorded snapshot. Keep the directory structure unchanged when placing verified files in the corresponding `models/` folder.

```powershell
cd 'C:\Users\mreca\Desktop\Game Development Studio'
$hf = 'C:\Users\mreca\Desktop\Qwen Image Studio\.venv\Scripts\hf.exe'
& $hf --help
$restore = Join-Path (Get-Location) 'models\forge-restore-staging'

# Hunyuan shape and VAE configs and FP16 checkpoints
& $hf download tencent/Hunyuan3D-2.1 'hunyuan3d-dit-v2-1/config.yaml' 'hunyuan3d-dit-v2-1/model.fp16.ckpt' 'hunyuan3d-vae-v2-1/config.yaml' 'hunyuan3d-vae-v2-1/model.fp16.ckpt' 'LICENSE' 'Notice.txt' --revision 0b94677654c57bb9a6b6845cd7b704ccf551d327 --local-dir "$restore\Hunyuan3D-2.1"

# Optional Hunyuan texture (Paint PBR) files, DINOv2-giant, and the Real-ESRGAN x4plus upscaler.
# The image_encoder folder in the Paint repository is not used and is skipped.
& $hf download tencent/Hunyuan3D-2.1 --revision 0b94677654c57bb9a6b6845cd7b704ccf551d327 --include 'hunyuan3d-paintpbr-v2-1/model_index.json' --include 'hunyuan3d-paintpbr-v2-1/README.md' --include 'hunyuan3d-paintpbr-v2-1/feature_extractor/*' --include 'hunyuan3d-paintpbr-v2-1/scheduler/*' --include 'hunyuan3d-paintpbr-v2-1/text_encoder/*' --include 'hunyuan3d-paintpbr-v2-1/tokenizer/*' --include 'hunyuan3d-paintpbr-v2-1/unet/*' --include 'hunyuan3d-paintpbr-v2-1/vae/*' --local-dir "$restore\Hunyuan3D-2.1"
& $hf download facebook/dinov2-giant config.json preprocessor_config.json model.safetensors --revision 611a9d42f2335e0f921f1e313ad3c1b7178d206d --local-dir "$restore\Hunyuan3D-2.1\dinov2-giant"
Invoke-WebRequest -Uri 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth' -OutFile "$restore\Hunyuan3D-2.1\RealESRGAN_x4plus.pth"

# HY-Motion and its separately downloaded text encoders
& $hf download tencent/HY-Motion-1.0 --revision 620dd559f8d964aac2f82f1204fe6a35ad8ad14d --include 'HY-Motion-1.0/*' --include 'LICENSE.txt' --include 'README.md' --local-dir "$restore\HY-Motion"
& $hf download openai/clip-vit-large-patch14 --revision 32bd64288804d66eefd0ccbe215aa642df71cc41 --include '*.json' --include '*.txt' --include '*.safetensors' --include 'README.md' --local-dir "$restore\HY-Motion\clip-vit-large-patch14"
& $hf download Qwen/Qwen3-8B --revision b968826d9c46dd6066d109eabc6255188de91218 --include '*.json' --include '*.txt' --include '*.safetensors' --include 'LICENSE' --include 'README.md' --local-dir "$restore\HY-Motion\Qwen3-8B"

# Qwen3-TTS includes the speech_tokenizer subdirectory
& $hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --revision 0c0e3051f131929182e2c023b9537f8b1c68adfe --include '*.json' --include '*.txt' --include '*.safetensors' --include 'speech_tokenizer/*' --include 'README.md' --local-dir "$restore\Qwen3-TTS-12Hz-1.7B-CustomVoice"

# Optional: voice cloning (Base) and voice design (VoiceDesign) checkpoints for Qwen3-TTS.
# Used by the Voices page clone (Base) and design (VoiceDesign) modes; stage them with: .\install.ps1 -Models tts-base,tts-voicedesign
& $hf download Qwen/Qwen3-TTS-12Hz-1.7B-Base --revision fd4b254389122332181a7c3db7f27e918eec64e3 --include '*.json' --include '*.txt' --include '*.safetensors' --include 'speech_tokenizer/*' --include 'README.md' --local-dir "$restoreQwen3-TTS-12Hz-1.7B-Base"
& $hf download Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign --revision 5ecdb67327fd37bb2e042aab12ff7391903235d3 --include '*.json' --include '*.txt' --include '*.safetensors' --include 'speech_tokenizer/*' --include 'README.md' --local-dir "$restoreQwen3-TTS-12Hz-1.7B-VoiceDesign"

# NVIDIA speech GGUF, plus gated Meta checkpoints after approval
& $hf download nvidia/nemotron-speech-streaming-en-0.6b nemotron-speech-streaming-en-0.6b.q8_0.gguf --revision ebe59e5a817142986528bbbee5dba8db7b38ed50 --local-dir "$restore\nemotron-speech-streaming-en-0.6b"
& $hf download facebook/sam3 sam3.pt --revision 3c879f39826c281e95690f02c7821c4de09afae7 --local-dir "$restore\sam3"
& $hf download facebook/sam3.1 sam3.1_multiplex.pt --revision daa63191845a41281374e725f4c9e51c7a824460 --local-dir "$restore\sam3.1"

# SOMA checkpoint tree; this does not download the separate ONNX files
& $hf download nvidia/MotionBricks --revision 3cb362d9b95aa40462abcb4d8cfae9ffb6d97410 --include 'soma/*' --local-dir "$restore\MotionBricks\checkpoints"
```

Before installation, check the model's representative file with `Get-FileHash -Algorithm SHA256 -LiteralPath '<staged-file>'` and compare it to the table. For multi-file models verify every required file against the pinned upstream metadata, not just the representative hash. For MotionBricks, preserve the checkpoint subdirectories and statistics files. **These are model restoration examples, not a full environment installer**; binary runtimes, patched packages, and external applications are separate dependencies.

The speech runtime is NVIDIA's [NeMo-Speech.cpp v0.3.0 Windows ARM64 CUDA release](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.3.0), `nemo-speech-0.3.0-windows-aarch64-cuda.zip`, published SHA-256 `69df7a29636ebf8fdaa20e7a2a6bd03c2838c69dc751fd00af62f0d7f041282a`. The installed executable is `.forge-runtime/nemo-speech-0.3.0/bin/nemo-speech.exe`. Verify the archive before extracting it to a separate staging directory; do not replace a running service.

## Models owned by other applications

Forge does not currently move or restore these model files. Their own launchers and download scripts are the source of truth, and model files may live outside Forge's `models/`.

| Engine           | Source and actual local relationship                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qwen Image 2.1   | [Qwen/Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1); `C:\Users\mreca\Desktop\Qwen Image Studio\download_model.py` uses `snapshot_download` into that application's `models/Qwen-Image-2.1`. The script follows the repo's current revision, so it is not a pinned restore.                                                                                                                                                                                                                                    |
| YuE2 music       | [m-a-p/YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B); see `C:\Users\mreca\Desktop\Snapdargon-DJ\docs\NVIDIA-SETUP.md` for the CUDA pipeline and its model/cache paths.                                                                                                                                                                                                                                                                                                                                                     |
| Stable Audio 3   | [stabilityai/stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium) requires approved access. `C:\Users\mreca\Desktop\Stable Audio Lab\download_model.py` downloads the gated snapshot into that app's `models/hub` cache; its revision is resolved when run.                                                                                                                                                                                                                                     |
| MiniMax H3 video | The running H3 app uses local Q4_K_M diffusion and Qwen3-VL GGUFs in `C:\Users\mreca\Desktop\H3 Studio\models`. Matching filenames are published by [leejet/MiniMax-H3-GGUF](https://huggingface.co/leejet/MiniMax-H3-GGUF), but the exact source of the installed copies has not been established from local metadata. Forge configures diffusion and encoder files under `models/MiniMax-H3/h3-studio` and VAEs under `models/MiniMax-H3/sol-engine/vae`. Standalone compatibility junctions preserve the original paths. |
| Mammoth-1        | [magnitudedev/mammoth-1-GGUF](https://huggingface.co/magnitudedev/mammoth-1-GGUF); the companion app's `download_model.py` specifies `mammoth-1-Q4_K_M.gguf`, 16,547,406,624 bytes, SHA-256 `e453b42c2160e60e9d71b8f6554f8a8fc9ecb9c91cb1c639eec87d63e4bc2e68`, under `models\Mammoth-1\mammoth-q4km`.                                                                                                                                                                                                                      |

### Qwen Image 2.1 LoRA (optional, not installed by Forge)

Qwen Image Studio reads LoRA files from `models/Qwen-Image-2.1-LoRA/` (Forge sets `QWEN_LORA_DIR` to it). The file below is the only LoRA recorded here. It was checked against Hub metadata before download.

- Source: [akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA](https://huggingface.co/akhaliq/Qwen-Image-2.1-Multiple-Angles-LoRA), `checkpoints_v2/angles_v2_full_qwen21_multiple_angles_v2_qwen21_multiple_angles_v2_000001500.safetensors` (the card's recommended v2 step 1,500 checkpoint), repository revision `175b29b6eb41307473eebc363fca8fc198216b60`.
- Local file: `models/Qwen-Image-2.1-LoRA/angles_v2_step1500.safetensors`, 318,819,792 bytes, SHA-256 `548c57977c3f1c09c2c9e5f4e83e930cbc6f719c878a576ab8666ce29fef39b6`.
- Base and license: the card declares `Qwen/Qwen-Image-2.1` as its base model, rank 64, license Apache-2.0. It is a camera-angle LoRA, not a style LoRA. Prompts start with the trigger `<mva>`, and the card suggests strength 0.8 to 1.0.
- Status: size and SHA-256 verified. `peft` 0.21.2 was installed into the Qwen Image Studio `.venv` with `--no-deps`; torch, torchvision, diffusers, and transformers versions were unchanged. Loading this LoRA into the pipeline has not been tested.

See [Windows ARM64 notes](WINDOWS_ARM64.md) for the code sources, CUDA toolchain, local patches, and validation commands.
