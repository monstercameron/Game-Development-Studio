"""Loopback adapter for the installed Windows CUDA world generators."""

import argparse
import base64
import binascii
import ctypes
import json
import logging
import os
import re
import subprocess
import threading
import time
import traceback
import uuid
from pathlib import Path

import hidden_console  # noqa: F401  (hidden console for everything the worker starts)
import uvicorn
from app_log import get_logger, install_excepthook
from asr_guard import WindowsJob
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = Path.home() / "Desktop"
OUTPUTS = Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "world-outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
lock = threading.Lock()
jobs = {}
state = {"busy": False}
app = FastAPI(title="Forge world generation worker")
logger = logging.getLogger(__name__)
log = get_logger("world")


def elapsed_ms(started_at):
    """Milliseconds since a time.monotonic() reading, for log durationMs fields."""
    return round((time.monotonic() - started_at) * 1000)


def log_lifecycle_event(model_id, event, job_id, started_at, error=None):
    """Emit lifecycle metadata without including request or filesystem data."""
    event_data = {
        "engine": model_id,
        "event": event,
        "job_id": job_id,
        "elapsed_ms": elapsed_ms(started_at),
        "exception_class": type(error).__name__ if error else None,
    }
    if error:
        event_data["traceback_frames"] = [
            {
                "file": frame.f_code.co_filename.replace("\\", "/").rsplit("/", 1)[-1],
                "function": frame.f_code.co_name,
                "line": line,
            }
            for frame, line in list(traceback.walk_tb(error.__traceback__))[-8:]
        ]
    logger.info(
        json.dumps(
            event_data,
            separators=(",", ":"),
        )
    )


def available_commit_bytes():
    """Windows commit headroom, separate from the GPU's reported memory."""
    if os.name != "nt":
        return None

    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("load", ctypes.c_ulong),
            ("total_phys", ctypes.c_ulonglong),
            ("avail_phys", ctypes.c_ulonglong),
            ("total_page", ctypes.c_ulonglong),
            ("avail_page", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("avail_virtual", ctypes.c_ulonglong),
            ("avail_extended", ctypes.c_ulonglong),
        ]

    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    return (
        status.avail_page
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        else None
    )


def wait_for_render(child, guard, memory_check=available_commit_bytes):
    """Stop only this render if Windows commit headroom is critically low."""
    low_samples = 0
    while True:
        try:
            return child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            if child.poll() is not None:
                return child.returncode
            available = memory_check()
            low_samples = low_samples + 1 if available is not None and available < 1024**3 else 0
            if low_samples >= 2:
                guard.close()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired as timeout_error:
                    log.warn(
                        "world.generator.stop.timed_out",
                        {"errorClass": type(timeout_error).__name__},
                    )
                    child.kill()
                    child.wait()
                raise RuntimeError(
                    "Render stopped because Windows commit memory was nearly exhausted. Close or offload another model, then retry; GPU memory may still be available."
                ) from None


class WorldRequest(BaseModel):
    model: str
    mode: str
    prompt: str = Field(default="", max_length=4000)
    output: str = "splat"
    resolution: int = 512
    seed: int = Field(default=42, ge=0, le=2147483647)
    steps: int = Field(default=50, ge=10, le=60)
    # WorldGen only: FLUX guidance (the model's own default is 7 for text, 30 for images).
    guidance: float | None = Field(default=None, ge=1, le=50)
    # HY-World only: splat budget, sky removal and how many least-confident points are dropped.
    splat_limit: int = Field(default=1_000_000, ge=100_000, le=5_000_000)
    remove_sky: bool = False
    confidence_percentile: float = Field(default=10, ge=0, le=50)
    images: list[str] = Field(default_factory=list, max_length=8)


def result_path(work, require_data=True):
    """The finished world file: a PLY, or a GLB mesh.

    With require_data, a zero-byte file does not count as a result. Symlinks
    are rejected either way so a job folder cannot expose files outside it.
    """
    for extension in ("ply", "glb"):
        candidate = work / f"result.{extension}"
        if (
            candidate.is_file()
            and not candidate.is_symlink()
            and (not require_data or candidate.stat().st_size)
        ):
            return candidate
    return None


