"""Experimental isolated CUDA worker for MotionBricks SOMA transitions."""

import argparse
import ctypes
import gc
import hmac
import json
import os
import sys
import threading
import traceback
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / ".forge-runtime" / "motionbricks-packages"))
# These imports must follow sys.path setup for the isolated embedded Python runtime.
from app_log import flush as flush_log  # noqa: E402
from app_log import get_logger, install_excepthook  # noqa: E402
from engine_identity import install_identity_endpoint  # noqa: E402
from host_memory import host_bytes_needed  # noqa: E402
from worker_outputs import recovered_job  # noqa: E402

log = get_logger("motion")

MODEL = Path(os.environ.get("FORGE_MOTIONBRICKS_MODEL", ROOT / "models" / "MotionBricks"))
SOURCE = Path(
    os.environ.get("FORGE_MOTIONBRICKS_SOURCE", ROOT / ".forge-runtime" / "motionbricks-src")
)
OUTPUTS = (
    Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "motionbricks-outputs"
)
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
app = FastAPI(title="Forge MotionBricks experimental worker")
install_identity_endpoint(app, TOKEN, "motion-bricks")
# Guards state, jobs, session and current_rig, which worker threads and HTTP handlers share.
lock = threading.Lock()
state = {"phase": "idle", "error": None, "closing": False}
jobs = {}
session = None
current_rig = None
stop_timer = None


def files_ready():
    folder = MODEL / "checkpoints" / "soma" / "soma-v6-nova-4n8g-ea43dd8-fp32-v1"
    required = {
        "mmm-v6-soma-pose-nova-4n8g-ea43dd8-fp32-v1/version_0/checkpoints/model-step=1500000.safetensors": 546109841,
        "mmm-v6-soma-pose-nova-4n8g-ea43dd8-fp32-v1/version_0/stats/motion/mean.npy": 3088,
        "mmm-v6-soma-pose-nova-4n8g-ea43dd8-fp32-v1/version_0/stats/motion/std.npy": 3088,
        "mmm-v6-soma-root-nova-4n8g-ea43dd8-fp32-v1/version_0/checkpoints/model-step=1500000.safetensors": 161695084,
        "vqvae-v6-soma-nova-4n8g-ea43dd8-fp32-v1/version_0/checkpoints/model-step=1500000.safetensors": 93442464,
    }
    try:
        return (
            all(
                (folder / name).is_file() and (folder / name).stat().st_size == size
                for name, size in required.items()
            )
            and (SOURCE / "tools/onnx/assets/soma_model_rig.npz").stat().st_size == 1184
        )
    except OSError as error:
        log.debug("motion.files.check.failed", {"error": error})
        return False


def available_memory():
    if os.name == "nt":

        class Memory(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("load", ctypes.c_ulong),
                ("total", ctypes.c_ulonglong),
                ("available", ctypes.c_ulonglong),
                ("page_total", ctypes.c_ulonglong),
                ("page_available", ctypes.c_ulonglong),
                ("virtual_total", ctypes.c_ulonglong),
                ("virtual_available", ctypes.c_ulonglong),
                ("extended", ctypes.c_ulonglong),
            ]

        info = Memory()
        info.length = ctypes.sizeof(info)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(info)):
            raise RuntimeError("Available system memory could not be measured.")
        return info.available
    try:
        return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError) as error:
        raise RuntimeError("Available system memory could not be measured.") from error


def require_memory(gib):
    if available_memory() < host_bytes_needed(gib * 1024**3):
        raise RuntimeError(f"At least {gib} GiB of free system memory is required.")


def require_gpu_memory(gib):
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU is unavailable.")
    free, _ = torch.cuda.mem_get_info()
    if free < gib * 1024**3:
        raise RuntimeError(f"At least {gib} GiB of free GPU memory is required.")


