"""Experimental Windows ARM64 Hunyuan3D 2.1 texture (Paint PBR) stage.

Runs inside the isolated Hunyuan worker after the shape stage. It reuses the
upstream multiview PBR diffusion model, renderer and baking code, and replaces
the pieces upstream cannot run here: Blender (GLB export), MeshLab (mesh
simplification) and basicsr/realesrgan (a small Real-ESRGAN loader). Callers
must perform GPU and host-memory admission before loading.
"""

import gc
import importlib.machinery
import importlib.util
import os
import random
import sys
import types
from pathlib import Path

import numpy as np
import torch
from PIL import Image

TEXTURE_SIZES = (1024, 2048)
# Upstream's default: six selected views of 512x512 images, UniPC, 15 steps.
VIEW_COUNT = 6
VIEW_SIZE = 512
DIFFUSION_STEPS = 15
SIMPLIFY_FACES = 40000
CANDIDATE_AZIMS = [0, 90, 180, 270, 0, 180]
CANDIDATE_ELEVS = [0, 0, 0, 0, 90, -90]
CANDIDATE_WEIGHTS = [1, 0.1, 0.5, 0.1, 0.05, 0.05]
for _azim in range(0, 360, 30):
    for _elev in (20, -20):
        CANDIDATE_AZIMS.append(_azim)
        CANDIDATE_ELEVS.append(_elev)
        CANDIDATE_WEIGHTS.append(0.01)

REQUIRED_FILES = (
    "hunyuan3d-paintpbr-v2-1/model_index.json",
    "hunyuan3d-paintpbr-v2-1/unet/config.json",
    "hunyuan3d-paintpbr-v2-1/unet/diffusion_pytorch_model.bin",
    "hunyuan3d-paintpbr-v2-1/vae/config.json",
    "hunyuan3d-paintpbr-v2-1/vae/diffusion_pytorch_model.bin",
    "hunyuan3d-paintpbr-v2-1/text_encoder/config.json",
    "hunyuan3d-paintpbr-v2-1/text_encoder/pytorch_model.bin",
    "hunyuan3d-paintpbr-v2-1/tokenizer/vocab.json",
    "hunyuan3d-paintpbr-v2-1/tokenizer/merges.txt",
    "hunyuan3d-paintpbr-v2-1/scheduler/scheduler_config.json",
    "hunyuan3d-paintpbr-v2-1/feature_extractor/preprocessor_config.json",
    "dinov2-giant/config.json",
    "dinov2-giant/preprocessor_config.json",
    "dinov2-giant/model.safetensors",
    "RealESRGAN_x4plus.pth",
)
NATIVE_MODULES = ("custom_rasterizer_kernel", "xatlas", "fast_simplification")


def texture_files_ready(model_dir):
    return all((Path(model_dir) / item).is_file() for item in REQUIRED_FILES)


def native_modules_ready(source_dir):
    """True when the compiled helpers exist; nothing is imported or loaded."""
    try:
        if any(importlib.util.find_spec(name) is None for name in NATIVE_MODULES):
            return False
        if not (Path(source_dir).parent / "trellis2-opencv-install" / "python" / "cv2").is_dir():
            return False
    except (ImportError, ValueError):
        return False
    folder = Path(source_dir) / "hy3dpaint" / "DifferentiableRenderer"
    return any(folder.glob("mesh_inpaint_processor*.pyd"))


# ---------------------------------------------------------------- Real-ESRGAN


