"""Experimental isolated SAM 3.1 image worker."""
import argparse
import base64
import binascii
import ctypes
import gc
import hmac
import io
import os
from pathlib import Path
import sys
import threading
import traceback
from typing import Literal
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
import uvicorn

ROOT = Path(__file__).resolve().parent.parent
# The isolated embedded Python ._pth does not add the script directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_outputs import recovered_job
from engine_identity import install_identity_endpoint
MODEL = Path(os.environ.get('FORGE_SAM31_MODEL', ROOT / 'models' / 'sam3.1' / 'sam3.1_multiplex.pt'))
OUTPUTS = Path(os.environ.get('FORGE_RUNTIME_DIR', ROOT / '.forge-runtime')) / 'sam31-outputs'
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get('FORGE_ENGINE_CONTROL_TOKEN', '')
os.environ.setdefault('HF_HUB_OFFLINE', '1')
app = FastAPI(title='Forge SAM 3.1 experimental worker')
install_identity_endpoint(app, TOKEN, 'segmentation')
lock = threading.Lock()
state = {'phase': 'idle', 'error': None, 'closing': False}
jobs = {}
model = None
stop_timer = None


def free_host_memory():
    if os.name == 'nt':
        class MemoryStatus(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                        ('total_physical', ctypes.c_ulonglong), ('available_physical', ctypes.c_ulonglong),
                        ('total_pagefile', ctypes.c_ulonglong), ('available_pagefile', ctypes.c_ulonglong),
                        ('total_virtual', ctypes.c_ulonglong), ('available_virtual', ctypes.c_ulonglong),
                        ('available_extended_virtual', ctypes.c_ulonglong)]
        info = MemoryStatus()
        info.length = ctypes.sizeof(info)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(info)):
            raise RuntimeError('Available system memory could not be measured.')
        return info.available_physical
    try:
        return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
    except (ValueError, OSError, AttributeError) as error:
        raise RuntimeError('Available system memory could not be measured.') from error


def require_memory(*, loading):
    # Conservative estimates, not reservations. Actual SAM budgets are uncalibrated.
    host_gib, gpu_gib = (9, 14) if loading else (3, 10)
    if free_host_memory() < host_gib * 1024**3:
        raise RuntimeError(f'At least {host_gib} GiB of free system memory is required.')
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable in the SAM 3.1 runtime.')
    try:
        free, _ = torch.cuda.mem_get_info()
    except Exception as error:
        raise RuntimeError('Free GPU memory could not be measured.') from error
    if free < gpu_gib * 1024**3:
        raise RuntimeError(f'At least {gpu_gib} GiB of free GPU memory is required.')


def load_detector():
    from sam31_backend import load_detector as load
    return load(MODEL)


def run_segmentation(processor, image, request):
    from sam31_backend import segment_image
    return segment_image(processor, image, request.prompt, output=request.output, confidence=request.confidence)


def clear_cuda_cache():
    torch = sys.modules.get('torch')
    try:
        if torch is not None and torch.cuda.is_initialized():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load_worker():
    global model
    try:
        require_memory(loading=True)
        loaded = load_detector()
        with lock:
            model = loaded
            state.update(phase='ready', error=None)
    except Exception as error:
        traceback.print_exc()
        gc.collect()
        clear_cuda_cache()
        with lock:
            state.update(phase='error', error=str(error)[:1500])


def render_worker(job_id, image, request):
    temp = OUTPUTS / f'.{job_id}.part'
    try:
        with lock:
            jobs[job_id].update(status='running', message='Segmenting image.')
        require_memory(loading=False)
        result, metadata = run_segmentation(model, image, request)
        result.save(temp, format='PNG')
        os.replace(temp, OUTPUTS / f'{job_id}.png')
        with lock:
            jobs[job_id].update(status='completed', message='Segmentation ready.', metadata=metadata)
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


class SegmentRequest(BaseModel):
    image: str = Field(min_length=1, max_length=14_000_000)
    prompt: str = Field(min_length=1, max_length=1000)
    output: Literal['transparent', 'mask'] = 'transparent'
    confidence: float = Field(default=0.5, ge=0, le=1, allow_inf_nan=False, strict=True)


