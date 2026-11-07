# Model sources and restoration

## World generators

Forge's World studio uses the installed desktop projects directly; their weights are not part of Forge's managed model inventory and are not deleted by Forge. WorldGen is based on [ZiYang-xie/WorldGen](https://github.com/ZiYang-xie/WorldGen), its [WorldGen model](https://huggingface.co/LeoXie/WorldGen), [DA-2 depth model](https://huggingface.co/haodongli/DA-2), and the appropriate FLUX model for text or image generation. See `Desktop/WorldGen/WINDOWS-ARM-README.md` and `download_models.py` for the native Windows environment and manual download steps. FLUX models may require accepting their terms and a Hugging Face token. Forge uses the existing cache in offline mode and does not trigger downloads.

For lower-memory FLUX inference, the installed setup additionally uses `models/worldgen/flux1-dev-Q5_0.gguf` from [city96/FLUX.1-dev-gguf](https://huggingface.co/city96/FLUX.1-dev-gguf) and `models/worldgen/flux1-fill-dev-Q5_0.gguf` from [second-state/FLUX.1-Fill-dev-GGUF](https://huggingface.co/second-state/FLUX.1-Fill-dev-GGUF). They are downloaded separately from the supporting FLUX components and panorama LoRAs; their upstream FLUX.1 dev license is non-commercial. With a working Hugging Face CLI, run `hf download city96/FLUX.1-dev-gguf flux1-dev-Q5_0.gguf --local-dir models/worldgen` and `hf download second-state/FLUX.1-Fill-dev-GGUF flux1-fill-dev-Q5_0.gguf --local-dir models/worldgen` from the studio root. These model files are excluded from Git; they are not currently represented as individually removable items in Forge's model catalog. If absent, the adapter uses its full-precision fallback, which may have substantially higher Windows commit-memory demand.

HY-World uses the local `Desktop/HY-World-2.0/compat-port` and its WorldMirror weights. The upstream project and model are [Tencent-Hunyuan/HY-World-2.0](https://github.com/Tencent-Hunyuan/HY-World-2.0) and [tencent/HY-World-2.0](https://huggingface.co/tencent/HY-World-2.0). The port's `download_weights.py --recon-only` documents how to restore the reconstruction weights. Forge's current HY-World integration exposes image reconstruction, not the larger WorldStereo or HY-Pano pipelines. The worker forces CUDA inference, runs each render in an isolated process, and exports a project PLY. Render-specific logs are available under **Diagnostics → Worlds**.

This is the provenance and recovery record for the Windows ARM64 installation observed on 2026-11-06. A model's presence on disk does not establish that it is connected to Forge or that every setting has been tested. See the main [README](../README.md) for current capabilities. Source repositories and terms can change; review the relevant model card before downloading or using a model.

**Keep existing models, projects, and credentials.** The commands below download only when run deliberately and may consume many gigabytes. Stop the associated Forge-managed service and separately started engine before replacing its files. Stage a restoration in a new directory, check its contents and hashes, and only then place it in the expected location. Do not overwrite an existing model or its Hugging Face `.cache` while an engine or downloader is using it.

## Model inventory

The revision is the downloaded Hugging Face commit recorded in the local `.cache/huggingface/download/*.metadata`; it is matched below to the upstream repository and a representative file's published hash. A metadata file records provenance; it is **not** a substitute for rehashing the actual file after a copy. Each source folder may contain additional configs, tokenizers, and licenses required by the engine.

| Studio model and local folder | Upstream model files | Recorded revision | Representative SHA-256 |
| --- | --- | --- | --- |
| Hunyuan3D shape, `models/Hunyuan3D-2.1/` | [tencent/Hunyuan3D-2.1](https://huggingface.co/tencent/Hunyuan3D-2.1), `hunyuan3d-dit-v2-1/model.fp16.ckpt` | `0b94677654c57bb9a6b6845cd7b704ccf551d327` | `6b519fc7242f78e9b5f47ea4d55668fe3d944a2d27332f4ca68d29a6ff603f5e` |
| HY-Motion, `models/HY-Motion/HY-Motion-1.0/` | [tencent/HY-Motion-1.0](https://huggingface.co/tencent/HY-Motion-1.0), `HY-Motion-1.0/latest.ckpt` | `620dd559f8d964aac2f82f1204fe6a35ad8ad14d` | `4fa91c6085f30c49bccda150b28d6c8d0887dc07e6d5d4ec0055482732635f10` |
| HY-Motion CLIP encoder, `models/HY-Motion/clip-vit-large-patch14/` | [openai/clip-vit-large-patch14](https://huggingface.co/openai/clip-vit-large-patch14), `model.safetensors` | `32bd64288804d66eefd0ccbe215aa642df71cc41` | `a2bf730a0c7debf160f7a6b50b3aaf3703e7e88ac73de7a314903141db026dcb` |
| HY-Motion text encoder, `models/HY-Motion/Qwen3-8B/` | [Qwen/Qwen3-8B](https://huggingface.co/Qwen/Qwen3-8B), five SafeTensors shards and tokenizer/config files | `b968826d9c46dd6066d109eabc6255188de91218` | Multiple shard hashes; inspect upstream metadata for each file. |
| Qwen3-TTS CustomVoice, `models/Qwen3-TTS-12Hz-1.7B-CustomVoice/` | [Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice), `model.safetensors` and the separate `speech_tokenizer/` directory | `0c0e3051f131929182e2c023b9537f8b1c68adfe` | `38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137` |
| Nemotron streaming ASR, `models/nemotron-speech-streaming-en-0.6b/` | [nvidia/nemotron-speech-streaming-en-0.6b](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b), `nemotron-speech-streaming-en-0.6b.q8_0.gguf` | `ebe59e5a817142986528bbbee5dba8db7b38ed50` | `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d` |
| SAM 3, `models/sam3/` | [facebook/sam3](https://huggingface.co/facebook/sam3), `sam3.pt`; access approval required | `3c879f39826c281e95690f02c7821c4de09afae7` | `9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e` |
| SAM 3.1, `models/sam3.1/` | [facebook/sam3.1](https://huggingface.co/facebook/sam3.1), `sam3.1_multiplex.pt`; access approval required | `daa63191845a41281374e725f4c9e51c7a824460` | `0567debeec80ba4ac6369540c6c248025283cb3ff2b92827509e57e2b3541cb6` |
| MotionBricks SOMA, `models/MotionBricks/checkpoints/` | [nvidia/MotionBricks](https://huggingface.co/nvidia/MotionBricks), SOMA checkpoint and statistics tree. The representative file is `mmm-v6-soma-pose-nova-4n8g-ea43dd8-fp32-v1/version_0/checkpoints/model-step=1500000.safetensors`. | `3cb362d9b95aa40462abcb4d8cfae9ffb6d97410` | `8537d9d33a880ff1df6c16c28ed061d60c461a5918d70b1cf99251ff91a10a10` |
| TRELLIS.2, `models/TRELLIS.2-4B/` | [microsoft/TRELLIS.2-4B](https://huggingface.co/microsoft/TRELLIS.2-4B), selected image-to-3D checkpoints | `af44b45f2e35a493886929c6d786e563ec68364d` | The project downloader verifies every selected file against the pinned repository metadata. |
| TRELLIS.2 supporting decoder, `models/TRELLIS-image-large/` | [microsoft/TRELLIS-image-large](https://huggingface.co/microsoft/TRELLIS-image-large), `ckpts/ss_dec_conv3d_16l8_fp16.*` | `25e0d31ffbebe4b5a97464dd851910efc3002d96` | Verified by the project downloader. |
| TRELLIS.2 DINOv3 image encoder, `models/dinov3-vitl16-pretrain-lvd1689m/` | [facebook/dinov3-vitl16-pretrain-lvd1689m](https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m), `model.safetensors`; access approval required | `ea8dc2863c51be0a264bab82070e3e8836b02d51` | `dcb2e45127cccbf1601e5f42fef165eea275c8e5213197e8dcf3f48822718179` |

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

### Other Forge-managed model weights

The following examples restore to a **new staging directory**, not the live folders. Install the HF CLI and authenticate first as needed. Run only the commands for the model being restored; each large download needs sufficient free space. `--revision` preserves the recorded snapshot. Keep the directory structure unchanged when placing verified files in the corresponding `models/` folder.

```powershell
cd 'C:\Users\mreca\Desktop\Game Development Studio'
$hf = 'C:\Users\mreca\Desktop\Qwen Image Studio\.venv\Scripts\hf.exe'
& $hf --help
$restore = Join-Path (Get-Location) 'models\forge-restore-staging'

# Hunyuan shape and VAE configs and FP16 checkpoints
& $hf download tencent/Hunyuan3D-2.1 'hunyuan3d-dit-v2-1/config.yaml' 'hunyuan3d-dit-v2-1/model.fp16.ckpt' 'hunyuan3d-vae-v2-1/config.yaml' 'hunyuan3d-vae-v2-1/model.fp16.ckpt' 'LICENSE' 'Notice.txt' --revision 0b94677654c57bb9a6b6845cd7b704ccf551d327 --local-dir "$restore\Hunyuan3D-2.1"

# HY-Motion and its separately downloaded text encoders
& $hf download tencent/HY-Motion-1.0 --revision 620dd559f8d964aac2f82f1204fe6a35ad8ad14d --include 'HY-Motion-1.0/*' --include 'LICENSE.txt' --include 'README.md' --local-dir "$restore\HY-Motion"
& $hf download openai/clip-vit-large-patch14 --revision 32bd64288804d66eefd0ccbe215aa642df71cc41 --include '*.json' --include '*.txt' --include '*.safetensors' --include 'README.md' --local-dir "$restore\HY-Motion\clip-vit-large-patch14"
& $hf download Qwen/Qwen3-8B --revision b968826d9c46dd6066d109eabc6255188de91218 --include '*.json' --include '*.txt' --include '*.safetensors' --include 'LICENSE' --include 'README.md' --local-dir "$restore\HY-Motion\Qwen3-8B"

# Qwen3-TTS includes the speech_tokenizer subdirectory
& $hf download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --revision 0c0e3051f131929182e2c023b9537f8b1c68adfe --include '*.json' --include '*.txt' --include '*.safetensors' --include 'speech_tokenizer/*' --include 'README.md' --local-dir "$restore\Qwen3-TTS-12Hz-1.7B-CustomVoice"

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

| Engine | Source and actual local relationship |
| --- | --- |
| Qwen Image 2.1 | [Qwen/Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1); `C:\Users\mreca\Desktop\Qwen Image Studio\download_model.py` uses `snapshot_download` into that application's `models/Qwen-Image-2.1`. The script follows the repo's current revision, so it is not a pinned restore. |
| YuE2 music | [m-a-p/YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B); see `C:\Users\mreca\Desktop\Snapdargon-DJ\docs\NVIDIA-SETUP.md` for the CUDA pipeline and its model/cache paths. |
| Stable Audio 3 | [stabilityai/stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium) requires approved access. `C:\Users\mreca\Desktop\Stable Audio Lab\download_model.py` downloads the gated snapshot into that app's `models/hub` cache; its revision is resolved when run. |
| MiniMax H3 video | The running H3 app uses local Q4_K_M diffusion and Qwen3-VL GGUFs in `C:\Users\mreca\Desktop\H3 Studio\models`. Matching filenames are published by [leejet/MiniMax-H3-GGUF](https://huggingface.co/leejet/MiniMax-H3-GGUF), but the exact source of the installed copies has not been established from local metadata. Its `server.js` currently reads both VAE files from `C:\Users\mreca\Desktop\Sol-Engine\windows-arm64\models\vae`, despite the H3 README claiming all files are local to H3 Studio. Preserve both directories. |
| Mammoth-1 | [magnitudedev/mammoth-1-GGUF](https://huggingface.co/magnitudedev/mammoth-1-GGUF); the companion app's `download_model.py` specifies `mammoth-1-Q4_K_M.gguf`, 16,547,406,624 bytes, SHA-256 `e453b42c2160e60e9d71b8f6554f8a8fc9ecb9c91cb1c639eec87d63e4bc2e68`, under `C:\Users\mreca\Desktop\Mammoth Studio\models\mammoth-q4km`. |

See [Windows ARM64 notes](WINDOWS_ARM64.md) for the code sources, CUDA toolchain, local patches, and validation commands.
