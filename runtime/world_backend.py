"""Run one isolated CUDA world render and exit to release model memory."""

import argparse
import contextlib
import gc
import json
import os
import re
import shutil
import sys
from pathlib import Path

from app_log import get_logger

log = get_logger("world")

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ["HYWORLD_DEVICE"] = "cuda"
# Never initiate a large gated model download as a side effect of a render.
os.environ["HF_HUB_OFFLINE"] = "1"


def report_stage(work, message):
    # The worker reads the atomic snapshot while this process is busy on CUDA.
    temporary = work / "stage.tmp"
    temporary.write_text(message, encoding="utf-8")
    os.replace(temporary, work / "stage.txt")
    log.debug("world.file.written", {"kind": "stage", "bytes": len(message.encode("utf-8"))})
    print(message, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    request_file = Path(args.request).resolve()
    work = request_file.parent
    request = json.loads(request_file.read_text(encoding="utf-8"))
    stop_render = log.time("world.render.completed", {"modelId": request["model"]})
    # Initialize CUDA and model dependencies only in this spawned render process.
    import torch

    if not torch.cuda.is_available() or not torch.version.cuda:
        raise RuntimeError(
            "CUDA is unavailable in this world generator environment. CPU rendering is disabled."
        )
    print(f"Using CUDA: {torch.cuda.get_device_name(0)}", flush=True)
    # A mesh can be written as a game-ready GLB; everything else is a PLY.
    extension = "glb" if request["output"] == "glb" else "ply"
    target = work / f"result.part.{extension}"
    images = [work / ("input-" + str(index) + ".png") for index in range(request["image_count"])]
    report_stage(work, "Loading the CUDA world generator.")
    if request["model"] == "worldgen":
        # Import only the selected model stack inside the CUDA worker process.
        from PIL import Image
        from worldgen.worldgen import WorldGen

        mode = request["mode"]
        if mode in ("text", "image"):
            # This installed WorldGen port passes a local safetensors filename
            # directly. Current diffusers requires an explicit weight_name in
            # offline mode, even for that path. Adapt only these two pipelines.
            from functools import partial

            from world_lora import support_offline_lora
            from worldgen import pano_gen

            for pipeline_class in (pano_gen.FluxPipeline, pano_gen.FluxFillPipeline):
                support_offline_lora(pipeline_class)
            if mode == "image":
                # This Windows port incorrectly assigns spherical rays to a
                # perspective photo. That empties/distorts the conditioning
                # mask and can discard the reference entirely.
                import worldgen.worldgen as worldgen_module
                from world_perspective import install_perspective_projection

                install_perspective_projection(worldgen_module, torch)
            # The Q5 text model completed a CUDA world render with substantially
            # less Windows commit pressure. Keep the original full precision
            # path available if the local quantized checkpoint is absent.
            quantized_path = (
                Path(__file__).resolve().parent.parent
                / "models"
                / "worldgen"
                / ("flux1-dev-Q5_0.gguf" if mode == "text" else "flux1-fill-dev-Q5_0.gguf")
            )
            quantized_enabled = mode in ("text", "image")
            if (
                quantized_enabled
                and quantized_path.is_file()
                and os.environ.get("FORGE_WORLDGEN_FULL_PRECISION") != "1"
            ):
                from diffusers import FluxTransformer2DModel, GGUFQuantizationConfig

                pipeline_class = (
                    pano_gen.FluxPipeline if mode == "text" else pano_gen.FluxFillPipeline
                )
                base_model = (
                    "black-forest-labs/FLUX.1-dev"
                    if mode == "text"
                    else "black-forest-labs/FLUX.1-Fill-dev"
                )
                original_from_pretrained = pipeline_class.from_pretrained

                def load_quantized_pipeline(source, *args, **kwargs):
                    print("Loading Q5 WorldGen transformer.", flush=True)
                    kwargs["transformer"] = FluxTransformer2DModel.from_single_file(
                        str(quantized_path),
                        config=base_model,
                        subfolder="transformer",
                        quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
                        torch_dtype=torch.bfloat16,
                        local_files_only=True,
                    )
                    return original_from_pretrained(source, *args, **kwargs)

                pipeline_class.from_pretrained = load_quantized_pipeline
            # FLUX guidance is optional: leave the upstream defaults (7 for text,
            # 30 for the fill model) in place unless the request sets one.
            guidance = (
                {} if request.get("guidance") is None else {"guidance_scale": request["guidance"]}
            )
            pano_gen.gen_pano_image = partial(
                pano_gen.gen_pano_image,
                seed=request.get("seed", 42),
                num_inference_steps=request.get("steps", 50),
                **guidance,
            )
            pano_gen.gen_pano_fill_image = partial(
                pano_gen.gen_pano_fill_image,
                seed=request.get("seed", 42),
                num_inference_steps=request.get("steps", 50),
                **guidance,
            )
        log.info("world.model.load.started", {"modelId": request["model"]})
        stop_load = log.time("world.model.load.completed", {"modelId": request["model"]})
        try:
            generator = WorldGen(
                mode={"text": "t2s", "image": "i2s", "panorama": "pano"}[mode],
                resolution=request["resolution"],
                device=torch.device("cuda"),
                low_vram=False,
            )
        except Exception as error:
            log.error(
                "world.model.load.failed",
                {"modelId": request["model"], "errorClass": type(error).__name__},
            )
            raise
        stop_load()
        log.info("world.generation.started", {"modelId": request["model"]})
        with torch.inference_mode():
            if mode == "panorama":
                image = (
                    Image.open(images[0])
                    .convert("RGB")
                    .resize((request["resolution"], request["resolution"] // 2))
                )
                image.save(work / "panorama.png")
                report_stage(work, "Estimating depth and building the 3D world.")
                scene = generator._generate_world(image, return_mesh=request["output"] != "splat")
            else:
                image = Image.open(images[0]).convert("RGB") if mode == "image" else None
                report_stage(
                    work,
                    "Generating the panorama from your reference."
                    if mode == "image"
                    else "Generating the panorama from your description.",
                )
                panorama = generator.generate_pano(request["prompt"], image)
                # The Windows image adapter remaps to a fixed 2048px panorama;
                # honor the chosen output resolution before depth inference.
                if panorama.size != (request["resolution"], request["resolution"] // 2):
                    panorama = panorama.resize(
                        (request["resolution"], request["resolution"] // 2),
                        Image.Resampling.LANCZOS,
                    )
                panorama.save(work / "panorama.png")
                # The FLUX model is no longer needed once the panorama exists.
                # Release its CPU and GPU allocations before the depth pass.
                del generator.pano_gen_model
                gc.collect()
                torch.cuda.empty_cache()
                report_stage(work, "Estimating depth and building the 3D world.")
                scene = generator._generate_world(
                    panorama, return_mesh=request["output"] != "splat"
                )
        report_stage(work, "Saving the world to your project.")
        if request["output"] != "splat":
            scene.export(str(target), file_type=extension)
        else:
            scene.save(str(target))
    elif request["model"] == "hy-world":
        root = Path.home() / "Desktop" / "HY-World-2.0" / "compat-port"
        repo = root / "HY-World-2.0"
        sys.path.insert(0, str(repo))
        os.chdir(repo)
        from hyworld2.worldrecon.pipeline import WorldMirrorPipeline
        from world_views import Tee, normalize_views, skip_reason

        weights = Path(os.environ.get("FORGE_HYWORLD_WEIGHTS", str(root / "weights")))
        if not (weights / "HY-WorldMirror-2.0" / "model.safetensors").is_file():
            raise RuntimeError(f"HY-WorldMirror model weights are missing from {weights}.")
        inputs = work / "views"
        inputs.mkdir(exist_ok=True)
        prior_cameras = None
        if request["mode"] == "panorama":
            # The port's helper cuts a 360-degree panorama into eight 90-degree views taken
            # from one point and writes their exact cameras, which WorldMirror accepts as priors.
            sys.path.insert(0, str(root))
            from pano3d import split_panorama

            report_stage(work, "Cutting the panorama into views.")
            _, prior_cameras = split_panorama(
                images[0], work / "panorama-views", n_views=8, size=request["resolution"]
            )
            inputs = work / "panorama-views" / "images"
        else:
            # WorldMirror only accepts views of one shape; differing views are centre-cropped.
            cropped = normalize_views(images, inputs)
            if cropped:
                print(f"Cropped views {cropped} to the first view's proportions.", flush=True)
        log.info("world.model.load.started", {"modelId": request["model"]})
        stop_load = log.time("world.model.load.completed", {"modelId": request["model"]})
        try:
            model = WorldMirrorPipeline.from_pretrained(str(weights), enable_bf16=True)
        except Exception as error:
            log.error(
                "world.model.load.failed",
                {"modelId": request["model"], "errorClass": type(error).__name__},
            )
            raise
        stop_load()
        report_stage(work, "Reconstructing the scene from your reference views.")
        console_tee = Tee(sys.stdout)
        log.info("world.generation.started", {"modelId": request["model"]})
        with torch.inference_mode(), contextlib.redirect_stdout(console_tee):
            out = model(
                str(inputs),
                strict_output_path=str(work / "reconstruction"),
                target_size=request["resolution"],
                prior_cam_path=prior_cameras,
                apply_sky_mask=request.get("remove_sky", False),
                apply_edge_mask=True,
                apply_confidence_mask=request.get("confidence_percentile", 10) > 0,
                confidence_percentile=request.get("confidence_percentile", 10),
                save_rendered=False,
                compress_gs_max_points=request.get("splat_limit", 1_000_000),
            )
        if not out:
            # The pipeline only prints why it skipped the scene; say it in the error.
            raise RuntimeError(
                skip_reason(console_tee.text) or "HY-World did not produce a reconstruction."
            )
        generated = Path(out) / "gaussians.ply"
        if not generated.is_file():
            raise RuntimeError("HY-World did not produce a Gaussian splat file.")
        report_stage(work, "Saving the world to your project.")
        shutil.copyfile(generated, target)
    else:
        raise RuntimeError("Unsupported world generator.")
    if not target.is_file() or not target.stat().st_size:
        raise RuntimeError("The generator produced an empty world.")
    os.replace(target, work / f"result.{extension}")
    stop_render()
    print("World render complete.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = re.sub(r"hf_[A-Za-z0-9]+", "[redacted]", str(error))[:1500]
        log.error("world.render.failed", {"errorClass": type(error).__name__})
        if "--request" in sys.argv:
            try:
                (
                    Path(sys.argv[sys.argv.index("--request") + 1]).resolve().parent / "error.txt"
                ).write_text(message, encoding="utf-8")
            except Exception as write_error:
                log.warn(
                    "world.error.file.write.failed",
                    {"errorClass": type(write_error).__name__},
                )
        raise
