"""Isolated HY-Motion 1.0 text-to-BVH worker."""
import argparse
import ctypes
import gc
import hmac
import os
from pathlib import Path
import sys
import threading
import traceback
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import uvicorn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / '.forge-runtime' / 'hymotion-packages'))
from worker_outputs import recovered_job
from engine_identity import install_identity_endpoint
SOURCE = Path(os.environ.get('FORGE_HYMOTION_SOURCE', ROOT / '.forge-runtime' / 'hy-motion-src'))
MODEL = Path(os.environ.get('FORGE_HYMOTION_MODEL', ROOT / 'models' / 'HY-Motion'))
OUTPUTS = Path(os.environ.get('FORGE_RUNTIME_DIR', ROOT / '.forge-runtime')) / 'hymotion-outputs'
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get('FORGE_ENGINE_CONTROL_TOKEN', '')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
app = FastAPI(title='Forge HY-Motion worker')
install_identity_endpoint(app, TOKEN, 'motion-hy')
lock = threading.Lock()
state = {'phase': 'idle', 'error': None, 'closing': False}
jobs = {}
model = None
stop_timer = None


def files_ready():
    paths = [MODEL / 'HY-Motion-1.0' / name for name in ('config.yml', 'latest.ckpt')]
    paths += [MODEL / 'Qwen3-8B' / name for name in ('config.json', 'tokenizer.json', 'tokenizer_config.json', 'model.safetensors.index.json')]
    paths += [MODEL / 'Qwen3-8B' / f'model-{index:05d}-of-00005.safetensors' for index in range(1, 6)]
    paths += [MODEL / 'clip-vit-large-patch14' / name for name in ('config.json', 'model.safetensors', 'vocab.json', 'merges.txt')]
    paths += [SOURCE / 'stats' / name for name in ('Mean.npy', 'Std.npy')]
    paths += [SOURCE / 'scripts/gradio/static/assets/dump_wooden' / name for name in ('j_template.bin','v_template.bin','kintree.bin','faces.bin','skinIndice.bin','skinWeights.bin','joint_names.json')]
    return all(path.is_file() for path in paths)


def free_host_memory():
    if os.name == 'nt':
        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                        ('total_physical', ctypes.c_ulonglong), ('available_physical', ctypes.c_ulonglong),
                        ('total_pagefile', ctypes.c_ulonglong), ('available_pagefile', ctypes.c_ulonglong),
                        ('total_virtual', ctypes.c_ulonglong), ('available_virtual', ctypes.c_ulonglong),
                        ('available_extended_virtual', ctypes.c_ulonglong)]
        info = MemoryStatus(); info.length = ctypes.sizeof(info)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(info)):
            raise RuntimeError('Available system memory could not be measured.')
        return info.available_physical
    try:
        return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    except (ValueError, OSError, AttributeError) as error:
        raise RuntimeError('Available system memory could not be measured.') from error


def require_memory(*, loading, duration=3):
    host_gib, gpu_gib = (9, 28) if loading else ((4, 10) if duration <= 5 else (6, 18))
    if free_host_memory() < host_gib * 1024**3:
        raise RuntimeError(f'At least {host_gib} GiB of free system memory is required.')
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable in the HY-Motion runtime.')
    try:
        free, _ = torch.cuda.mem_get_info()
    except Exception as error:
        raise RuntimeError('Free GPU memory could not be measured.') from error
    if free < gpu_gib * 1024**3:
        raise RuntimeError(f'At least {gpu_gib} GiB of free GPU memory is required.')


def clear_cuda_cache():
    torch = sys.modules.get('torch')
    try:
        if torch is not None and torch.cuda.is_initialized():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load_worker():
    global model
    pipeline = None
    try:
        require_memory(loading=True)
        from hymotion_backend import load_motion_core, load_motion_text_encoder
        pipeline = load_motion_core(SOURCE, MODEL)
        if free_host_memory() < 9 * 1024**3:
            raise RuntimeError('At least 9 GiB of free system memory is required before loading the text encoders.')
        loaded = load_motion_text_encoder(pipeline, MODEL)
        with lock:
            model = loaded
            state.update(phase='ready', error=None)
    except Exception as error:
        traceback.print_exc()
        traceback.clear_frames(error.__traceback__)
        pipeline = None
        gc.collect()
        clear_cuda_cache()
        with lock:
            state.update(phase='error', error=str(error)[:1500])