def load_worker(rig, threads):
    global session, current_rig
    stop = log.time("motion.model.load.completed", {"modelId": rig})
    try:
        require_memory(7)
        from motionbricks_backend import load_model

        loaded = load_model(MODEL, rig, threads=threads)
        with lock:
            session = loaded
            current_rig = rig
            state.update(phase="ready", error=None)
        stop()
    except Exception as error:
        log.error("motion.model.load.failed", {"modelId": rig, "error": error})
        traceback.print_exc()
        traceback.clear_frames(error.__traceback__)
        gc.collect()
        torch = sys.modules.get("torch")
        try:
            if torch is not None and torch.cuda.is_initialized():
                torch.cuda.empty_cache()
        except Exception as cleanup_error:
            log.debug("motion.cuda.cache.clear_failed", {"error": cleanup_error})
        with lock:
            state.update(phase="error", error=str(error)[:1500])


def render_worker(job_id, rig, tensors):
    staging_path = OUTPUTS / f".{job_id}.part"
    stop = log.time("motion.generate.completed", {"jobId": job_id, "format": "json"})
    try:
        log.info("motion.job.state.changed", {"jobId": job_id, "from": "queued", "to": "running"})
        with lock:
            jobs[job_id].update(status="running", message="Generating pose transition.")
        require_memory(4)
        require_gpu_memory(3)
        from motionbricks_backend import infer

        output = infer(session, rig, tensors)
        # Keep raw model output, including boundary frames; no retargeting or endpoint correction.
        result = {
            "rig": rig,
            "sampleRate": 30,
            "boundaryFrames": 3,
            "tensors": {key: value.tolist() for key, value in output.items()},
        }
        # json.dumps escapes non-ASCII by default, so len() is the byte count.
        payload = json.dumps(result, allow_nan=False, separators=(",", ":"))
        staging_path.write_text(payload, encoding="utf-8")
        os.replace(staging_path, OUTPUTS / f"{job_id}.json")
        log.debug(
            "motion.file.written",
            {"kind": "output", "extension": "json", "outputBytes": len(payload)},
        )
        with lock:
            jobs[job_id].update(status="completed", message="Raw pose transition ready.")
            state.update(phase="ready", error=None)
        stop({"outputBytes": len(payload)})
    except Exception as error:
        log.error("motion.generate.failed", {"jobId": job_id, "format": "json", "error": error})
        traceback.print_exc()
        try:
            staging_path.unlink(missing_ok=True)
        except OSError as cleanup_error:
            log.debug("motion.file.cleanup.failed", {"error": cleanup_error})
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready" if session is not None else "error", error=None)


def render_bvh_worker(job_id, clip, tensors, alignment):
    staging_path = OUTPUTS / f".{job_id}.part"
    stop = log.time("motion.generate.completed", {"jobId": job_id, "format": "bvh"})
    try:
        log.info("motion.job.state.changed", {"jobId": job_id, "from": "queued", "to": "running"})
        with lock:
            jobs[job_id].update(status="running", message="Generating SOMA pose transition.")
        require_memory(4)
        require_gpu_memory(3)
        from motionbricks_backend import infer
        from motionbricks_bvh import decode_bvh

        output = infer(session, "soma", tensors)
        bvh = decode_bvh(clip, output, alignment)
        staging_path.write_text(bvh, encoding="utf-8")
        os.replace(staging_path, OUTPUTS / f"{job_id}.bvh")
        bvh_bytes = len(bvh.encode("utf-8"))
        log.debug(
            "motion.file.written", {"kind": "output", "extension": "bvh", "outputBytes": bvh_bytes}
        )
        with lock:
            jobs[job_id].update(status="completed", message="SOMA transition ready.", format="bvh")
            state.update(phase="ready", error=None)
        stop({"outputBytes": bvh_bytes})
    except Exception as error:
        log.error("motion.generate.failed", {"jobId": job_id, "format": "bvh", "error": error})
        traceback.print_exc()
        try:
            staging_path.unlink(missing_ok=True)
        except OSError as cleanup_error:
            log.debug("motion.file.cleanup.failed", {"error": cleanup_error})
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready" if session is not None else "error", error=None)


class LoadRequest(BaseModel):
    rig: str
    threads: int = Field(default=4, ge=1, le=8, strict=True)


class GenerateRequest(BaseModel):
    rig: str
    tensors: dict


