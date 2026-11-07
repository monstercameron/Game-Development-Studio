"""Isolated Qwen3-TTS worker; Forge owns queuing and project asset storage."""
import argparse
import hmac
import os
from pathlib import Path
import sys
import threading
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import uvicorn

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_outputs import recovered_job
from engine_identity import install_identity_endpoint
MODEL = Path(os.environ.get('FORGE_TTS_MODEL', ROOT / 'models' / 'Qwen3-TTS-12Hz-1.7B-CustomVoice'))
OUTPUTS = Path(os.environ.get('FORGE_RUNTIME_DIR', ROOT / '.forge-runtime')) / 'tts-outputs'
OUTPUTS.mkdir(parents=True, exist_ok=True)
TOKEN = os.environ.get('FORGE_ENGINE_CONTROL_TOKEN', '')
SPEAKERS = ('Ryan', 'Aiden', 'Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ono_Anna', 'Sohee')
LANGUAGES = ('Auto', 'English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian')
lock = threading.Lock()
state = {'phase': 'idle', 'error': None, 'closing': False}
jobs = {}
model = None
stop_timer = None
app = FastAPI(title='Forge Qwen3-TTS worker')
install_identity_endpoint(app, TOKEN, 'tts')


def files_ready():
    return all((MODEL / item).is_file() for item in ('config.json', 'model.safetensors', 'speech_tokenizer/config.json', 'speech_tokenizer/model.safetensors'))


def load_worker():
    global model
    try:
        import torch
        from qwen_tts import Qwen3TTSModel
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA is unavailable in the configured speech runtime.')
        loaded = Qwen3TTSModel.from_pretrained(str(MODEL), device_map='cuda:0', dtype=torch.bfloat16,
                                              attn_implementation='eager', local_files_only=True)
        with lock:
            model = loaded
            state.update(phase='ready', error=None)
    except Exception as error:
        with lock:
            state.update(phase='error', error=str(error)[:1500])


def render_worker(job_id, request):
    try:
        import soundfile as sf
        with lock:
            jobs[job_id].update(status='running', message='Generating speech.')
        wavs, sample_rate = model.generate_custom_voice(text=request.text, language=request.language,
                                                        speaker=request.speaker, instruct=request.instruct,
                                                        max_new_tokens=request.max_new_tokens)
        if not wavs or len(wavs[0]) == 0:
            raise RuntimeError('The speech model returned empty audio.')
        temp = OUTPUTS / f'.{job_id}.part'
        sf.write(str(temp), wavs[0], sample_rate, format='WAV')
        os.replace(temp, OUTPUTS / f'{job_id}.wav')
        with lock:
            jobs[job_id].update(status='completed', message='Speech ready.')
            state.update(phase='ready', error=None)
    except Exception as error:
        with lock:
            jobs[job_id].update(status='failed', message=str(error)[:1500])
            state.update(phase='ready' if model is not None else 'error', error=None)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    speaker: str = 'Ryan'
    language: str = 'English'
    instruct: str = Field(default='', max_length=500)
    max_new_tokens: int = Field(default=1024, ge=64, le=2048)


@app.get('/api/status')
def status():
    with lock:
        return {'engine': 'forge-qwen3-tts-v1', 'phase': state['phase'], 'loaded': model is not None,
                'model_downloaded': files_ready(), 'error': state['error']}


@app.post('/api/model/load', status_code=202)
def load():
    with lock:
        if state['closing']:
            raise HTTPException(409, 'Speech worker is stopping.')
        if model is not None:
            return {'message': 'Already loaded.'}
        if state['phase'] == 'loading':
            return {'message': 'Already loading.'}
        if state['phase'] == 'generating':
            raise HTTPException(409, 'Speech worker is busy.')
        if not files_ready():
            raise HTTPException(409, 'Speech model files are missing.')
        state.update(phase='loading', error=None)
        threading.Thread(target=load_worker, daemon=True).start()
    return {'message': 'Loading started.'}


@app.post('/api/generate', status_code=202)
def generate(request: SpeechRequest):
    if not request.text.strip() or request.speaker not in SPEAKERS or request.language not in LANGUAGES:
        raise HTTPException(400, 'Invalid text, speaker, or language.')
    with lock:
        if state['closing'] or state['phase'] in ('loading', 'generating'):
            raise HTTPException(409, 'Speech worker is busy.')
        if model is None:
            raise HTTPException(409, 'Load the speech model first.')
        job_id = uuid.uuid4().hex
        jobs[job_id] = {'id': job_id, 'status': 'queued', 'message': 'Waiting for speech generation.'}
        state.update(phase='generating', error=None)
        threading.Thread(target=render_worker, args=(job_id, request), daemon=True).start()
    return {'id': job_id}


@app.get('/api/jobs/{job_id}')
def job_status(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(OUTPUTS, job_id, 'wav', 'Recovered completed speech.')
        if job is None:
            raise HTTPException(404, 'Job not found.')
        return dict(job)


@app.get('/api/jobs/{job_id}/audio')
def audio(job_id: str):
    with lock:
        job = jobs.get(job_id) or recovered_job(OUTPUTS, job_id, 'wav', 'Recovered completed speech.')
        if job is None or job['status'] != 'completed':
            raise HTTPException(404, 'Audio not found.')
    return FileResponse(OUTPUTS / f'{job_id}.wav', media_type='audio/wav')


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
        if state['phase'] in ('loading', 'generating'):
            raise HTTPException(409, 'Speech worker has active work.')
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
