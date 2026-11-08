"""Isolated HY-Motion 1.0 text-to-BVH worker."""

import argparse
import ctypes
import gc
import hmac
import json
import logging
import os
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / ".forge-runtime" / "hymotion-packages"))
from app_log import flush, get_logger, install_excepthook  # noqa: E402
from engine_identity import install_identity_endpoint  # noqa: E402
from host_memory import host_bytes_needed  # noqa: E402
from worker_outputs import recovered_job  # noqa: E402

SOURCE = Path(os.environ.get("FORGE_HYMOTION_SOURCE", ROOT / ".forge-runtime" / "hy-motion-src"))
MODEL = Path(os.environ.get("FORGE_HYMOTION_MODEL", ROOT / "models" / "HY-Motion"))
MODEL_ID = "HY-Motion-1.0"
OUTPUTS = Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "hymotion-outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
# Weights are local under models/; a missing file must fail the load, not start a download.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
app = FastAPI(title="Forge HY-Motion worker")
install_identity_endpoint(app, TOKEN, "motion-hy")
lock = threading.Lock()
state = {"phase": "idle", "error": None, "closing": False}
jobs = {}
model = None
stop_timer = None
logger = logging.getLogger(__name__)
log = get_logger("motion")


def elapsed_ms(started_at):
    """Milliseconds since a time.perf_counter() reading, for durationMs fields."""
    return round((time.perf_counter() - started_at) * 1000)


def log_lifecycle(event, *, job_id, started_at, error=None):
    """Log fixed lifecycle metadata without request content or error details."""
    fields = {
        "engine": "forge-hy-motion-v1",
        "event": event,
        "job_id": job_id,
        "elapsed_ms": max(0, round((time.perf_counter() - started_at) * 1000)),
    }
    if error is not None:
        fields["exception_class"] = type(error).__name__
        fields["traceback_frames"] = sanitized_traceback_frames(error)
    logger.info(json.dumps(fields, ensure_ascii=True, separators=(",", ":"), sort_keys=True))


def sanitized_traceback_frames(error):
    """Return stack locations only, without source lines, paths, or exception text."""
    frames = []
    current = error.__traceback__
    while current is not None:
        code = current.tb_frame.f_code
        frames.append(
            {
                "file": code.co_filename.replace("\\", "/").rsplit("/", 1)[-1],
                "function": code.co_name,
                "line": current.tb_lineno,
            }
        )
        current = current.tb_next
    return frames[-8:]


def files_ready():
    paths = [MODEL / "HY-Motion-1.0" / name for name in ("config.yml", "latest.ckpt")]
    paths += [
        MODEL / "Qwen3-8B" / name
        for name in (
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
            "model.safetensors.index.json",
        )
    ]
    paths += [
        MODEL / "Qwen3-8B" / f"model-{index:05d}-of-00005.safetensors" for index in range(1, 6)
    ]
    paths += [
        MODEL / "clip-vit-large-patch14" / name
        for name in ("config.json", "model.safetensors", "vocab.json", "merges.txt")
    ]
    paths += [SOURCE / "stats" / name for name in ("Mean.npy", "Std.npy")]
    paths += [
        SOURCE / "scripts/gradio/static/assets/dump_wooden" / name
        for name in (
            "j_template.bin",
            "v_template.bin",
            "kintree.bin",
            "faces.bin",
            "skinIndice.bin",
            "skinWeights.bin",
            "joint_names.json",
        )
    ]
    return all(path.is_file() for path in paths)


def free_host_memory():
    """Return available physical memory in bytes; raise RuntimeError if it cannot be measured."""
    if os.name == "nt":

        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("load", ctypes.c_ulong),
                ("total_physical", ctypes.c_ulonglong),
                ("available_physical", ctypes.c_ulonglong),
                ("total_pagefile", ctypes.c_ulonglong),
                ("available_pagefile", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("available_virtual", ctypes.c_ulonglong),
                ("available_extended_virtual", ctypes.c_ulonglong),
            ]

        info = MemoryStatus()
        info.length = ctypes.sizeof(info)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(info)):
            raise RuntimeError("Available system memory could not be measured.")
        return info.available_physical
    try:
        return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError) as error:
        raise RuntimeError("Available system memory could not be measured.") from error