def run_job(job_id, request, work):
    guard = None
    started_at = time.monotonic()
    startup_succeeded = False
    render_started_at = None
    try:
        model_folder = "WorldGen" if request.model == "worldgen" else "HY-World-2.0"
        python = DESKTOP / model_folder / ".venv" / "Scripts" / "python.exe"
        if not python.is_file():
            raise RuntimeError(f"Python environment is missing: {python}")
        args = [
            str(python),
            "-u",
            str(ROOT / "runtime" / "world_backend.py"),
            "--request",
            str(work / "request.json"),
        ]
        cwd = DESKTOP / model_folder
        with lock:
            jobs[job_id].update(status="running", message="Loading the CUDA world generator.")
        # A guard owns the complete model process tree; a service crash closes
        # the job handle and releases GPU allocations rather than orphaning it.
        guard = WindowsJob()
        child = subprocess.Popen(
            args, cwd=cwd, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
        try:
            guard.add(child)
        except Exception:
            child.kill()
            child.wait()
            raise
        startup_succeeded = True
        log_lifecycle_event(request.model, "startup_succeeded", job_id, started_at)
        log.info(
            "world.generator.started",
            {"jobId": job_id, "model": request.model, "durationMs": elapsed_ms(started_at)},
        )
        render_started_at = time.monotonic()
        code = wait_for_render(child, guard)
        log.info(
            "world.generator.exited",
            {"jobId": job_id, "exitCode": code, "durationMs": elapsed_ms(render_started_at)},
        )
        if code != 0:
            detail = (
                (work / "error.txt").read_text(encoding="utf-8")[:1500]
                if (work / "error.txt").is_file()
                else f"World generator exited with code {code}. Check Diagnostics for the CUDA engine log."
            )
            raise RuntimeError(detail)
        if result_path(work, require_data=False) is None:
            raise RuntimeError("The generator exited without a world file.")
        with lock:
            jobs[job_id].update(status="completed", message="World ready.")
        log_lifecycle_event(request.model, "render_succeeded", job_id, render_started_at)
        log.info(
            "world.render.completed",
            {"jobId": job_id, "model": request.model, "durationMs": elapsed_ms(render_started_at)},
        )
    except Exception as error:
        phase = "render" if startup_succeeded else "startup"
        phase_started_at = render_started_at if startup_succeeded else started_at
        if startup_succeeded:
            log.error(
                "world.render.failed",
                {
                    "jobId": job_id,
                    "model": request.model,
                    "errorClass": type(error).__name__,
                    "durationMs": elapsed_ms(phase_started_at),
                },
            )
        else:
            log.error(
                "world.startup.failed",
                {
                    "jobId": job_id,
                    "model": request.model,
                    "errorClass": type(error).__name__,
                    "durationMs": elapsed_ms(phase_started_at),
                },
            )
        log_lifecycle_event(
            request.model,
            f"{phase}_failed",
            job_id,
            phase_started_at,
            error,
        )
        with lock:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
    finally:
        if guard:
            guard.close()
        with lock:
            state["busy"] = False


@app.get("/api/status")
def status():
    with lock:
        return {"engine": "forge-world-v1", "ready": True, "busy": state["busy"]}


@app.post("/api/generate", status_code=202)
def generate(request: WorldRequest):
    if (
        request.model not in ("worldgen", "hy-world")
        or request.mode not in ("text", "image", "panorama")
        or request.output not in ("mesh", "splat", "glb")
    ):
        log.warn("world.request.rejected", {"reason": "invalid_settings", "status": 400})
        raise HTTPException(400, "Invalid world generator settings.")
    if request.model == "hy-world" and (
        request.mode == "text"
        or not 1 <= len(request.images) <= (8 if request.mode == "image" else 1)
        or request.output != "splat"
        or request.resolution not in (336, 518, 700, 952)
    ):
        log.warn("world.request.rejected", {"reason": "invalid_hy_world_input", "status": 400})
        raise HTTPException(
            400, "HY-World requires 1–8 views or one panorama and a supported resolution."
        )
    if request.model == "worldgen" and (
        request.resolution not in (1024, 1600, 2048)
        or (request.mode == "text" and (not request.prompt.strip() or request.images))
        or (request.mode != "text" and len(request.images) != 1)
    ):
        log.warn("world.request.rejected", {"reason": "invalid_worldgen_input", "status": 400})
        raise HTTPException(400, "WorldGen needs a description or one matching reference image.")
    decoded = []
    try:
        for image in request.images:
            prefix, encoded = image.split(",", 1)
            if prefix not in (
                "data:image/png;base64",
                "data:image/jpeg;base64",
                "data:image/webp;base64",
            ):
                raise ValueError("Unsupported image.")
            raw = base64.b64decode(encoded, validate=True)
            if not 12 <= len(raw) <= 10 * 1024 * 1024:
                raise ValueError("Each image must be at most 10 MiB.")
            decoded.append(raw)
        if sum(map(len, decoded)) > 40 * 1024 * 1024:
            raise ValueError("Images must total at most 40 MiB.")
    except (ValueError, binascii.Error) as error:
        log.warn(
            "world.request.rejected",
            {"reason": "invalid_image", "status": 400, "errorClass": type(error).__name__},
        )
        raise HTTPException(400, str(error)) from error
    with lock:
        if state["busy"]:
            log.warn("world.request.rejected", {"reason": "already_running", "status": 409})
            raise HTTPException(409, "World generation is already running.")
        job_id = uuid.uuid4().hex
        work = OUTPUTS / job_id
        work.mkdir()
        for index, raw in enumerate(decoded):
            (work / f"input-{index}.png").write_bytes(raw)
            log.debug("world.file.written", {"kind": "input_image", "bytes": len(raw)})
        # json.dumps escapes non-ASCII text, so len() is the UTF-8 byte count.
        request_json = json.dumps(
            {**request.model_dump(exclude={"images"}), "image_count": len(decoded)}
        )
        (work / "request.json").write_text(request_json, encoding="utf-8")
        log.debug("world.file.written", {"kind": "request", "bytes": len(request_json)})
        jobs[job_id] = {"id": job_id, "status": "queued", "message": "Starting world generation."}
        state["busy"] = True
        threading.Thread(target=run_job, args=(job_id, request, work), daemon=True).start()
        log.info(
            "world.job.accepted",
            {
                "jobId": job_id,
                "model": request.model,
                "mode": request.mode,
                "imageCount": len(decoded),
            },
        )
    return {"id": job_id}


def valid_job(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        log.warn("world.request.rejected", {"reason": "invalid_job_id", "status": 404})
        raise HTTPException(404, "Job not found.")
    work = OUTPUTS / job_id
    if work.is_symlink():
        log.warn("world.request.rejected", {"reason": "job_is_symlink", "status": 404})
        raise HTTPException(404, "Job not found.")
    return work


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    work = valid_job(job_id)
    with lock:
        job = jobs.get(job_id)
    if job:
        result = dict(job)
        if result["status"] == "running":
            try:
                stage = (work / "stage.txt").read_text(encoding="utf-8").strip()
                if stage:
                    result["message"] = stage[:300]
            except (OSError, UnicodeError) as error:
                log.debug("world.stage.read.failed", {"errorClass": type(error).__name__})
        return result
    if result_path(work):
        return {"id": job_id, "status": "completed", "message": "Recovered completed world."}
    log.debug("world.job.not_found", {"status": 404})
    raise HTTPException(404, "World job not found.")


@app.get("/api/jobs/{job_id}/world")
def get_world(job_id: str):
    work = valid_job(job_id)
    job = get_job(job_id)
    result = result_path(work)
    if job["status"] != "completed" or result is None:
        log.debug("world.request.rejected", {"reason": "world_not_ready", "status": 404})
        raise HTTPException(404, "World not found.")
    return FileResponse(result, media_type="application/octet-stream")


@app.get("/api/jobs/{job_id}/panorama")
def get_panorama(job_id: str):
    """The 360-degree panorama a WorldGen text or image render built the world from."""
    work = valid_job(job_id)
    job = get_job(job_id)
    panorama = work / "panorama.png"
    if job["status"] != "completed" or panorama.is_symlink() or not panorama.is_file():
        log.debug("world.request.rejected", {"reason": "panorama_not_ready", "status": 404})
        raise HTTPException(404, "Panorama not found.")
    return FileResponse(panorama, media_type="image/png")


if __name__ == "__main__":
    install_excepthook("world")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8288)
    port = parser.parse_args().port
    log.info("world.process.started", {"port": port, "pid": os.getpid()})
    uvicorn.run(app, host="127.0.0.1", port=port)
    log.info("world.process.stopped")
