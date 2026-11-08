"""Isolated Qwen3-TTS worker; Forge owns queuing and project asset storage."""

import argparse
import base64
import binascii
import gc
import hmac
import io
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
# These imports must follow sys.path setup for the isolated embedded Python runtime.
from app_log import flush, get_logger, install_excepthook  # noqa: E402
from engine_identity import install_identity_endpoint  # noqa: E402
from worker_outputs import recovered_job  # noqa: E402

# One checkpoint is resident per worker process. Each checkpoint has its own folder; loading a
# different one unloads the resident model first. FORGE_TTS_MODEL overrides only the preset folder.
CHECKPOINTS = {
    "custom_voice": Path(
        os.environ.get("FORGE_TTS_MODEL", ROOT / "models" / "Qwen3-TTS-12Hz-1.7B-CustomVoice")
    ),
    "base": ROOT / "models" / "Qwen3-TTS-12Hz-1.7B-Base",
    "voice_design": ROOT / "models" / "Qwen3-TTS-12Hz-1.7B-VoiceDesign",
}
# Request mode -> the checkpoint it needs. A missing mode is the original preset request.
MODE_CHECKPOINTS = {"preset": "custom_voice", "clone": "base", "design": "voice_design"}
# The Base model card describes a 3-second clone; the upper bound keeps prompts bounded.
REFERENCE_MIN_SECONDS = 3
REFERENCE_MAX_SECONDS = 30
OUTPUTS = Path(os.environ.get("FORGE_RUNTIME_DIR", ROOT / ".forge-runtime")) / "tts-outputs"
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get("FORGE_ENGINE_CONTROL_TOKEN", "")
SPEAKERS = ("Ryan", "Aiden", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ono_Anna", "Sohee")
LANGUAGES = (
    "Auto",
    "English",
    "Chinese",
    "Japanese",
    "Korean",
    "German",
    "French",
    "Russian",
    "Portuguese",
    "Spanish",
    "Italian",
)
lock = threading.Lock()
state = {"phase": "idle", "error": None, "closing": False}
jobs = {}
model = None
loaded_variant = None
stop_timer = None
app = FastAPI(title="Forge Qwen3-TTS worker")
install_identity_endpoint(app, TOKEN, "tts")
logger = logging.getLogger(__name__)
log = get_logger("voices")


def elapsed_ms(started_at):
    """Milliseconds since a time.perf_counter() reading, for durationMs fields."""
    return round((time.perf_counter() - started_at) * 1000)


def log_lifecycle(event, *, started_at, job_id=None, error=None):
    """Write lifecycle metadata without including request content or error details."""
    frames = []
    if error is not None:
        frames = [
            {
                "file": frame.filename.replace("\\", "/").rsplit("/", 1)[-1],
                "function": frame.name,
                "line": frame.lineno,
            }
            for frame in traceback.extract_tb(error.__traceback__)[-8:]
        ]
    fields = {
        "engine": "forge-qwen3-tts-v1",
        "event": event,
        "job_id": job_id,
        "elapsed_ms": elapsed_ms(started_at),
        "exception_class": type(error).__name__ if error is not None else None,
        "traceback_frames": frames,
    }
    logger.info(json.dumps(fields, separators=(",", ":")))


def checkpoint_ready(variant):
    return all(
        (CHECKPOINTS[variant] / item).is_file()
        for item in (
            "config.json",
            "model.safetensors",
            "speech_tokenizer/config.json",
            "speech_tokenizer/model.safetensors",
        )
    )


def files_ready():
    return checkpoint_ready("custom_voice")


def load_worker(variant):
    global model, loaded_variant
    started_at = time.perf_counter()
    log_lifecycle("model_load_started", started_at=started_at)
    log.info("voices.model.load.started", {"model": variant})
    try:
        import torch
        from qwen_tts import Qwen3TTSModel

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable in the configured speech runtime.")
        with lock:
            previous = model
            model = None
            loaded_variant = None
        if previous is not None:
            # Release the previous checkpoint before the new one is mapped onto the GPU.
            del previous
            gc.collect()
            torch.cuda.empty_cache()
        loaded = Qwen3TTSModel.from_pretrained(
            str(CHECKPOINTS[variant]),
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="eager",
            local_files_only=True,
        )
        with lock:
            model = loaded
            loaded_variant = variant
            state.update(phase="ready", error=None)
        log.info(
            "voices.model.load.completed",
            {"model": variant, "durationMs": elapsed_ms(started_at)},
        )
        log_lifecycle("model_load_completed", started_at=started_at)
    except Exception as error:
        with lock:
            state.update(phase="error", error=str(error)[:1500])
        log.error(
            "voices.model.load.failed",
            {
                "model": variant,
                "durationMs": elapsed_ms(started_at),
                "errorClass": type(error).__name__,
            },
        )
        log_lifecycle("model_load_failed", started_at=started_at, error=error)


def synthesize(request, reference, sampling):
    """Generate with the checkpoint-specific method; the resident model matches the request mode."""
    if request.mode == "clone":
        # The package only uses ref_text in ICL mode, and in x-vector mode it still tokenizes a
        # non-empty transcript into the prompt. Withhold it so a voice-only clone never sees one.
        voice_only = request.clone_voice_only
        return model.generate_voice_clone(
            text=request.text,
            language=request.language,
            ref_audio=reference,
            ref_text=None if voice_only else request.reference_text,
            x_vector_only_mode=voice_only,
            max_new_tokens=request.max_new_tokens,
            **sampling,
        )
    if request.mode == "design":
        return model.generate_voice_design(
            text=request.text,
            instruct=request.voice_description,
            language=request.language,
            max_new_tokens=request.max_new_tokens,
            **sampling,
        )
    return model.generate_custom_voice(
        text=request.text,
        language=request.language,
        speaker=request.speaker,
        instruct=request.instruct,
        max_new_tokens=request.max_new_tokens,
        **sampling,
    )


def render_worker(job_id, request, reference):
    partial_path = None
    started_at = time.perf_counter()
    log_lifecycle("generation_started", started_at=started_at, job_id=job_id)
    log.info("voices.render.started", {"jobId": job_id})
    try:
        import soundfile as sf

        with lock:
            jobs[job_id].update(status="running", message="Generating speech.")
        # Sampling overrides are forwarded only when set so the model keeps its own defaults.
        # The sub-talker is the second-stage model that fills in each speech frame's fine detail.
        sampling = {
            name: getattr(request, name)
            for name in (
                "temperature",
                "top_p",
                "top_k",
                "repetition_penalty",
                "do_sample",
                "subtalker_dosample",
                "subtalker_temperature",
                "subtalker_top_p",
                "subtalker_top_k",
            )
            if getattr(request, name) is not None
        }
        if request.seed is not None:
            import torch

            torch.manual_seed(request.seed)
            torch.cuda.manual_seed_all(request.seed)
        wavs, sample_rate = synthesize(request, reference, sampling)
        if not wavs or len(wavs[0]) == 0:
            raise RuntimeError("The speech model returned empty audio.")
        partial_path = OUTPUTS / f".{job_id}.part"
        sf.write(str(partial_path), wavs[0], sample_rate, format="WAV")
        os.replace(partial_path, OUTPUTS / f"{job_id}.wav")
        log.debug("voices.file.written", {"jobId": job_id, "kind": "output", "extension": "wav"})
        # The codec runs at 12.5 tokens per second; audio that fills the token limit was cut off.
        truncated = len(wavs[0]) / sample_rate >= (request.max_new_tokens - 2) / 12.5
        with lock:
            jobs[job_id].update(status="completed", message="Speech ready.", truncated=truncated)
            state.update(phase="ready", error=None)
        log.info(
            "voices.render.completed",
            {"jobId": job_id, "durationMs": elapsed_ms(started_at)},
        )
        log_lifecycle("generation_completed", started_at=started_at, job_id=job_id)
    except Exception as error:
        message = str(error)
        if partial_path is not None:
            try:
                partial_path.unlink(missing_ok=True)
            except OSError as cleanup_error:
                message = f"{message} (could not remove partial audio: {cleanup_error})"
                log.warn(
                    "voices.file.cleanup.failed",
                    {
                        "jobId": job_id,
                        "kind": "partial_audio",
                        "errorClass": type(cleanup_error).__name__,
                    },
                )
        with lock:
            jobs[job_id].update(status="failed", message=message[:1500])
            state.update(phase="ready" if model is not None else "error", error=None)
        log.error(
            "voices.render.failed",
            {
                "jobId": job_id,
                "durationMs": elapsed_ms(started_at),
                "errorClass": type(error).__name__,
            },
        )
        log_lifecycle("generation_failed", started_at=started_at, job_id=job_id, error=error)


class LoadRequest(BaseModel):
    variant: str = "custom_voice"


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    speaker: str = "Ryan"
    language: str = "English"
    instruct: str = Field(default="", max_length=500)
    mode: str = "preset"
    # Base64 WAV, FLAC or MP3 bytes; about 4/3 of a 32 MiB staged clip at most.
    reference_audio_base64: str | None = Field(default=None, max_length=45_000_000)
    reference_text: str = Field(default="", max_length=1000)
    # True clones from the speaker embedding alone: no transcript is used (lower similarity).
    clone_voice_only: bool = False
    voice_description: str = Field(default="", max_length=500)
    max_new_tokens: int = Field(default=1024, ge=64, le=4096)
    seed: int | None = Field(default=None, ge=0, le=2147483647)
    temperature: float | None = Field(default=None, gt=0, le=2)
    top_p: float | None = Field(default=None, gt=0, le=1)
    top_k: int | None = Field(default=None, ge=1, le=1000)
    repetition_penalty: float | None = Field(default=None, ge=1, le=2)
    do_sample: bool | None = None
    subtalker_dosample: bool | None = None
    subtalker_temperature: float | None = Field(default=None, ge=0.05, le=2)
    subtalker_top_p: float | None = Field(default=None, gt=0, le=1)
    subtalker_top_k: int | None = Field(default=None, ge=1, le=1000)


def decode_reference(encoded):
    """Decode and check a reference clip before any model work; errors are client errors."""
    import soundfile as sf

    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        log.warn(
            "voices.request.rejected",
            {"route": "/api/generate", "reason": "invalid_base64"},
        )
        raise HTTPException(400, "Reference audio is not valid base64.")
    try:
        audio, sample_rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception:
        log.warn(
            "voices.request.rejected",
            {"route": "/api/generate", "reason": "unsupported_audio"},
        )
        raise HTTPException(400, "Reference audio must be a WAV, FLAC, or MP3 file.")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    seconds = len(audio) / sample_rate
    if not REFERENCE_MIN_SECONDS <= seconds <= REFERENCE_MAX_SECONDS:
        log.warn(
            "voices.request.rejected",
            {"route": "/api/generate", "reason": "reference_duration"},
        )
        raise HTTPException(
            400,
            f"Reference audio must be {REFERENCE_MIN_SECONDS} to {REFERENCE_MAX_SECONDS} seconds long.",
        )
    return audio.astype("float32"), int(sample_rate)


@app.get("/api/status")
def status():
    with lock:
        return {
            "engine": "forge-qwen3-tts-v1",
            "phase": state["phase"],
            "loaded": model is not None,
            "loaded_variant": loaded_variant,
            "model_downloaded": files_ready(),
            "variants": {name: checkpoint_ready(name) for name in CHECKPOINTS},
            "error": state["error"],
        }


@app.post("/api/model/load", status_code=202)
def load(request: LoadRequest | None = None):
    variant = request.variant if request is not None else "custom_voice"
    if variant not in CHECKPOINTS:
        log.warn(
            "voices.request.rejected",
            {"route": "/api/model/load", "reason": "unknown_variant"},
        )
        raise HTTPException(400, "Unknown speech checkpoint.")
    with lock:
        if state["closing"]:
            log.warn(
                "voices.request.rejected",
                {"route": "/api/model/load", "reason": "closing"},
            )
            raise HTTPException(409, "Speech worker is stopping.")
        if model is not None and loaded_variant == variant:
            return {"message": "Already loaded."}
        if state["phase"] == "loading":
            return {"message": "Already loading."}
        if state["phase"] == "generating":
            log.warn(
                "voices.request.rejected",
                {"route": "/api/model/load", "reason": "busy"},
            )
            raise HTTPException(409, "Speech worker is busy.")
        if not checkpoint_ready(variant):
            log.warn(
                "voices.request.rejected",
                {"route": "/api/model/load", "reason": "model_files_missing"},
            )
            raise HTTPException(409, "Speech model files are missing.")
        state.update(phase="loading", error=None)
        try:
            threading.Thread(target=load_worker, args=(variant,), daemon=True).start()
        except Exception as error:
            state.update(phase="error", error=str(error)[:1500])
            log.error(
                "voices.model.load.start_failed",
                {"model": variant, "errorClass": type(error).__name__},
            )
            log_lifecycle("model_load_start_failed", started_at=time.perf_counter(), error=error)
            raise HTTPException(500, "Could not start speech model loading.") from error
    return {"message": "Loading started."}


@app.post("/api/generate", status_code=202)
def generate(request: SpeechRequest):
    if (
        not request.text.strip()
        or request.speaker not in SPEAKERS
        or request.language not in LANGUAGES
    ):
        log.warn(
            "voices.request.rejected",
            {"route": "/api/generate", "reason": "invalid_input"},
        )
        raise HTTPException(400, "Invalid text, speaker, or language.")
    if request.mode not in MODE_CHECKPOINTS:
        log.warn(
            "voices.request.rejected",
            {"route": "/api/generate", "reason": "unknown_mode"},
        )
        raise HTTPException(400, "Unknown voice mode.")
    reference = None
    if request.mode == "clone":
        transcript_missing = not request.clone_voice_only and not request.reference_text.strip()
        if transcript_missing or request.reference_audio_base64 is None:
            log.warn(
                "voices.request.rejected",
                {"route": "/api/generate", "reason": "missing_reference"},
            )
            raise HTTPException(
                400, "Cloning needs reference audio and, unless voice-only, its transcript."
            )
        reference = decode_reference(request.reference_audio_base64)
    if request.mode == "design" and not request.voice_description.strip():
        log.warn(
            "voices.request.rejected",
            {"route": "/api/generate", "reason": "missing_voice_description"},
        )
        raise HTTPException(400, "Designing a voice needs a voice description.")
    needed_variant = MODE_CHECKPOINTS[request.mode]
    with lock:
        if state["closing"] or state["phase"] in ("loading", "generating"):
            log.warn(
                "voices.request.rejected",
                {"route": "/api/generate", "reason": "busy"},
            )
            raise HTTPException(409, "Speech worker is busy.")
        if model is None or loaded_variant != needed_variant:
            log.warn(
                "voices.request.rejected",
                {"route": "/api/generate", "reason": "model_not_loaded"},
            )
            raise HTTPException(409, f"Load the {needed_variant} speech checkpoint first.")
        job_id = uuid.uuid4().hex
        jobs[job_id] = {
            "id": job_id,
            "status": "queued",
            "message": "Waiting for speech generation.",
        }
        state.update(phase="generating", error=None)
        try:
            threading.Thread(
                target=render_worker,
                args=(job_id, request, reference),
                daemon=True,
            ).start()
        except Exception as error:
            jobs[job_id].update(status="failed", message=str(error)[:1500])
            state.update(phase="ready", error=None)
            log.error(
                "voices.render.start_failed",
                {"jobId": job_id, "errorClass": type(error).__name__},
            )
            log_lifecycle(
                "generation_start_failed",
                started_at=time.perf_counter(),
                job_id=job_id,
                error=error,
            )
            raise HTTPException(500, "Could not start speech generation.") from error
    return {"id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "wav", "Recovered completed speech."
        )
        if job is None:
            raise HTTPException(404, "Job not found.")
        return dict(job)


@app.get("/api/jobs/{job_id}/audio")
def audio(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(
            OUTPUTS, job_id, "wav", "Recovered completed speech."
        )
        if job is None or job["status"] != "completed":
            raise HTTPException(404, "Audio not found.")
    return FileResponse(OUTPUTS / f"{job_id}.wav", media_type="audio/wav")


def finish_stop():
    with lock:
        if state["closing"]:
            log.info("voices.process.stopped", {"reason": "stop_requested"})
            # os._exit skips atexit, so buffered log records are written first.
            flush()
            os._exit(0)


@app.post("/api/forge/{action}")
def control(action: str, x_forge_engine_token: str = Header(default="")):
    global stop_timer
    if not TOKEN or not hmac.compare_digest(TOKEN, x_forge_engine_token):
        log.warn(
            "voices.request.rejected",
            {"route": "/api/forge/:action", "reason": "forbidden"},
        )
        raise HTTPException(403, "Forbidden.")
    with lock:
        if action == "resume":
            if stop_timer:
                stop_timer.cancel()
                stop_timer = None
            state["closing"] = False
            return {"resumed": True}
        if action != "stop":
            log.warn(
                "voices.request.rejected",
                {"route": "/api/forge/:action", "reason": "unknown_action"},
            )
            raise HTTPException(404, "Not found.")
        if state["phase"] in ("loading", "generating"):
            log.warn(
                "voices.request.rejected",
                {"route": "/api/forge/:action", "reason": "active_work"},
            )
            raise HTTPException(409, "Speech worker has active work.")
        state["closing"] = True
        log.info("voices.stop.requested", {"route": "/api/forge/:action"})
        if stop_timer is None:
            stop_timer = threading.Timer(1, finish_stop)
            stop_timer.daemon = True
            stop_timer.start()
        return {"stopping": True}


if __name__ == "__main__":
    install_excepthook("voices")
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    log.info("voices.process.started", {"port": args.port, "pid": os.getpid()})
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)
    log.info("voices.process.stopped", {"reason": "server_exited"})