def require_memory(*, loading, duration=3):
    # Budgets in GiB are admission estimates, not measured peak usage.
    host_gib, gpu_gib = (9, 28) if loading else ((4, 10) if duration <= 5 else (6, 18))
    if free_host_memory() < host_bytes_needed(host_gib * 1024**3):
        raise RuntimeError(f"At least {host_gib} GiB of free system memory is required.")
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable in the HY-Motion runtime.")
    try:
        free, _ = torch.cuda.mem_get_info()
    except Exception as error:
        raise RuntimeError("Free GPU memory could not be measured.") from error
    if free < gpu_gib * 1024**3:
        raise RuntimeError(f"At least {gpu_gib} GiB of free GPU memory is required.")


def clear_cuda_cache():
    torch = sys.modules.get("torch")
    try:
        if torch is not None and torch.cuda.is_initialized():
            torch.cuda.empty_cache()
    except Exception as error:
        log.debug("motion.cuda.cache.clear.failed", {"errorClass": type(error).__name__})


def load_worker(job_id=None):
    global model
    job_id = job_id or uuid.uuid4().hex
    started_at = time.perf_counter()
    log_lifecycle("model_load_started", job_id=job_id, started_at=started_at)
    log.info("motion.model.load.started", {"modelId": MODEL_ID})
    pipeline = None
    try:
        require_memory(loading=True)
        from hymotion_backend import load_motion_core, load_motion_text_encoder

        pipeline = load_motion_core(SOURCE, MODEL)
        if free_host_memory() < host_bytes_needed(9 * 1024**3):
            raise RuntimeError(
                "At least 9 GiB of free system memory is required before loading the text encoders."
            )
        loaded = load_motion_text_encoder(pipeline, MODEL)
        with lock:
            model = loaded
            state.update(phase="ready", error=None)
        log_lifecycle("model_load_completed", job_id=job_id, started_at=started_at)
        log.info(
            "motion.model.load.completed",
            {"modelId": MODEL_ID, "durationMs": elapsed_ms(started_at)},
        )
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
        pipeline = None
        gc.collect()
        clear_cuda_cache()
        with lock:
            state.update(phase="error", error=str(error)[:1500])
        log_lifecycle("model_load_failed", job_id=job_id, started_at=started_at, error=error)
        log.error(
            "motion.model.load.failed",
            {
                "modelId": MODEL_ID,
                "errorClass": type(error).__name__,
                "durationMs": elapsed_ms(started_at),
            },
        )


def render_worker(job_id, request):
    started_at = time.perf_counter()
    log_lifecycle("motion_render_started", job_id=job_id, started_at=started_at)
    log.info("motion.render.started", {"jobId": job_id})
    partial_path = OUTPUTS / f".{job_id}.part"
    try:
        with lock:
            jobs[job_id].update(status="running", message="Generating character motion.")
        require_memory(loading=False, duration=request.duration)
        from hymotion_backend import generate_motion

        bvh = generate_motion(
            model,
            request.prompt,
            duration=request.duration,
            seed=request.seed,
            steps=request.steps,
            guidance=request.guidance,
        )
        partial_path.write_text(bvh, encoding="utf-8")
        os.replace(partial_path, OUTPUTS / f"{job_id}.bvh")
        log.debug(
            "motion.file.written",
            {"jobId": job_id, "kind": "bvh", "bytes": len(bvh.encode("utf-8"))},
        )
        with lock:
            jobs[job_id].update(status="completed", message="Motion clip ready.")
            state.update(phase="ready", error=None)
        log_lifecycle("motion_render_completed", job_id=job_id, started_at=started_at)
        log.info(
            "motion.render.completed",
            {
                "jobId": job_id,
                "clipSec": request.duration,
                "steps": request.steps,
                "durationMs": elapsed_ms(started_at),
            },
        )
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
        try:
            partial_path.unlink(missing_ok=True)
        except OSError as cleanup_error:
            log.warn(
                "motion.temp.cleanup.failed",
                {"jobId": job_id, "errorClass": type(cleanup_error).__name__},
            )
        clear_cuda_cache()
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready" if model is not None else "error", error=None)
        log_lifecycle("motion_render_failed", job_id=job_id, started_at=started_at, error=error)
        log.error(
            "motion.render.failed",
            {
                "jobId": job_id,
                "errorClass": type(error).__name__,
                "durationMs": elapsed_ms(started_at),
            },
        )


class MotionRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=1000)
    duration: float = Field(default=3, ge=1, le=12, allow_inf_nan=False, strict=True)
    seed: int = Field(default=123, ge=0, le=2147483647, strict=True)
    steps: int = Field(default=50, ge=1, le=100, strict=True)
    guidance: float = Field(default=5, ge=0, le=20, allow_inf_nan=False, strict=True)


@app.get("/api/status")
def status():
    with lock:
        return {
            "engine": "forge-hy-motion-v1",
            "phase": state["phase"],
            "loaded": model is not None,
            "model_downloaded": files_ready(),
            "error": state["error"],
        }


@app.post("/api/model/load", status_code=202)
def load():
    with lock:
        if state["closing"]:
            log.warn("motion.request.rejected", {"route": "/api/model/load", "reason": "closing"})
            raise HTTPException(409, "Motion worker is stopping.")
        if model is not None:
            return {"message": "Already loaded."}
        if state["phase"] == "loading":
            return {"message": "Already loading."}
        if state["phase"] == "generating":
            log.warn("motion.request.rejected", {"route": "/api/model/load", "reason": "busy"})
            raise HTTPException(409, "Motion worker is busy.")
        if not files_ready():
            log.warn(
                "motion.request.rejected",
                {"route": "/api/model/load", "reason": "files_missing"},
            )
            raise HTTPException(409, "HY-Motion model files are missing.")
        state.update(phase="loading", error=None)
        try:
            threading.Thread(target=load_worker, daemon=True).start()
        except RuntimeError as error:
            state.update(phase="error", error=str(error)[:1500])
            raise HTTPException(503, "Could not start the model loader.") from error
    return {"message": "Loading started."}


@app.post("/api/generate", status_code=202)
def generate(request: MotionRequest):
    if not request.prompt.strip():
        log.warn("motion.request.rejected", {"route": "/api/generate", "reason": "empty_prompt"})
        raise HTTPException(400, "Describe the motion.")
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            log.warn("motion.request.rejected", {"route": "/api/generate", "reason": "busy"})
            raise HTTPException(409, "Motion worker is busy.")
        if model is None:
            log.warn("motion.request.rejected", {"route": "/api/generate", "reason": "not_loaded"})
            raise HTTPException(409, "Load HY-Motion first.")
        job_id = uuid.uuid4().hex
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Waiting for motion generation.",
        }
        state.update(phase="generating", error=None)
        try:
            threading.Thread(target=render_worker, args=(job_id, request), daemon=True).start()
        except RuntimeError as error:
            del jobs[job_id]
            state.update(phase="ready", error=None)
            raise HTTPException(503, "Could not start motion generation.") from error
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "bvh", "Recovered completed motion clip."
        )
        if job is None:
            raise HTTPException(404, "Job not found.")
        return dict(job)


@app.get("/api/jobs/{job_id}/motion")
def motion(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "bvh", "Recovered completed motion clip."
        )
        if job is None or job["status"] != "completed":
            raise HTTPException(404, "Motion clip not found.")
    return FileResponse(OUTPUTS / f"{job_id}.bvh", media_type="application/octet-stream")


def finish_stop():
    with lock:
        if state["closing"]:
            log.info("motion.process.stopped", {"reason": "stop_requested"})
            flush()
            os._exit(0)


@app.post("/api/forge/{action}")
def control(action: str, x_forge_engine_token: str = Header(default="")):
    global stop_timer
    if not TOKEN or not hmac.compare_digest(TOKEN, x_forge_engine_token):
        log.warn("motion.request.rejected", {"route": "/api/forge/:action", "reason": "forbidden"})
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
            raise HTTPException(409, "Motion worker has active work.")
        log.info("motion.stop.requested", {"route": "/api/forge/:action"})
        state["closing"] = True
        if stop_timer is None:
            # Delay the exit so this HTTP response is sent before the process ends.
            stop_timer = threading.Timer(1, finish_stop)
            stop_timer.daemon = True
            stop_timer.start()
        return {"stopping": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    install_excepthook("motion")
    log.info("motion.process.started", {"port": args.port, "pid": os.getpid()})
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
    log.info("motion.process.stopped", {"reason": "server_exited"})
