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
from app_log import flush, get_logger, install_excepthook
from engine_identity import install_identity_endpoint
from fastapi import FastAPI, Header, HTTPException
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from host_memory import host_bytes_needed
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
from trellis_manifest import PIPELINE_TYPES, ROOT, missing_files, pipelines_available
from worker_outputs import recovered_job

OUTPUTS = Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "trellis-outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
HOST_LOAD_BYTES = 8 * 1024**3
GPU_LOAD_BYTES = 4 * 1024**3
MIN_TRANSPARENT_FRACTION = 0.01
# Render budgets in GiB (host, GPU) per pipeline; keep in step with trellis-preparation.js. Only the
# 512 pipeline has any measurement behind it. The others are generous guesses for a large GPU,
# and host memory is only a soft floor (see host_memory.py).
PIPELINE_BUDGETS_GIB = {
    "512": (12, 24),
    "1024": (18, 40),
    "1024_cascade": (18, 48),
    "1536_cascade": (20, 64),
}
log = get_logger("three-d")
lock = threading.Lock()
state = {"phase": "idle", "error": None, "closing": False}
jobs = {}
model = None
stop_timer = None
app = FastAPI(title="Forge TRELLIS.2 512 worker (experimental)")
install_identity_endpoint(app, TOKEN, "3d-trellis")


def log_request_rejected(route, reason):
    log.warn("three-d.request.rejected", {"route": route, "reason": reason})


@app.exception_handler(RequestValidationError)
async def handle_schema_rejected(request, exc):
    log.warn("three-d.request.rejected", {"reason": "schema_invalid", "count": len(exc.errors())})
    return await request_validation_exception_handler(request, exc)


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
    """Raise RuntimeError unless the host and GPU byte budgets are free.

    host_bytes goes through host_bytes_needed first, and gpu_bytes is compared with
    the CUDA free memory reported by torch. CUDA is required; there is no CPU fallback.
    """
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
        log.info("three-d.model.load.started")
        check_memory(HOST_LOAD_BYTES, GPU_LOAD_BYTES)
        from trellis_toolchain import configure_toolchain

        configure_toolchain()
        from trellis_backend import load_trellis

        stop = log.time("three-d.model.load.completed")
        loaded = load_trellis()
        with lock:
            model = loaded
            state.update(phase="ready", error=None)
        stop()
    except Exception as error:
        log.error("three-d.model.load.failed", {"errorClass": type(error).__name__})
        traceback.print_exc()
        gc.collect()
        with lock:
            state.update(phase="error", error=str(error)[:1500])


def render_worker(job_id, image, request):
    try:
        host_gib, gpu_gib = PIPELINE_BUDGETS_GIB[request.pipeline]
        check_memory(host_gib * 1024**3, gpu_gib * 1024**3)
        from trellis_backend import generate_glb

        log.info("three-d.job.started", {"jobId": job_id})
        stop = log.time("three-d.job.completed", {"jobId": job_id})

        def report(message):
            with lock:
                jobs[job_id].update(message=message)

        with lock:
            jobs[job_id].update(
                status="running",
                message=(
                    "Generating textured 3D model."
                    if request.pipeline == "512"
                    else f"Generating textured 3D model ({request.pipeline} pipeline)."
                ),
            )
        partial_path = OUTPUTS / f".{job_id}.part"
        generate_glb(
            model,
            image,
            partial_path,
            seed=request.seed,
            steps=request.steps,
            texture_size=request.texture_size,
            target_faces=request.target_faces,
            pipeline_type=request.pipeline,
            report=report,
        )
        os.replace(partial_path, OUTPUTS / f"{job_id}.glb")
        log.debug("three-d.file.written", {"kind": "output"})
        with lock:
            jobs[job_id].update(status="completed", message="3D model ready.")
            state.update(phase="ready", error=None)
        stop({"outcome": "completed"})
    except Exception as error:
        log.error("three-d.job.failed", {"jobId": job_id, "errorClass": type(error).__name__})
        traceback.print_exc()
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready" if model is not None else "error", error=None)


class RenderRequest(BaseModel):
    image: str = Field(min_length=1, max_length=14_000_000)
    seed: int = Field(default=42, ge=0, le=2147483647)
    steps: int = Field(default=12, ge=1, le=50)
    texture_size: int = 1024
    # Triangles in the exported mesh (upstream decimation target); upstream defaults to 1,000,000.
    target_faces: int = Field(default=100000, ge=5000, le=1_000_000)
    # 512 is the original pipeline; the others need extra checkpoints (see pipelines_available).
    pipeline: str = "512"


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
            "pipelines_available": pipelines_available(),
        }


