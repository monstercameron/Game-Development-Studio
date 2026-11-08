"""Local files required by the experimental 512-resolution TRELLIS.2 pipeline."""

import json
from pathlib import Path

from app_log import get_logger

log = get_logger("three-d")

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models" / "TRELLIS.2-4B"
DECODER = ROOT / "models" / "TRELLIS-image-large" / "ckpts" / "ss_dec_conv3d_16l8_fp16"
DINO = ROOT / "models" / "dinov3-vitl16-pretrain-lvd1689m"
COMPONENTS = {
    "sparse_structure_flow_model": "ckpts/ss_flow_img_dit_1_3B_64_bf16",
    "sparse_structure_decoder": None,
    "shape_slat_flow_model_512": "ckpts/slat_flow_img2shape_dit_1_3B_512_bf16",
    "shape_slat_decoder": "ckpts/shape_dec_next_dc_f16c32_fp16",
    "tex_slat_flow_model_512": "ckpts/slat_flow_imgshape2tex_dit_1_3B_512_bf16",
    "tex_slat_decoder": "ckpts/tex_dec_next_dc_f16c32_fp16",
}


def required_files():
    paths = [MODEL / "pipeline.json", DINO / "config.json", DINO / "model.safetensors"]
    for relative in COMPONENTS.values():
        base = MODEL / relative if relative else DECODER
        paths.extend((Path(f"{base}.json"), Path(f"{base}.safetensors")))
    return paths


def missing_files():
    missing = []
    for path in required_files():
        try:
            if not path.is_file() or path.stat().st_size == 0:
                missing.append(path)
                continue
            if path.suffix == ".json":
                with path.open("r", encoding="utf-8") as stream:
                    json.load(stream)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            log.debug(
                "three-d.manifest.file.unusable",
                {"reason": "file_unusable", "errorClass": type(error).__name__},
            )
            missing.append(path)
    return missing


# Extra checkpoints for the higher-resolution pipelines. They live in the same repository as the
# 512 files (models/TRELLIS.2-4B/ckpts), so no extra download source is involved. The worker loads
# them on first use of a pipeline that needs them, not at startup, to keep the host-memory
# footprint of the default 512 pipeline unchanged.
EXTRA_COMPONENTS = {
    "shape_slat_flow_model_1024": "ckpts/slat_flow_img2shape_dit_1_3B_1024_bf16",
    "tex_slat_flow_model_1024": "ckpts/slat_flow_imgshape2tex_dit_1_3B_1024_bf16",
}
# Component keys (see Trellis2ImageTo3DPipeline.run) that each pipeline type needs beyond the
# always-loaded base set. The 1536 cascade reuses the 1024 checkpoints with a larger target grid.
PIPELINE_EXTRAS = {
    "512": (),
    "1024": ("shape_slat_flow_model_1024", "tex_slat_flow_model_1024"),
    "1024_cascade": ("shape_slat_flow_model_1024", "tex_slat_flow_model_1024"),
    "1536_cascade": ("shape_slat_flow_model_1024", "tex_slat_flow_model_1024"),
}
PIPELINE_TYPES = tuple(PIPELINE_EXTRAS)


def _usable(path):
    try:
        if not path.is_file() or path.stat().st_size == 0:
            return False
        if path.suffix == ".json":
            with path.open("r", encoding="utf-8") as stream:
                json.load(stream)
        return True
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        log.debug(
            "three-d.manifest.file.unusable",
            {"reason": "file_unusable", "errorClass": type(error).__name__},
        )
        return False


def extra_files(keys):
    paths = []
    for key in keys:
        base = MODEL / EXTRA_COMPONENTS[key]
        paths.extend((Path(f"{base}.json"), Path(f"{base}.safetensors")))
    return paths


def pipelines_available():
    """Pipeline types whose checkpoints are all on disk (the base files are required for all)."""
    if missing_files():
        return []
    return [
        name
        for name, keys in PIPELINE_EXTRAS.items()
        if all(_usable(path) for path in extra_files(keys))
    ]
