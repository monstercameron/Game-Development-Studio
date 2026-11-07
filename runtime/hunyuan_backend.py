"""Experimental Windows ARM64 Hunyuan3D shape loader.

This module is intended for an isolated worker process. Callers must perform
GPU and host-memory admission before loading; this file does not start a server.
"""

import gc
import importlib.machinery
import sys
import types
from pathlib import Path

import numpy as np
import torch
from PIL import Image


class PillowImageProcessor:
    """Adapt the upstream RGBA recentering pipeline to Pillow on Windows ARM.

    Pillow's resize kernels are not bit-identical to OpenCV's. This fallback
    must be evaluated for quality on representative inputs before release.
    """

    def __init__(self, size=512, border_ratio=0.15):
        self.size = size
        self.border_ratio = border_ratio

    def __call__(self, image, **_kwargs):
        if not isinstance(image, Image.Image):
            image = Image.open(image)
        rgba = np.asarray(image.convert("RGBA"))
        height, width = rgba.shape[:2]
        y, x = np.nonzero(rgba[:, :, 3])
        if not len(y):
            raise ValueError("The image has no visible foreground.")
        y0, y1, x0, x1 = y.min(), y.max(), x.min(), x.max()
        h, w = y1 - y0, x1 - x0
        if not h or not w:
            raise ValueError("The foreground is too small.")
        side = max(height, width)
        factor = side * (1 - self.border_ratio) / max(h, w)
        h2, w2 = int(h * factor), int(w * factor)
        if not h2 or not w2:
            raise ValueError("The foreground is too narrow.")
        crop = Image.fromarray(rgba[y0:y1, x0:x1]).resize((w2, h2), Image.Resampling.BOX)
        canvas = np.zeros((side, side, 4), dtype=np.uint8)
        top, left = (side - h2) // 2, (side - w2) // 2
        canvas[top : top + h2, left : left + w2] = np.asarray(crop)
        alpha = canvas[:, :, 3].astype(np.float32) / 255.0
        rgb = (
            (canvas[:, :, :3] * alpha[:, :, None] + 255 * (1 - alpha[:, :, None]))
            .clip(0, 255)
            .astype(np.uint8)
        )
        rgb = np.asarray(
            Image.fromarray(rgb).resize((self.size, self.size), Image.Resampling.BICUBIC)
        )
        alpha = np.asarray(
            Image.fromarray((alpha * 255).astype(np.uint8)).resize(
                (self.size, self.size), Image.Resampling.NEAREST
            )
        )
        image_tensor = (
            torch.from_numpy(rgb.copy()).permute(2, 0, 1).float().unsqueeze(0) / 255 * 2 - 1
        )
        mask_tensor = torch.from_numpy(alpha.copy()).float().unsqueeze(0).unsqueeze(0) / 255 * 2 - 1
        return {"image": image_tensor, "mask": mask_tensor}


def _load_shape_modules(source_dir):
    # Upstream's package initializer imports optional pymeshlab even for shape
    # inference. Treat its source directory as a namespace package in this
    # isolated process; no installed package or upstream source is modified.
    package = types.ModuleType("hy3dshape")
    package.__path__ = [str(Path(source_dir) / "hy3dshape" / "hy3dshape")]
    package.__spec__ = importlib.machinery.ModuleSpec("hy3dshape", loader=None, is_package=True)
    sys.modules["hy3dshape"] = package
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline, instantiate_from_config

    return Hunyuan3DDiTFlowMatchingPipeline, instantiate_from_config


def load_shape(source_dir, model_dir, *, device="cuda"):
    import yaml
    from accelerate import init_empty_weights

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable in the Hunyuan runtime.")
    pipeline_class, instantiate = _load_shape_modules(source_dir)
    folder = Path(model_dir) / "hunyuan3d-dit-v2-1"
    with open(folder / "config.yaml", encoding="utf-8") as stream:
        config = yaml.safe_load(stream)
    checkpoint = torch.load(
        folder / "model.fp16.ckpt", map_location="cpu", weights_only=True, mmap=True
    )
    components = {}
    for name in ("model", "vae", "conditioner"):
        with init_empty_weights():
            component = instantiate(config[name])
        missing, unexpected = component.load_state_dict(checkpoint[name], strict=False, assign=True)
        if missing or unexpected:
            raise RuntimeError(f"Hunyuan {name} checkpoint does not match the model configuration.")
        components[name] = component.to(device=device, dtype=torch.float16)
        del checkpoint[name]
        gc.collect()
    processor = PillowImageProcessor(**config["image_processor"]["params"])
    scheduler = instantiate(config["scheduler"])
    pipeline = pipeline_class(
        vae=components["vae"],
        model=components["model"],
        scheduler=scheduler,
        conditioner=components["conditioner"],
        image_processor=processor,
        device=device,
        dtype=torch.float16,
    )
    del checkpoint, components
    gc.collect()
    return pipeline


def generate_shape(pipeline, image, *, seed=123, steps=30, resolution=128, num_chunks=10000):
    if not isinstance(steps, int) or not 1 <= steps <= 100:
        raise ValueError("Steps must be between 1 and 100.")
    if resolution not in (128, 256, 384):
        raise ValueError("Unsupported mesh resolution.")
    with torch.inference_mode():
        result = pipeline(
            image=image,
            num_inference_steps=steps,
            octree_resolution=resolution,
            num_chunks=num_chunks,
            mc_algo="mc",
            generator=torch.Generator(device=pipeline.device).manual_seed(seed),
            enable_pbar=False,
        )
    mesh = result[0]
    if mesh is None or not len(mesh.vertices) or not len(mesh.faces):
        raise RuntimeError("No mesh surface was generated; try another seed, image, or more steps.")
    return mesh
