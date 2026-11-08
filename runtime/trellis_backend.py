"""Offline, GPU-only TRELLIS.2 pipelines for an isolated Windows worker.

The 512 pipeline is loaded at startup; the 1024, 1024_cascade and 1536_cascade pipelines load
their extra checkpoints on first use (see trellis_manifest.PIPELINE_EXTRAS).
The caller must perform host/GPU memory admission before loading or rendering.
Only transparent inputs are supported until the gated background remover is
available. Checkpoints are memory-mapped to avoid an extra full CPU copy.
"""

import gc
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".forge-runtime" / "trellis2-cache"
os.environ["ATTN_BACKEND"] = "sdpa"
os.environ["SPARSE_ATTN_BACKEND"] = "sdpa"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HOME"] = str(ROOT / "models" / "hf-cache")
os.environ["TORCH_HOME"] = str(ROOT / "models" / "torch-cache")
os.environ["TRITON_HOME"] = str(CACHE)
os.environ["FLEX_GEMM_AUTOTUNE_CACHE_PATH"] = str(CACHE / "flex-gemm" / "autotune_cache.json")
os.environ["FLEX_GEMM_AUTOSAVE_AUTOTUNE_CACHE"] = "0"

# These imports must follow the environment setup so CUDA and model libraries
# observe the offline cache paths and selected attention backends at import time.
import numpy as np  # noqa: E402
import torch  # noqa: E402
from accelerate import init_empty_weights  # noqa: E402
from PIL import Image  # noqa: E402
from safetensors.torch import load_file  # noqa: E402
from trellis_manifest import (  # noqa: E402
    COMPONENTS,
    DECODER,
    DINO,
    EXTRA_COMPONENTS,
    MODEL,
    PIPELINE_EXTRAS,
    PIPELINE_TYPES,
    missing_files,
    pipelines_available,
)


def _load_component(base):
    from trellis2 import models

    config = json.loads(Path(f"{base}.json").read_text(encoding="utf-8"))
    with init_empty_weights():
        model = getattr(models, config["name"])(**config["args"])
    # assign=True adopts the checkpoint tensors as they are, including their stored dtype
    # (bf16/fp16). The model declares its own dtypes (the input and output layers stay float32
    # while the torso is converted), so remember them and restore them after assignment. Without
    # this the float32 noise meets bfloat16 weights ("mat1 and mat2 must have the same dtype").
    declared_dtypes = {name: value.dtype for name, value in model.named_parameters()}
    declared_buffer_dtypes = {name: value.dtype for name, value in model.named_buffers()}
    state = load_file(f"{base}.safetensors", device="cpu")
    load_result = model.load_state_dict(state, strict=False, assign=True)
    for name, value in model.named_parameters():
        if (
            name in declared_dtypes
            and value.dtype != declared_dtypes[name]
            and value.device.type != "meta"
        ):
            value.data = value.data.to(declared_dtypes[name])
    for name, value in model.named_buffers():
        if name in declared_buffer_dtypes and value.dtype != declared_buffer_dtypes[name]:
            if value.device.type != "meta" and value.is_floating_point():
                value.data = value.data.to(declared_buffer_dtypes[name])
    missing = set(load_result.missing_keys)
    # This deterministic buffer is absent from the upstream checkpoint.
    if config["name"] == "SparseStructureFlowModel" and missing == {"rope_phases"}:
        from trellis2.modules.attention import RotaryPositionEmbedder

        args = config["args"]
        positions = torch.meshgrid(
            *[torch.arange(args["resolution"]) for _ in range(3)], indexing="ij"
        )
        coords = torch.stack(positions, dim=-1).reshape(-1, 3)
        model.rope_phases = RotaryPositionEmbedder(args["model_channels"] // args["num_heads"], 3)(
            coords
        )
        missing.clear()
    if (
        missing
        or load_result.unexpected_keys
        or any(
            value.device.type == "meta"
            for value in list(model.parameters()) + list(model.buffers())
        )
    ):
        raise RuntimeError(f"Checkpoint {base.name} does not match its model configuration.")
    model.eval()
    return model