class _ResidualDenseBlock(torch.nn.Module):
    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        nn = torch.nn
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class _RRDB(torch.nn.Module):
    def __init__(self, num_feat, num_grow_ch=32):
        super().__init__()
        self.rdb1 = _ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = _ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = _ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class _RRDBNet(torch.nn.Module):
    """RRDBNet of Real-ESRGAN x4plus (BSD-3-Clause, xinntao/Real-ESRGAN)."""

    def __init__(self, num_feat=64, num_block=23, num_grow_ch=32):
        super().__init__()
        nn = torch.nn
        self.conv_first = nn.Conv2d(3, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[_RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, 3, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        feat = feat + self.conv_body(self.body(feat))
        up = torch.nn.functional.interpolate
        feat = self.lrelu(self.conv_up1(up(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(up(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


class Upscaler:
    def __init__(self, weights_path, device):
        state = torch.load(weights_path, map_location="cpu", weights_only=True)
        state = state.get("params_ema") or state.get("params") or state
        network = _RRDBNet()
        network.load_state_dict(state, strict=True)
        self.device = device
        self.network = network.eval().to(device=device, dtype=torch.float16)

    @torch.inference_mode()
    def __call__(self, image):
        array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0)
        output = self.network(tensor.to(self.device, torch.float16))
        output = output.squeeze(0).float().clamp_(0, 1).permute(1, 2, 0).cpu().numpy()
        return Image.fromarray((output * 255.0).round().astype(np.uint8))


# ------------------------------------------------------------------- loading


def _stub_unneeded_modules():
    # Upstream's mesh_utils imports Blender for its OBJ-to-GLB helper, which is
    # replaced here; the OBJ writer in the same file does not need it.
    if "bpy" not in sys.modules and importlib.util.find_spec("bpy") is None:
        sys.modules["bpy"] = types.ModuleType("bpy")


def _use_native_opencv(source_dir):
    # The OpenCV wheel in this environment aborts at import on CPUs without the
    # dot-product baseline. The studio's own NEON-baseline build (core, imgproc,
    # photo) covers resize and inpainting, which are all the texture stage uses.
    folder = Path(source_dir).parent / "trellis2-opencv-install" / "python"
    if "cv2" not in sys.modules and (folder / "cv2").is_dir() and str(folder) not in sys.path:
        sys.path.insert(0, str(folder))


def _load_hunyuanpaintpbr(paint_dir):
    # Upstream's package initializer imports training code (Lightning). Treat the
    # directory as a namespace package so only the inference modules load.
    package = types.ModuleType("hunyuanpaintpbr")
    package.__path__ = [str(Path(paint_dir) / "hunyuanpaintpbr")]
    package.__spec__ = importlib.machinery.ModuleSpec(
        "hunyuanpaintpbr", loader=None, is_package=True
    )
    sys.modules["hunyuanpaintpbr"] = package
    from hunyuanpaintpbr.pipeline import HunyuanPaintPipeline
    from hunyuanpaintpbr.unet.modules import Dino_v2, UNet2p5DConditionModel

    return HunyuanPaintPipeline, UNet2p5DConditionModel, Dino_v2


def _load_view_processor(paint_dir):
    path = Path(paint_dir) / "utils" / "pipeline_utils.py"
    spec = importlib.util.spec_from_file_location("hy3dpaint_pipeline_utils", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ViewProcessor


class PaintModels:
    """Loaded texture models. Close() releases their GPU and host memory."""

    def __init__(self, source_dir, model_dir, *, device="cuda"):
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable in the Hunyuan runtime.")
        self.device = device
        self.paint_dir = str(Path(source_dir) / "hy3dpaint")
        if self.paint_dir not in sys.path:
            sys.path.insert(0, self.paint_dir)
        # Diffusers/Transformers write dynamic-module caches; keep them in the runtime folder.
        os.environ.setdefault(
            "HF_MODULES_CACHE", str(Path(source_dir).parent / "hunyuan3d-hf-modules")
        )
        _stub_unneeded_modules()
        _use_native_opencv(source_dir)
        from diffusers import (
            AutoencoderKL,
            DDIMScheduler,
            UniPCMultistepScheduler,
        )
        from transformers import CLIPImageProcessor, CLIPTextModel, CLIPTokenizer

        pipeline_class, unet_class, dino_class = _load_hunyuanpaintpbr(self.paint_dir)
        root = Path(model_dir) / "hunyuan3d-paintpbr-v2-1"
        half = torch.float16
        unet = unet_class.from_pretrained(str(root / "unet"), torch_dtype=half)
        vae = AutoencoderKL.from_pretrained(str(root / "vae"), torch_dtype=half)
        text_encoder = CLIPTextModel.from_pretrained(str(root / "text_encoder"), torch_dtype=half)
        tokenizer = CLIPTokenizer.from_pretrained(str(root / "tokenizer"))
        extractor = CLIPImageProcessor.from_pretrained(str(root / "feature_extractor"))
        scheduler = DDIMScheduler.from_pretrained(str(root / "scheduler"))
        scheduler = UniPCMultistepScheduler.from_config(
            scheduler.config, timestep_spacing="trailing"
        )
        pipeline = pipeline_class(
            vae=vae,
            text_encoder=text_encoder,
            tokenizer=tokenizer,
            unet=unet,
            scheduler=scheduler,
            feature_extractor=extractor,
        )
        pipeline.set_progress_bar_config(disable=True)
        pipeline.eval()
        self.pipeline = pipeline.to(device)
        self.pipeline.view_size = VIEW_SIZE
        del unet, vae, text_encoder
        gc.collect()
        self.dino = dino_class(str(Path(model_dir) / "dinov2-giant")).to(half).to(device)
        self.upscaler = Upscaler(Path(model_dir) / "RealESRGAN_x4plus.pth", device)
        self.view_processor_class = _load_view_processor(self.paint_dir)
        gc.collect()

    def close(self):
        self.pipeline = None
        self.dino = None
        self.upscaler = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def load_texture_models(source_dir, model_dir, *, device="cuda"):
    return PaintModels(source_dir, model_dir, device=device)


# ---------------------------------------------------------------- generation


def _simplify(mesh):
    import trimesh

    mesh = trimesh.Trimesh(mesh.vertices, mesh.faces, process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    if len(mesh.faces) > SIMPLIFY_FACES:
        import fast_simplification

        points, faces = fast_simplification.simplify(
            np.ascontiguousarray(mesh.vertices, dtype=np.float32),
            np.ascontiguousarray(mesh.faces, dtype=np.int32),
            target_count=SIMPLIFY_FACES,
        )
        mesh = trimesh.Trimesh(points, faces, process=True)
        mesh.update_faces(mesh.nondegenerate_faces())
        mesh.remove_unreferenced_vertices()
    if not len(mesh.faces):
        raise RuntimeError("The mesh has no faces to texture.")
    return mesh


def _vertex_normals(vertices, faces):
    # Area-weighted; computed here because trimesh needs SciPy for its own version.
    corners = vertices[faces]
    face_normals = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    normals = np.zeros_like(vertices, dtype=np.float64)
    for column in range(3):
        np.add.at(normals, faces[:, column], face_normals)
    length = np.linalg.norm(normals, axis=1, keepdims=True)
    return (normals / np.maximum(length, 1e-12)).astype(np.float32)


def _unwrap(mesh):
    import xatlas

    mapping, faces, uvs = xatlas.parametrize(
        np.ascontiguousarray(mesh.vertices, dtype=np.float32),
        np.ascontiguousarray(mesh.faces, dtype=np.uint32),
    )
    return mapping.astype(np.int64), faces.astype(np.int32), uvs.astype(np.float32)


def _white_background(image):
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.getchannel("A"))
    return background


def _glb_from_arrays(vertices, normals, faces, uv, albedo, metallic, roughness):
    import trimesh
    from trimesh.visual.material import PBRMaterial

    albedo_image = Image.fromarray(albedo)
    # glTF packs roughness in green and metallic in blue of one texture.
    packed = np.stack([np.full_like(metallic, 255), roughness, metallic], axis=-1)
    material = PBRMaterial(
        baseColorTexture=albedo_image,
        metallicRoughnessTexture=Image.fromarray(packed),
        metallicFactor=1.0,
        roughnessFactor=1.0,
    )
    visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=faces,
        vertex_normals=normals,
        visual=visual,
        process=False,
    )
    return mesh


def _to_uint8(array):
    return (np.clip(array, 0.0, 1.0) * 255.0).round().astype(np.uint8)


def generate_texture(models, mesh, image, *, texture_size=2048, progress=None):
    """Return a textured trimesh for an untextured shape mesh and reference image."""
    if texture_size not in TEXTURE_SIZES:
        raise ValueError("Unsupported texture size.")
    import cv2

    say = progress or (lambda _message: None)
    from DifferentiableRenderer.MeshRender import MeshRender

    with torch.inference_mode():
        say("Preparing the mesh for texturing.")
        simplified = _simplify(mesh)
        mapping, faces, uv = _unwrap(simplified)
        vertices = np.asarray(simplified.vertices, dtype=np.float32)[mapping]
        normals = _vertex_normals(
            np.asarray(simplified.vertices, dtype=np.float64), np.asarray(simplified.faces)
        )[mapping]
        import trimesh

        wrapped = trimesh.Trimesh(vertices, faces, process=False)
        wrapped.visual.uv = uv

        # The renderer bakes at twice the final size and halves it, like upstream.
        render = MeshRender(
            default_resolution=2048,
            texture_size=texture_size * 2,
            bake_mode="back_sample",
            raster_mode="cr",
        )
        config = types.SimpleNamespace(bake_exp=4)
        views = models.view_processor_class(config, render)
        try:
            render.load_mesh(mesh=wrapped)
            say("Rendering guide views.")
            elevs, azims, weights = views.bake_view_selection(
                CANDIDATE_ELEVS, CANDIDATE_AZIMS, CANDIDATE_WEIGHTS, VIEW_COUNT
            )
            controls = views.render_normal_multiview(
                elevs, azims, use_abs_coor=True
            ) + views.render_position_multiview(elevs, azims)
            controls = [item.resize((VIEW_SIZE, VIEW_SIZE)) for item in controls]
            for index, item in enumerate(controls):
                if item.mode == "L":
                    controls[index] = item.point(lambda x: 255 if x > 1 else 0, mode="1")
            reference = _white_background(image).resize((VIEW_SIZE, VIEW_SIZE))

            say("Painting albedo and material views.")
            random.seed(0)
            np.random.seed(0)
            torch.manual_seed(0)
            count = len(controls) // 2
            pipeline = models.pipeline
            result = pipeline(
                [reference],
                num_inference_steps=DIFFUSION_STEPS,
                prompt="high quality",
                sync_condition=None,
                guidance_scale=3.0,
                generator=torch.Generator(device=pipeline.device).manual_seed(0),
                width=VIEW_SIZE,
                height=VIEW_SIZE,
                num_in_batch=count,
                images_normal=[controls[:count]],
                images_position=[controls[count:]],
                dino_hidden_states=models.dino(reference),
            ).images
            albedo_views, mr_views = result[:count], result[count:]

            say("Upscaling painted views.")
            size = render.default_resolution[0]
            albedo_views = [models.upscaler(item).resize((size, size)) for item in albedo_views]
            mr_views = [models.upscaler(item).resize((size, size)) for item in mr_views]

            say("Baking the texture.")
            texture, mask = views.bake_from_multiview(albedo_views, elevs, azims, weights)
            mask_np = (mask.squeeze(-1).cpu().numpy() * 255).astype(np.uint8)
            texture_mr, mask_mr = views.bake_from_multiview(mr_views, elevs, azims, weights)
            mask_mr_np = (mask_mr.squeeze(-1).cpu().numpy() * 255).astype(np.uint8)
            texture = views.texture_inpaint(texture, mask_np)
            render.set_texture(texture, force_set=True)
            texture_mr = views.texture_inpaint(texture_mr, mask_mr_np)
            render.set_texture_mr(texture_mr)

            say("Exporting the textured GLB.")
            baked_vertices, _faces, baked_uv, _uv_idx = render.get_mesh(normalize=False)
            albedo = render.get_texture()
            metallic, roughness = render.get_texture_mr()
            half = (texture_size, texture_size)
            albedo = cv2.resize(albedo, half, interpolation=cv2.INTER_AREA)
            metallic = cv2.resize(metallic[:, :, 0], half, interpolation=cv2.INTER_AREA)
            roughness = cv2.resize(roughness[:, :, 0], half, interpolation=cv2.INTER_AREA)
            return _glb_from_arrays(
                baked_vertices.astype(np.float32),
                normals,
                faces,
                baked_uv,
                _to_uint8(albedo),
                _to_uint8(metallic),
                _to_uint8(roughness),
            )
        finally:
            del render, views
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