class BvhRequest(BaseModel):
    # Caps the uploaded BVH text at 10 MiB.
    bvh: str = Field(min_length=1, max_length=10 * 1024**2)
    context_frame: int = Field(ge=0, strict=True)
    target_frame: int = Field(ge=0, strict=True)
    min_tokens: int = Field(default=8, ge=6, le=16, strict=True)
    max_tokens: int = Field(default=14, ge=6, le=16, strict=True)
    num_target_poses: int = Field(default=4, ge=1, le=4, strict=True)


# log-coverage: ignore -- read-only status poll, frequent and changes no state
@app.get("/api/status")
def status():
    with lock:
        return {
            "engine": "forge-motionbricks-cuda-experimental-v1",
            "phase": state["phase"],
            "loaded": session is not None,
            "rig": current_rig,
            "error": state["error"],
            "model_downloaded": files_ready(),
            "device": "cuda",
            "supported_rigs": ["soma"],
        }


@app.post("/api/model/load", status_code=202)
def load(request: LoadRequest):
    route = "/api/model/load"
    if request.rig != "soma":
        log.warn("motion.request.rejected", {"route": route, "reason": "unsupported_rig"})
        raise HTTPException(400, "Only SOMA is connected for CUDA inference.")
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            log.warn("motion.request.rejected", {"route": route, "reason": "worker_busy"})
            raise HTTPException(409, "Worker is busy.")
        if session is not None:
            if current_rig != request.rig:
                log.warn(
                    "motion.request.rejected",
                    {"route": route, "reason": "switch_requires_stop"},
                )
                raise HTTPException(409, "Stop the worker before switching models.")
            return {"message": "Already loaded."}
        if not files_ready():
            log.warn("motion.request.rejected", {"route": route, "reason": "model_files_missing"})
            raise HTTPException(409, "MotionBricks SOMA model files are missing or incomplete.")
        log.info("motion.model.load.started", {"modelId": request.rig})
        state.update(phase="loading", error=None)
        try:
            threading.Thread(
                target=load_worker, args=(request.rig, request.threads), daemon=True
            ).start()
        except RuntimeError as error:
            log.error("motion.model.load.failed", {"modelId": request.rig, "error": error})
            state.update(phase="error", error=str(error)[:1500])
            raise HTTPException(503, "Could not start model loader.") from error
    return {"message": "Loading started."}


@app.post("/api/generate", status_code=202)
def generate(request: GenerateRequest):
    route = "/api/generate"
    if request.rig not in ("soma", "g1"):
        log.warn("motion.request.rejected", {"route": route, "reason": "unsupported_rig"})
        raise HTTPException(400, "Choose soma or g1.")
    from motionbricks_backend import prepare_inputs

    try:
        tensors = prepare_inputs(request.rig, request.tensors)
    except (TypeError, ValueError) as error:
        log.warn(
            "motion.request.rejected",
            {"route": route, "reason": "invalid_input", "errorClass": type(error).__name__},
        )
        raise HTTPException(400, str(error)) from error
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            log.warn("motion.request.rejected", {"route": route, "reason": "worker_busy"})
            raise HTTPException(409, "Worker is busy.")
        if session is None or current_rig != request.rig:
            log.warn("motion.request.rejected", {"route": route, "reason": "model_not_loaded"})
            raise HTTPException(409, "Load the matching model first.")
        job_id = uuid.uuid4().hex
        jobs[job_id] = {"id": job_id, "status": "queued", "message": "Waiting for pose generation."}
        log.info("motion.job.state.changed", {"jobId": job_id, "to": "queued"})
        state.update(phase="generating", error=None)
        try:
            threading.Thread(
                target=render_worker, args=(job_id, request.rig, tensors), daemon=True
            ).start()
        except RuntimeError as error:
            log.error("motion.generate.failed", {"jobId": job_id, "format": "json", "error": error})
            del jobs[job_id]
            state.update(phase="ready", error=None)
            raise HTTPException(503, "Could not start generation.") from error
    return {"id": job_id}