# Stands in for the gated background remover, which is not installed. Calling it raises, so
# opaque images are rejected instead of having their background removed.
class TransparentOnly:
    def to(self, _device):
        return self

    def cpu(self):
        return self

    def __call__(self, _image):
        raise ValueError(
            "TRELLIS.2 currently requires a transparent image. Remove its background first."
        )


def load_trellis():
    """Load the 512 pipeline on CUDA with its base checkpoints.

    Raises RuntimeError when CUDA, a required file or an expected component configuration is
    missing. The caller checks host and GPU memory before calling this.
    """
    if not torch.cuda.is_available():
        raise RuntimeError("TRELLIS.2 requires CUDA; CPU inference is disabled.")
    missing = missing_files()
    if missing:
        raise RuntimeError(
            f"TRELLIS.2 is missing {len(missing)} required files, including {missing[0].name}."
        )
    from trellis2.modules.image_feature_extractor import DinoV3FeatureExtractor
    from trellis2.pipelines import Trellis2ImageTo3DPipeline, samplers

    config = json.loads((MODEL / "pipeline.json").read_text(encoding="utf-8"))["args"]
    for key, expected in COMPONENTS.items():
        if expected and config["models"].get(key) != expected:
            raise RuntimeError(f"Unexpected TRELLIS.2 pipeline component: {key}.")
    if (
        config["models"].get("sparse_structure_decoder")
        != "microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16"
    ):
        raise RuntimeError("Unexpected TRELLIS.2 decoder configuration.")
    loaded = {
        key: _load_component(MODEL / relative if relative else DECODER)
        for key, relative in COMPONENTS.items()
    }

    def sampler(key):
        return getattr(samplers, config[key]["name"])(**config[key]["args"])

    pipeline = Trellis2ImageTo3DPipeline(
        models=loaded,
        sparse_structure_sampler=sampler("sparse_structure_sampler"),
        shape_slat_sampler=sampler("shape_slat_sampler"),
        tex_slat_sampler=sampler("tex_slat_sampler"),
        sparse_structure_sampler_params=config["sparse_structure_sampler"]["params"],
        shape_slat_sampler_params=config["shape_slat_sampler"]["params"],
        tex_slat_sampler_params=config["tex_slat_sampler"]["params"],
        shape_slat_normalization=config["shape_slat_normalization"],
        tex_slat_normalization=config["tex_slat_normalization"],
        image_cond_model=DinoV3FeatureExtractor(str(DINO)),
        rembg_model=TransparentOnly(),
        low_vram=True,
        default_pipeline_type="512",
    )
    pipeline.cuda()
    gc.collect()
    return pipeline


def ensure_pipeline_models(pipeline, pipeline_type, report=None):
    """Load the checkpoints a higher-resolution pipeline needs, once, the first time it is used.

    They stay on the CPU like the base models: the pipeline runs in low_vram mode and moves one
    model at a time to the GPU while it samples. The caller checks host memory beforehand.
    Returns True when checkpoints were read, False when everything was already loaded.
    """
    if pipeline_type not in PIPELINE_TYPES:
        raise ValueError(f"Unsupported TRELLIS.2 pipeline: {pipeline_type}.")
    needed = [key for key in PIPELINE_EXTRAS[pipeline_type] if key not in pipeline.models]
    if not needed:
        return False
    if pipeline_type not in pipelines_available():
        raise RuntimeError(f"The TRELLIS.2 {pipeline_type} checkpoints are not installed.")
    config = json.loads((MODEL / "pipeline.json").read_text(encoding="utf-8"))["args"]
    for key in needed:
        if config["models"].get(key) != EXTRA_COMPONENTS[key]:
            raise RuntimeError(f"Unexpected TRELLIS.2 pipeline component: {key}.")
    for key in needed:
        if report:
            report(f"Loading the {pipeline_type} checkpoints (first use of this pipeline).")
        pipeline.models[key] = _load_component(MODEL / EXTRA_COMPONENTS[key])
    gc.collect()
    return True