@app.get('/api/status')
def status():
    with lock:
        return {'engine': 'forge-sam31-image-experimental-v1', 'phase': state['phase'],
                'loaded': model is not None, 'model_downloaded': MODEL.is_file(), 'error': state['error']}


@app.post('/api/model/load', status_code=202)
def load():
    with lock:
        if state['closing']:
            raise HTTPException(409, 'Segmentation worker is stopping.')
        if model is not None:
            return {'message': 'Already loaded.'}
        if state['phase'] == 'loading':
            return {'message': 'Already loading.'}
        if state['phase'] in ('preparing', 'generating'):
            raise HTTPException(409, 'Segmentation worker is busy.')
        if not MODEL.is_file():
            raise HTTPException(409, 'SAM 3.1 model file is missing.')
        state.update(phase='loading', error=None)
        try:
            threading.Thread(target=load_worker, daemon=True).start()
        except RuntimeError as error:
            state.update(phase='error', error=str(error)[:1500])
            raise HTTPException(503, 'Could not start the model loader.') from error
    return {'message': 'Loading started.'}


@app.post('/api/generate', status_code=202)
def generate(request: SegmentRequest):
    if not request.prompt.strip():
        raise HTTPException(400, 'Describe what to isolate.')
    with lock:
        if state['closing'] or state['phase'] in ('preparing', 'loading', 'generating'):
            raise HTTPException(409, 'Segmentation worker is busy.')
        if model is None:
            raise HTTPException(409, 'Load the SAM 3.1 model first.')
        state.update(phase='preparing', error=None)
    try:
        prefix, data = request.image.split(',', 1)
        if prefix not in ('data:image/png;base64', 'data:image/jpeg;base64', 'data:image/webp;base64'):
            raise ValueError('Unsupported image.')
        raw = base64.b64decode(data, validate=True)
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError('Image is too large.')
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > 20_000_000:
                raise ValueError('Image dimensions are too large.')
            image = ImageOps.exif_transpose(source).convert('RGBA')
    except (ValueError, binascii.Error, OSError, Image.DecompressionBombError) as error:
        with lock:
            state.update(phase='ready', error=None)
        raise HTTPException(400, f'Invalid reference image: {error}') from error
    except Exception as error:
        traceback.print_exc()
        with lock:
            state.update(phase='ready', error=None)
        raise HTTPException(500, 'Could not prepare the reference image. Check worker logs.') from error
    with lock:
        job_id = uuid.uuid4().hex
        jobs[job_id] = {'id': job_id, 'status': 'queued', 'message': 'Waiting for segmentation.'}
        state.update(phase='generating', error=None)
        try:
            threading.Thread(target=render_worker, args=(job_id, image, request), daemon=True).start()
        except RuntimeError as error:
            del jobs[job_id]
            state.update(phase='ready', error=None)
            raise HTTPException(503, 'Could not start segmentation.') from error
    return {'id': job_id}


@app.get('/api/jobs/{job_id}')
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(OUTPUTS, job_id, 'png', 'Recovered completed segmentation.')
        if job is None:
            raise HTTPException(404, 'Job not found.')
        return dict(job)


@app.get('/api/jobs/{job_id}/image')
def output_image(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(OUTPUTS, job_id, 'png', 'Recovered completed segmentation.')
        if job is None or job['status'] != 'completed':
            raise HTTPException(404, 'Image not found.')
    return FileResponse(OUTPUTS / f'{job_id}.png', media_type='image/png')


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
                stop_timer.cancel()
                stop_timer = None
            state['closing'] = False
            return {'resumed': True}
        if action != 'stop':
            raise HTTPException(404, 'Not found.')
        if state['phase'] in ('preparing', 'loading', 'generating'):
            raise HTTPException(409, 'Segmentation worker has active work.')
        state['closing'] = True
        if stop_timer is None:
            stop_timer = threading.Timer(1, finish_stop)
            stop_timer.daemon = True
            stop_timer.start()
        return {'stopping': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False)
