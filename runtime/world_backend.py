"""Run one isolated CUDA world render and exit to release model memory."""

import argparse
import gc
import json
import os
import re
import shutil
import sys
from pathlib import Path

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
    print(message, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args()
    request_file = Path(args.request).resolve()
    work = request_file.parent
    request = json.loads(request_file.read_text(encoding="utf-8"))
    # Initialize CUDA and model dependencies only in this spawned render process.
    import torch

    if not torch.cuda.is_available() or not torch.version.cuda:
        raise RuntimeError(
            "CUDA is unavailable in this world generator environment. CPU rendering is disabled."
        )
    print(f"Using CUDA: {torch.cuda.get_device_name(0)}", flush=True)
    target = work / "result.part.ply"
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
            pano_gen.gen_pano_image = partial(
                pano_gen.gen_pano_image,
                seed=request.get("seed", 42),
                num_inference_steps=request.get("steps", 50),
            )
            pano_gen.gen_pano_fill_image = partial(
                pano_gen.gen_pano_fill_image,
                seed=request.get("seed", 42),
                num_inference_steps=request.get("steps", 50),
            )
        generator = WorldGen(
            mode={"text": "t2s", "image": "i2s", "panorama": "pano"}[mode],
            resolution=request["resolution"],
            device=torch.device("cuda"),
            low_vram=False,
        )
        with torch.inference_mode():
            if mode == "panorama":
                image = (
                    Image.open(images[0])
                    .convert("RGB")
                    .resize((request["resolution"], request["resolution"] // 2))
                )
                image.save(work / "panorama.png")
                report_stage(work, "Estimating depth and building the 3D world.")
                scene = generator._generate_world(image, return_mesh=request["output"] == "mesh")
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
                scene = generator._generate_world(panorama, return_mesh=request["output"] == "mesh")
        report_stage(work, "Saving the world to your project.")
        if request["output"] == "mesh":
            scene.export(str(target), file_type="ply")
        else:
            scene.save(str(target))
    elif request["model"] == "hy-world":
        root = Path.home() / "Desktop" / "HY-World-2.0" / "compat-port"
        repo = root / "HY-World-2.0"
        sys.path.insert(0, str(repo))
        os.chdir(repo)
        from hyworld2.worldrecon.pipeline import WorldMirrorPipeline

        weights = root / "weights"
        if not (weights / "HY-WorldMirror-2.0" / "model.safetensors").is_file():
            raise RuntimeError(
                "HY-WorldMirror model weights are missing from HY-World-2.0/compat-port/weights."
            )
        inputs = work / "views"
        inputs.mkdir(exist_ok=True)
        for index, image in enumerate(images):
            shutil.copyfile(image, inputs / f"{index:03d}.png")
        model = WorldMirrorPipeline.from_pretrained(str(weights), enable_bf16=True)
        report_stage(work, "Reconstructing the scene from your reference views.")
        with torch.inference_mode():
            out = model(
                str(inputs),
                strict_output_path=str(work / "reconstruction"),
                target_size=request["resolution"],
                apply_sky_mask=False,
                apply_edge_mask=True,
                apply_confidence_mask=True,
                save_rendered=False,
                compress_gs_max_points=1_000_000,
            )
        if not out:
            raise RuntimeError("HY-World did not produce a reconstruction.")
        generated = Path(out) / "gaussians.ply"
        if not generated.is_file():
            raise RuntimeError("HY-World did not produce a Gaussian splat file.")
        report_stage(work, "Saving the world to your project.")
        shutil.copyfile(generated, target)
    else:
        raise RuntimeError("Unsupported world generator.")
    if not target.is_file() or not target.stat().st_size:
        raise RuntimeError("The generator produced an empty world.")
    os.replace(target, work / "result.ply")
    print("World render complete.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = re.sub(r"hf_[A-Za-z0-9]+", "[redacted]", str(error))[:1500]
        if "--request" in sys.argv:
            try:
                (
                    Path(sys.argv[sys.argv.index("--request") + 1]).resolve().parent / "error.txt"
                ).write_text(message, encoding="utf-8")
            except Exception:
                pass
        raise