def render_worker(job_id, request):
    temp = OUTPUTS / f'.{job_id}.part'
    try:
        with lock:
            jobs[job_id].update(status='running', message='Generating character motion.')
        require_memory(loading=False, duration=request.duration)
        from hymotion_backend import generate_motion
        bvh = generate_motion(model, request.prompt, duration=request.duration, seed=request.seed,
                              steps=request.steps, guidance=request.guidance)
        temp.write_text(bvh, encoding='utf-8')
        os.replace(temp, OUTPUTS / f'{job_id}.bvh')
        with lock:
            jobs[job_id].update(status='completed', message='Motion clip ready.')
            state.update(phase='ready', error=None)
    except Exception as error:
        traceback.print_exc()
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
        clear_cuda_cache()
        with lock:
            jobs[job_id].update(status='failed', message=str(error)[:1500])
            state.update(phase='ready' if model is not None else 'error', error=None)


class MotionRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=1000)
    duration: float = Field(default=3, ge=1, le=12, allow_inf_nan=False, strict=True)
    seed: int = Field(default=123, ge=0, le=2147483647, strict=True)
    steps: int = Field(default=50, ge=1, le=100, strict=True)
    guidance: float = Field(default=5, ge=0, le=20, allow_inf_nan=False, strict=True)


@app.get('/api/status')
def status():
    with lock:
        return {'engine': 'forge-hy-motion-v1', 'phase': state['phase'], 'loaded': model is not None,
                'model_downloaded': files_ready(), 'error': state['error']}


@app.post('/api/model/load', status_code=202)
def load():
    with lock:
        if state['closing']:
            raise HTTPException(409, 'Motion worker is stopping.')
        if model is not None:
            return {'message': 'Already loaded.'}
        if state['phase'] == 'loading':
            return {'message': 'Already loading.'}
        if state['phase'] == 'generating':
            raise HTTPException(409, 'Motion worker is busy.')
        if not files_ready():
            raise HTTPException(409, 'HY-Motion model files are missing.')
        state.update(phase='loading', error=None)
        try:
            threading.Thread(target=load_worker, daemon=True).start()
        except RuntimeError as error:
            state.update(phase='error', error=str(error)[:1500])
            raise HTTPException(503, 'Could not start the model loader.') from error
    return {'message': 'Loading started.'}


@app.post('/api/generate', status_code=202)
def generate(request: MotionRequest):
    if not request.prompt.strip():
        raise HTTPException(400, 'Describe the motion.')
    with lock:
        if state['closing'] or state['phase'] in ('loading', 'generating'):
            raise HTTPException(409, 'Motion worker is busy.')
        if model is None:
            raise HTTPException(409, 'Load HY-Motion first.')
        job_id = uuid.uuid4().hex
        jobs[job_id] = {'id': job_id, 'status': 'queued', 'message': 'Waiting for motion generation.'}
        state.update(phase='generating', error=None)
        try:
            threading.Thread(target=render_worker, args=(job_id, request), daemon=True).start()
        except RuntimeError as error:
            del jobs[job_id]
            state.update(phase='ready', error=None)
            raise HTTPException(503, 'Could not start motion generation.') from error
    return {'id': job_id}


@app.get('/api/jobs/{job_id}')
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(OUTPUTS, job_id, 'bvh', 'Recovered completed motion clip.')
        if job is None:
            raise HTTPException(404, 'Job not found.')
        return dict(job)


@app.get('/api/jobs/{job_id}/motion')
def motion(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(OUTPUTS, job_id, 'bvh', 'Recovered completed motion clip.')
        if job is None or job['status'] != 'completed':
            raise HTTPException(404, 'Motion clip not found.')
    return FileResponse(OUTPUTS / f'{job_id}.bvh', media_type='application/octet-stream')


def finish_stop():
    with lock:
        if state['closing']:
            os._exit(0)


@app.post('/api/forge/{action}')
def control(action: str, x_forge_engine_token: str = Header(default='')):
    global stop_timer
    if not TOKEN or not hmac.compare_digest(TOKEN, x_forge_engine_token):
        raise HTTPException(403, 'Forbidden.')
    with lock:
        if action == 'resume':
            if stop_timer:
                stop_timer.cancel(); stop_timer = None
            state['closing'] = False
            return {'resumed': True}
        if action != 'stop':
            raise HTTPException(404, 'Not found.')
        if state['phase'] in ('loading', 'generating'):
            raise HTTPException(409, 'Motion worker has active work.')
        state['closing'] = True
        if stop_timer is None:
            stop_timer = threading.Timer(1, finish_stop); stop_timer.daemon = True; stop_timer.start()
        return {'stopping': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)
