import threading
from fastapi import FastAPI

app = FastAPI()
jobs = {}
lock = threading.Lock()

@app.get('/api/status')
def status():
    return {'status': 'ready', 'model_downloaded': True, 'busy': lock.locked()}

@app.post('/api/generate')
def generate():
    jobs['test'] = {'status': 'queued'}
    return {'id': 'test'}

@app.post('/finish')
def finish():
    if 'test' in jobs:
        jobs['test']['status'] = 'completed'
    return {'finished': True}
