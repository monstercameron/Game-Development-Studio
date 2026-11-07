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

import uvicorn
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


def log_lifecycle_event(model_id, event, job_id, started_at, error=None):
    """Emit lifecycle metadata without including request or filesystem data."""
    event_data = {
        "engine": model_id,
        "event": event,
        "job_id": job_id,
        "elapsed_ms": round((time.monotonic() - started_at) * 1000),
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
                except subprocess.TimeoutExpired:
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
    images: list[str] = Field(default_factory=list, max_length=8)


def run_job(job_id, request, work):
    guard = None
    started_at = time.monotonic()
    startup_succeeded = False
    render_started_at = None
    try:
        python = (
            DESKTOP
            / ("WorldGen" if request.model == "worldgen" else "HY-World-2.0")
            / ".venv"
            / "Scripts"
            / "python.exe"
        )
        if not python.is_file():
            raise RuntimeError(f"Python environment is missing: {python}")
        args = [
            str(python),
            "-u",
            str(ROOT / "runtime" / "world_backend.py"),
            "--request",
            str(work / "request.json"),
        ]
        cwd = DESKTOP / ("WorldGen" if request.model == "worldgen" else "HY-World-2.0")
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
        render_started_at = time.monotonic()
        code = wait_for_render(child, guard)
        if code != 0:
            detail = (
                (work / "error.txt").read_text(encoding="utf-8")[:1500]
                if (work / "error.txt").is_file()
                else f"World generator exited with code {code}. Check Diagnostics for the CUDA engine log."
            )
            raise RuntimeError(detail)
        if not (work / "result.ply").is_file():
            raise RuntimeError("The generator exited without a world file.")
        with lock:
            jobs[job_id].update(status="completed", message="World ready.")
        log_lifecycle_event(request.model, "render_succeeded", job_id, render_started_at)
    except Exception as error:
        phase = "render" if startup_succeeded else "startup"
        phase_started_at = render_started_at if startup_succeeded else started_at
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
        or request.output not in ("mesh", "splat")
    ):
        raise HTTPException(400, "Invalid world generator settings.")
    if request.model == "hy-world" and (
        request.mode != "image"
        or not 1 <= len(request.images) <= 8
        or request.output != "splat"
        or request.resolution not in (336, 518, 700)
    ):
        raise HTTPException(400, "HY-World requires 1–8 images and a supported resolution.")
    if request.model == "worldgen" and (
        request.resolution not in (1024, 1600, 2048)
        or (request.mode == "text" and (not request.prompt.strip() or request.images))
        or (request.mode != "text" and len(request.images) != 1)
    ):
        raise HTTPException(400, "WorldGen needs a description or one matching reference image.")
    decoded = []
    try:
        for image in request.images:
            prefix, data = image.split(",", 1)
            if prefix not in (
                "data:image/png;base64",
                "data:image/jpeg;base64",
                "data:image/webp;base64",
            ):
                raise ValueError("Unsupported image.")
            raw = base64.b64decode(data, validate=True)
            if not 12 <= len(raw) <= 10 * 1024 * 1024:
                raise ValueError("Each image must be at most 10 MiB.")
            decoded.append(raw)
        if sum(map(len, decoded)) > 40 * 1024 * 1024:
            raise ValueError("Images must total at most 40 MiB.")
    except (ValueError, binascii.Error) as error:
        raise HTTPException(400, str(error)) from error
    with lock:
        if state["busy"]:
            raise HTTPException(409, "World generation is already running.")
        job_id = uuid.uuid4().hex
        work = OUTPUTS / job_id
        work.mkdir()
        for index, raw in enumerate(decoded):
            (work / f"input-{index}.png").write_bytes(raw)
        (work / "request.json").write_text(
            json.dumps({**request.model_dump(exclude={"images"}), "image_count": len(decoded)}),
            encoding="utf-8",
        )
        jobs[job_id] = {"id": job_id, "status": "queued", "message": "Starting world generation."}
        state["busy"] = True
        threading.Thread(target=run_job, args=(job_id, request, work), daemon=True).start()
    return {"id": job_id}


def valid_job(job_id):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(404, "Job not found.")
    work = OUTPUTS / job_id
    if work.is_symlink():
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
            except (OSError, UnicodeError):
                pass
        return result
    result = work / "result.ply"
    if result.is_file() and not result.is_symlink() and result.stat().st_size:
        return {"id": job_id, "status": "completed", "message": "Recovered completed world."}
    raise HTTPException(404, "World job not found.")


@app.get("/api/jobs/{job_id}/world")
def get_world(job_id: str):
    work = valid_job(job_id)
    job = get_job(job_id)
    result = work / "result.ply"
    if job["status"] != "completed" or result.is_symlink() or not result.is_file():
        raise HTTPException(404, "World not found.")
    return FileResponse(result, media_type="application/octet-stream")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8288)
    uvicorn.run(app, host="127.0.0.1", port=parser.parse_args().port)
