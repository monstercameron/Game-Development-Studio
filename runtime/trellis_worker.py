"""Isolated experimental TRELLIS.2 worker with serialized GPU operations."""

import argparse
import base64
import binascii
import ctypes
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
from host_memory import host_bytes_needed
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
from trellis_manifest import ROOT, missing_files
from worker_outputs import recovered_job

OUTPUTS = Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "trellis-outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
HOST_LOAD_BYTES = 8 * 1024**3
HOST_RENDER_BYTES = 12 * 1024**3
GPU_LOAD_BYTES = 4 * 1024**3
GPU_RENDER_BYTES = 24 * 1024**3
lock = threading.Lock()
state = {"phase": "idle", "error": None, "closing": False}
jobs = {}
model = None
stop_timer = None
app = FastAPI(title="Forge TRELLIS.2 512 worker (experimental)")
install_identity_endpoint(app, TOKEN, "3d-trellis")


class MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ulong),
        ("load", ctypes.c_ulong),
        ("total_phys", ctypes.c_ulonglong),
        ("available_phys", ctypes.c_ulonglong),
        ("total_page_file", ctypes.c_ulonglong),
        ("available_page_file", ctypes.c_ulonglong),
        ("total_virtual", ctypes.c_ulonglong),
        ("available_virtual", ctypes.c_ulonglong),
        ("available_extended_virtual", ctypes.c_ulonglong),
    ]


def check_memory(host_bytes, gpu_bytes):
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise RuntimeError("Could not check available system memory.")
    if status.available_phys < host_bytes_needed(host_bytes):
        raise RuntimeError(
            f"At least {host_bytes // 1024**3} GiB of available system memory is required."
        )
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required; CPU inference is disabled.")
    free, _ = torch.cuda.mem_get_info()
    if free < gpu_bytes:
        raise RuntimeError(
            f"At least {gpu_bytes // 1024**3} GiB of available GPU memory is required."
        )


def load_worker():
    global model
    try:
        check_memory(HOST_LOAD_BYTES, GPU_LOAD_BYTES)
        from trellis_toolchain import configure_toolchain

        configure_toolchain()
        from trellis_backend import load_trellis

        loaded = load_trellis()
        with lock:
            model = loaded
            state.update(phase="ready", error=None)
    except Exception as error:
        traceback.print_exc()
        gc.collect()
        with lock:
            state.update(phase="error", error=str(error)[:1500])


def render_worker(job_id, image, request):
    try:
        check_memory(HOST_RENDER_BYTES, GPU_RENDER_BYTES)
        from trellis_backend import generate_glb

        with lock:
            jobs[job_id].update(status="running", message="Generating textured 3D model.")
        temp = OUTPUTS / f".{job_id}.part"
        generate_glb(
            model,
            image,
            temp,
            seed=request.seed,
            steps=request.steps,
            texture_size=request.texture_size,
        )
        os.replace(temp, OUTPUTS / f"{job_id}.glb")
        with lock:
            jobs[job_id].update(status="completed", message="3D model ready.")
            state.update(phase="ready", error=None)
    except Exception as error:
        traceback.print_exc()
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready" if model is not None else "error", error=None)


class RenderRequest(BaseModel):
    image: str = Field(min_length=1, max_length=14_000_000)
    seed: int = Field(default=42, ge=0, le=2147483647)
    steps: int = Field(default=12, ge=1, le=50)
    texture_size: int = 1024


@app.get("/api/status")
def status():
    with lock:
        return {
            "engine": "forge-trellis2-512-experimental-v1",
            "phase": state["phase"],
            "loaded": model is not None,
            "model_downloaded": not missing_files(),
            "error": state["error"],
            "transparent_input_required": True,
        }


@app.post("/api/model/load", status_code=202)
def load():
    with lock:
        if state["closing"]:
            raise HTTPException(409, "TRELLIS.2 worker is stopping.")
        if model is not None:
            return {"message": "Already loaded."}
        if state["phase"] == "loading":
            return {"message": "Already loading."}
        if state["phase"] == "generating":
            raise HTTPException(409, "TRELLIS.2 worker is busy.")
        if missing_files():
            raise HTTPException(409, "TRELLIS.2 model files are missing.")
        state.update(phase="loading", error=None)
        threading.Thread(target=load_worker, daemon=True).start()
    return {"message": "Loading started."}


@app.post("/api/generate", status_code=202)
def generate(request: RenderRequest):
    if request.texture_size not in (512, 1024, 2048):
        raise HTTPException(400, "Unsupported texture size.")
    try:
        prefix, data = request.image.split(",", 1)
        if prefix not in ("data:image/png;base64", "data:image/webp;base64"):
            raise ValueError("Use a transparent PNG or WebP image.")
        raw = base64.b64decode(data, validate=True)
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError("Image is too large.")
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > 20_000_000:
                raise ValueError("Image dimensions are too large.")
            image = ImageOps.exif_transpose(source).convert("RGBA")
        alpha = image.getchannel("A")
        low, high = alpha.getextrema()
        if low == 255 or high <= 204:
            raise ValueError("A transparent background and visible foreground are required.")
    except (ValueError, binascii.Error, OSError) as error:
        raise HTTPException(400, f"Invalid reference image: {error}") from error
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            raise HTTPException(409, "TRELLIS.2 worker is busy.")
        if model is None:
            raise HTTPException(409, "Load the TRELLIS.2 model first.")
        job_id = uuid.uuid4().hex
        jobs[job_id] = {"id": job_id, "status": "queued", "message": "Waiting for 3D generation."}
        state.update(phase="generating", error=None)
        threading.Thread(target=render_worker, args=(job_id, image, request), daemon=True).start()
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "glb", "Recovered completed 3D model."
        )
        if job is None:
            raise HTTPException(404, "Job not found.")
        return dict(job)


@app.get("/api/jobs/{job_id}/mesh")
def mesh(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "glb", "Recovered completed 3D model."
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
            raise HTTPException(409, "TRELLIS.2 worker has active work.")
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