def validate_transparent(image):
    if image.mode != "RGBA":
        raise ValueError(
            "TRELLIS.2 currently requires a PNG or WebP with a transparent background."
        )
    alpha = np.asarray(image.getchannel("A"))
    if alpha.min() == 255 or np.count_nonzero(alpha > 204) < 4:
        raise ValueError("The image needs a transparent background and a visible foreground.")
    if np.count_nonzero(alpha < 128) < alpha.size * 0.01:
        raise ValueError("The image has no real transparent background.")
    ys, xs = np.where(alpha > 204)
    if xs.max() == xs.min() or ys.max() == ys.min():
        raise ValueError("The visible foreground is too small.")


# Qwen Image's transparent output leaves a faint haze (alpha 1 to 25 over about half the frame).
# Upstream premultiplies colour by alpha, so the haze became a dark slab under the model. Alpha
# below this value counts as background.
FAINT_ALPHA = 32


def clear_faint_alpha(image):
    pixels = np.array(image.convert("RGBA"))
    pixels[pixels[:, :, 3] < FAINT_ALPHA] = 0
    return Image.fromarray(pixels, "RGBA")


# Upstream's default is 1,000,000 triangles, which is far too heavy for a game asset. The
# Forge default is 100,000; the full-detail ceiling remains selectable.
DEFAULT_TARGET_FACES = 100000
MIN_TARGET_FACES = 5000
MAX_TARGET_FACES = 1000000


def generate_glb(
    pipeline,
    image,
    destination,
    *,
    seed=42,
    steps=12,
    texture_size=1024,
    target_faces=DEFAULT_TARGET_FACES,
    pipeline_type="512",
    report=None,
):
    """Render a transparent-background image to a GLB file at destination.

    Raises ValueError for an unsupported image or parameter and RuntimeError when CUDA is
    unavailable or the pipeline returns no mesh. report, when given, receives progress text.
    """
    if not torch.cuda.is_available():
        raise RuntimeError("TRELLIS.2 requires CUDA; CPU inference is disabled.")
    if pipeline_type not in PIPELINE_TYPES:
        raise ValueError(f"Unsupported TRELLIS.2 pipeline: {pipeline_type}.")
    validate_transparent(image)
    image = clear_faint_alpha(image)
    if not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        raise ValueError("Invalid seed.")
    if not isinstance(steps, int) or not 1 <= steps <= 50 or texture_size not in (512, 1024, 2048):
        raise ValueError("Unsupported sampling steps or texture size.")
    if not isinstance(target_faces, int) or not (
        MIN_TARGET_FACES <= target_faces <= MAX_TARGET_FACES
    ):
        raise ValueError("Triangle target must be between 5,000 and 1,000,000.")
    import o_voxel

    if ensure_pipeline_models(pipeline, pipeline_type, report) and report:
        # The loading message would otherwise stay on the job for the whole render.
        report(f"Generating textured 3D model ({pipeline_type} pipeline).")
    with torch.inference_mode():
        mesh = pipeline.run(
            image,
            seed=seed,
            pipeline_type=pipeline_type,
            sparse_structure_sampler_params={"steps": steps},
            shape_slat_sampler_params={"steps": steps},
            tex_slat_sampler_params={"steps": steps},
        )[0]
        if mesh is None or not len(mesh.vertices) or not len(mesh.faces):
            raise RuntimeError("No mesh was generated. Try another image or seed.")
        mesh.simplify(16777216)
        glb = o_voxel.postprocess.to_glb(
            vertices=mesh.vertices,
            faces=mesh.faces,
            attr_volume=mesh.attrs,
            coords=mesh.coords,
            attr_layout=mesh.layout,
            voxel_size=mesh.voxel_size,
            aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
            decimation_target=target_faces,
            texture_size=texture_size,
            remesh=True,
            remesh_band=1,
            remesh_project=0,
            verbose=True,
        )
        glb.export(str(destination), file_type="glb", extension_webp=True)