@app.post("/api/model/load", status_code=202)
def load():
    with lock:
        if state["closing"]:
            log_request_rejected("/api/model/load", "closing")
            raise HTTPException(409, "TRELLIS.2 worker is stopping.")
        if model is not None:
            return {"message": "Already loaded."}
        if state["phase"] == "loading":
            return {"message": "Already loading."}
        if state["phase"] == "generating":
            log_request_rejected("/api/model/load", "busy")
            raise HTTPException(409, "TRELLIS.2 worker is busy.")
        if missing_files():
            log_request_rejected("/api/model/load", "model_files_missing")
            raise HTTPException(409, "TRELLIS.2 model files are missing.")
        state.update(phase="loading", error=None)
        threading.Thread(target=load_worker, daemon=True).start()
    return {"message": "Loading started."}


@app.post("/api/generate", status_code=202)
def generate(request: RenderRequest):
    if request.texture_size not in (512, 1024, 2048):
        log_request_rejected("/api/generate", "unsupported_texture_size")
        raise HTTPException(400, "Unsupported texture size.")
    if request.pipeline not in PIPELINE_TYPES:
        log_request_rejected("/api/generate", "unsupported_pipeline")
        raise HTTPException(400, "Unsupported pipeline.")
    # The 512 checkpoints are required to load the model at all, so only the others need a check.
    if request.pipeline != "512" and request.pipeline not in pipelines_available():
        log_request_rejected("/api/generate", "pipeline_not_installed")
        raise HTTPException(
            400, f"The {request.pipeline} pipeline's checkpoints are not installed."
        )
    try:
        prefix, encoded = request.image.split(",", 1)
        if prefix not in ("data:image/png;base64", "data:image/webp;base64"):
            raise ValueError("Use a transparent PNG or WebP image.")
        raw = base64.b64decode(encoded, validate=True)
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
        # An alpha channel that is almost fully opaque is a flattened picture; TRELLIS.2 would
        # treat the whole frame as the object and return a block.
        transparent = sum(alpha.histogram()[:128]) / (image.width * image.height)
        if transparent < MIN_TRANSPARENT_FRACTION:
            raise ValueError(
                "The image has no real transparent background (under 1% of its pixels are "
                "transparent). Cut the object out first, for example with Segmentation."
            )
    except (ValueError, binascii.Error, OSError) as error:
        log.warn(
            "three-d.request.rejected",
            {
                "route": "/api/generate",
                "reason": "invalid_image",
                "errorClass": type(error).__name__,
            },
        )
        raise HTTPException(400, f"Invalid reference image: {error}") from error
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            log_request_rejected("/api/generate", "busy")
            raise HTTPException(409, "TRELLIS.2 worker is busy.")
        if model is None:
            log_request_rejected("/api/generate", "model_not_loaded")
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
            log.info("three-d.process.stopped", {"reason": "stop_requested"})
            flush()
            os._exit(0)


@app.post("/api/forge/{action}")
def control(action: str, x_forge_engine_token: str = Header(default="")):
    global stop_timer
    if not TOKEN or not hmac.compare_digest(TOKEN, x_forge_engine_token):
        log_request_rejected("/api/forge/:action", "forbidden")
        raise HTTPException(403, "Forbidden.")
    with lock:
        if action == "resume":
            if stop_timer:
                stop_timer.cancel()
                stop_timer = None
            state["closing"] = False
            return {"resumed": True}
        if action != "stop":
            log_request_rejected("/api/forge/:action", "unknown_action")
            raise HTTPException(404, "Not found.")
        if state["phase"] in ("loading", "generating"):
            log_request_rejected("/api/forge/:action", "busy")
            raise HTTPException(409, "TRELLIS.2 worker has active work.")
        state["closing"] = True
        log.info("three-d.process.stop.requested")
        if stop_timer is None:
            stop_timer = threading.Timer(1, finish_stop)
            stop_timer.daemon = True
            stop_timer.start()
        return {"stopping": True}


if __name__ == "__main__":
    install_excepthook("three-d")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    log.info("three-d.process.started", {"port": args.port})
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