@app.post("/api/generate-bvh", status_code=202)
def generate_bvh(request: BvhRequest):
    route = "/api/generate-bvh"
    from motionbricks_bvh import encode_pose_windows, parse_bvh

    try:
        clip = parse_bvh(request.bvh)
        tensors, alignment = encode_pose_windows(
            clip,
            request.context_frame,
            request.target_frame,
            min_tokens=request.min_tokens,
            max_tokens=request.max_tokens,
            num_target_poses=request.num_target_poses,
        )
    except (TypeError, ValueError) as error:
        log.warn(
            "motion.request.rejected",
            {"route": route, "reason": "invalid_input", "errorClass": type(error).__name__},
        )
        raise HTTPException(400, str(error)) from error
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            log.warn("motion.request.rejected", {"route": route, "reason": "worker_busy"})
            raise HTTPException(409, "Worker is busy.")
        if session is None or current_rig != "soma":
            log.warn("motion.request.rejected", {"route": route, "reason": "model_not_loaded"})
            raise HTTPException(409, "Load the SOMA model first.")
        job_id = uuid.uuid4().hex
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Waiting for pose generation.",
            "format": "bvh",
        }
        log.info("motion.job.state.changed", {"jobId": job_id, "to": "queued"})
        state.update(phase="generating", error=None)
        try:
            threading.Thread(
                target=render_bvh_worker, args=(job_id, clip, tensors, alignment), daemon=True
            ).start()
        except RuntimeError as error:
            log.error("motion.generate.failed", {"jobId": job_id, "format": "bvh", "error": error})
            del jobs[job_id]
            state.update(phase="ready", error=None)
            raise HTTPException(503, "Could not start generation.") from error
    return {"id": job_id}


def find_job(job_id):
    job = jobs.get(job_id)
    if job is not None:
        return job
    job = recovered_job(OUTPUTS, job_id, "bvh", "Recovered completed SOMA transition.")
    if job is not None:
        return {**job, "format": "bvh"}
    return recovered_job(OUTPUTS, job_id, "json", "Recovered completed raw pose transition.")


# log-coverage: ignore -- unknown or unfinished job is a normal polling answer, not a fault
@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with lock:
        job = find_job(job_id)
        if job is None:
            raise HTTPException(404, "Job not found.")
        return dict(job)


# log-coverage: ignore -- output not ready yet is a normal polling answer, not a fault
@app.get("/api/jobs/{job_id}/output")
def output(job_id: str):
    with lock:
        job = find_job(job_id)
        if job is None or job["status"] != "completed":
            raise HTTPException(404, "Output not found.")
        extension = "bvh" if job.get("format") == "bvh" else "json"
    return FileResponse(
        OUTPUTS / f"{job_id}.{extension}",
        media_type="text/plain" if extension == "bvh" else "application/json",
    )


def finish_stop():
    with lock:
        if state["closing"]:
            log.info("motion.process.stopped")
            # os._exit skips atexit, so flush the spool before exiting.
            flush_log()
            os._exit(0)


@app.post("/api/forge/{action}")
def control(action: str, x_forge_engine_token: str = Header(default="")):
    global stop_timer
    route = "/api/forge/:action"
    if not TOKEN or not hmac.compare_digest(TOKEN, x_forge_engine_token):
        log.warn("motion.request.rejected", {"route": route, "reason": "forbidden"})
        raise HTTPException(403, "Forbidden.")
    with lock:
        if action == "resume":
            if stop_timer:
                stop_timer.cancel()
                stop_timer = None
            state["closing"] = False
            log.info("motion.stop.cancelled")
            return {"resumed": True}
        if action != "stop":
            log.warn("motion.request.rejected", {"route": route, "reason": "unknown_action"})
            raise HTTPException(404, "Not found.")
        if state["phase"] in ("loading", "generating"):
            log.warn("motion.request.rejected", {"route": route, "reason": "worker_busy"})
            raise HTTPException(409, "Worker has active work.")
        state["closing"] = True
        log.info("motion.process.stop.requested")
        if stop_timer is None:
            stop_timer = threading.Timer(1, finish_stop)
            stop_timer.daemon = True
            stop_timer.start()
        return {"stopping": True}


if __name__ == "__main__":
    install_excepthook("motion")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    port = parser.parse_args().port
    log.info("motion.process.started", {"pid": os.getpid(), "port": port})
    uvicorn.run(app, host="127.0.0.1", port=port, access_log=False)
