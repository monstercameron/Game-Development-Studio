"""Isolated Hunyuan3D shape worker with an optional texture stage.

Forge manages admission and the queue."""

import argparse
import base64
import binascii
import gc
import hmac
import io
import os
import threading
import traceback
import uuid
from pathlib import Path

import uvicorn
from engine_identity import install_identity_endpoint
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
from worker_outputs import recovered_job

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(os.environ.get("FORGE_HUNYUAN_SOURCE", ROOT / ".forge-runtime" / "hunyuan3d-src"))
MODEL = Path(os.environ.get("FORGE_HUNYUAN_MODEL", ROOT / "models" / "Hunyuan3D-2.1"))
OUTPUTS = Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "hunyuan-outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
lock = threading.Lock()
state = {"phase": "idle", "error": None, "closing": False}
jobs = {}
model = None
stop_timer = None
app = FastAPI(title="Forge Hunyuan3D shape worker")
install_identity_endpoint(app, TOKEN, "3d-hunyuan")


def files_ready():
    return all(
        (MODEL / "hunyuan3d-dit-v2-1" / item).is_file()
        for item in ("config.yaml", "model.fp16.ckpt")
    )


def load_worker():
    global model
    try:
        from hunyuan_backend import load_shape

        loaded = load_shape(SOURCE, MODEL)
        with lock:
            model = loaded
            state.update(phase="ready", error=None)
    except Exception as error:
        traceback.print_exc()
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        with lock:
            state.update(phase="error", error=str(error)[:1500])


def release_gpu_cache():
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def texture_ready():
    try:
        from hunyuan_paint_backend import native_modules_ready, texture_files_ready

        return texture_files_ready(MODEL) and native_modules_ready(SOURCE)
    except Exception:
        return False


def set_message(job_id, message):
    with lock:
        jobs[job_id].update(message=message)


def paint_mesh(job_id, mesh, image, request):
    # Texture models are loaded for this job and released afterwards so the
    # idle worker keeps only the shape model resident.
    from hunyuan_paint_backend import SIMPLIFY_FACES, generate_texture, load_texture_models

    release_gpu_cache()
    set_message(job_id, "Loading texture models.")
    models = load_texture_models(SOURCE, MODEL)
    try:
        return generate_texture(
            models,
            mesh,
            image,
            texture_size=request.texture_size,
            progress=lambda message: set_message(job_id, message),
            view_count=request.texture_views,
            view_size=request.texture_view_size,
            target_faces=request.target_faces or SIMPLIFY_FACES,
        )
    finally:
        models.close()
        del models
        gc.collect()


def render_worker(job_id, image, request):
    try:
        from hunyuan_backend import generate_shape, reduce_faces

        with lock:
            jobs[job_id].update(status="running", message="Generating 3D shape.")
        mesh = generate_shape(
            model,
            image,
            seed=request.seed,
            steps=request.steps,
            resolution=request.resolution,
            guidance_scale=request.guidance_scale,
        )
        done = "3D shape ready."
        if request.texture:
            mesh = paint_mesh(job_id, mesh, image, request)
            done = "Textured 3D model ready."
        elif request.target_faces:
            set_message(job_id, f"Reducing the mesh to about {request.target_faces:,} triangles.")
            mesh = reduce_faces(mesh, request.target_faces)
        temp = OUTPUTS / f".{job_id}.part"
        mesh.export(str(temp), file_type="glb")
        os.replace(temp, OUTPUTS / f"{job_id}.glb")
        with lock:
            jobs[job_id].update(status="completed", message=done)
            state.update(phase="ready", error=None)
    except Exception as error:
        traceback.print_exc()
        release_gpu_cache()
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready" if model is not None else "error", error=None)


class ShapeRequest(BaseModel):
    image: str = Field(min_length=1, max_length=14_000_000)
    seed: int = Field(default=123, ge=0, le=2147483647)
    steps: int = Field(default=30, ge=1, le=100)
    resolution: int = 128
    # Classifier-free guidance; upstream's default for Hunyuan3D 2.1 is 5.0.
    guidance_scale: float = Field(default=5.0, ge=1.0, le=20.0)
    # Triangle budget. None keeps the raw mesh for shape-only jobs and means 40,000 when painting.
    target_faces: int | None = Field(default=None, ge=1000, le=1_000_000)
    texture: bool = False
    texture_size: int = 2048
    # Advanced painter knobs, offered in the studio with that warning: 8 views at 768 px gave no
    # visible improvement over the default 6 views at 512 px, took twice as long and used about
    # 15 GB more GPU memory (jobs 6548ec69 and f9c52766, 2026-11-07).
    texture_views: int = 6
    texture_view_size: int = 512


@app.get("/api/status")
def status():
    with lock:
        return {
            "engine": "forge-hunyuan-shape-v1",
            "phase": state["phase"],
            "loaded": model is not None,
            "model_downloaded": files_ready(),
            "texture_available": texture_ready(),
            "error": state["error"],
        }


@app.post("/api/model/load", status_code=202)
def load():
    with lock:
        if state["closing"]:
            raise HTTPException(409, "Shape worker is stopping.")
        if model is not None:
            return {"message": "Already loaded."}
        if state["phase"] == "loading":
            return {"message": "Already loading."}
        if state["phase"] == "generating":
            raise HTTPException(409, "Shape worker is busy.")
        if not files_ready():
            raise HTTPException(409, "Shape model files are missing.")
        state.update(phase="loading", error=None)
        threading.Thread(target=load_worker, daemon=True).start()
    return {"message": "Loading started."}


@app.post("/api/generate", status_code=202)
def generate(request: ShapeRequest):
    if request.resolution not in (128, 256, 384):
        raise HTTPException(400, "Unsupported mesh resolution.")
    if request.texture_size not in (1024, 2048):
        raise HTTPException(400, "Unsupported texture size.")
    if request.texture_views not in (6, 7, 8, 9) or request.texture_view_size not in (512, 768):
        raise HTTPException(400, "Unsupported number of painted views or view size.")
    if request.texture and not texture_ready():
        raise HTTPException(
            409, "Texture models or native helpers are missing; install them or turn texture off."
        )
    try:
        prefix, data = request.image.split(",", 1)
        if prefix not in (
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/webp;base64",
        ):
            raise ValueError("Unsupported image.")
        raw = base64.b64decode(data, validate=True)
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError("Image is too large.")
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > 20_000_000:
                raise ValueError("Image dimensions are too large.")
            image = ImageOps.exif_transpose(source).convert("RGBA")
    except (ValueError, binascii.Error, OSError) as error:
        raise HTTPException(400, f"Invalid reference image: {error}") from error
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            raise HTTPException(409, "Shape worker is busy.")
        if model is None:
            raise HTTPException(409, "Load the shape model first.")
        job_id = uuid.uuid4().hex
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Waiting for shape generation.",
        }
        state.update(phase="generating", error=None)
        threading.Thread(target=render_worker, args=(job_id, image, request), daemon=True).start()
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "glb", "Recovered completed 3D shape."
        )
        if job is None:
            raise HTTPException(404, "Job not found.")
        return dict(job)


@app.get("/api/jobs/{job_id}/mesh")
def mesh(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "glb", "Recovered completed 3D shape."
        )
        if job is None or job["status"] != "completed":
            raise HTTPException(404, "Mesh not found.")
    return FileResponse(OUTPUTS / f"{job_id}.glb", media_type="model/gltf-binary")


def finish_stop():
    with lock:
        if state["closing"]:
            os._exit(0)


@app.post("/api/forge/{action}")
def control(action: str, x_forge_engine_token: str = Header(default="")):
    global stop_timer
    if not TOKEN or not hmac.compare_digest(TOKEN, x_forge_engine_token):
        raise HTTPException(403, "Forbidden.")
    with lock:
        if action == "resume":
            if stop_timer:
                stop_timer.cancel()
                stop_timer = None
            state["closing"] = False
            return {"resumed": True}
        if action != "stop":
            raise HTTPException(404, "Not found.")
        if state["phase"] in ("loading", "generating"):
            raise HTTPException(409, "Shape worker has active work.")
        state["closing"] = True
        if stop_timer is None:
            stop_timer = threading.Timer(1, finish_stop)
            stop_timer.daemon = True
            stop_timer.start()
        return {"stopping": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
