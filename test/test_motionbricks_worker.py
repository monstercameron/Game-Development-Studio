"""Worker HTTP behavior without loading a real motion model."""
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import numpy as np
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
import motionbricks_worker as worker
import motionbricks_backend as backend
import motionbricks_bvh as bvh


def http(base, path, body=None, headers=None):
    request = Request(base + path, None if body is None else json.dumps(body).encode(),
                      {'Content-Type': 'application/json', **(headers or {})})
    try:
        with urlopen(request, timeout=5) as response: return response.status, response.read()
    except HTTPError as error: return error.code, error.read()


def wait_for(predicate):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        result = predicate()
        if result: return result
        time.sleep(.02)
    raise AssertionError('Timed out.')


class WorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(); worker.OUTPUTS = Path(cls.temp.name); worker.TOKEN = 'control'
        sock = socket.socket(); sock.bind(('127.0.0.1', 0)); sock.listen(128)
        cls.base = f'http://127.0.0.1:{sock.getsockname()[1]}'
        cls.server = uvicorn.Server(uvicorn.Config(worker.app, log_level='error', access_log=False))
        cls.thread = threading.Thread(target=cls.server.run, kwargs={'sockets': [sock]}, daemon=True)
        cls.thread.start(); wait_for(lambda: cls.server.started)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True; cls.thread.join(timeout=5); cls.temp.cleanup()

    def setUp(self):
        with worker.lock:
            worker.session = None; worker.current_rig = None
            worker.state.update(phase='idle', error=None, closing=False); worker.jobs.clear()

    def test_memory_failure_does_not_load_model(self):
        with patch.object(worker, 'files_ready', return_value=True), patch.object(worker, 'available_memory', return_value=2*1024**3), patch.object(backend, 'load_model') as loader:
            self.assertEqual(http(self.base, '/api/model/load', {'rig':'soma'})[0], 202)
            wait_for(lambda: json.loads(http(self.base, '/api/status')[1])['phase'] == 'error')
            loader.assert_not_called()

    def test_generate_guard_and_recover_completed_output(self):
        entered, release = threading.Event(), threading.Event()
        def fake_infer(session, rig, tensors):
            entered.set()
            if not release.wait(5): raise RuntimeError('Timed out.')
            return {'pred_num_tokens': np.array([6]), 'pred_global_motions': np.zeros((1,64,366))}
        tensors = {name: np.zeros(shape).tolist() for name,shape in backend.FLOATS['soma'].items()}
        tensors.update({name: np.ones(shape,dtype=int).tolist() for name,shape in backend.MASKS.items()})
        with patch.object(worker, 'files_ready', return_value=True), patch.object(worker, 'require_memory'), patch.object(worker, 'require_gpu_memory'), patch.object(backend, 'load_model', return_value=object()), patch.object(backend, 'infer', side_effect=fake_infer):
            self.assertEqual(http(self.base, '/api/model/load', {'rig':'g1'})[0], 400)
            self.assertEqual(http(self.base, '/api/model/load', {'rig':'soma'})[0], 202)
            wait_for(lambda: json.loads(http(self.base, '/api/status')[1])['loaded'])
            self.assertEqual(http(self.base, '/api/generate', {'rig':'soma','tensors':{}})[0], 400)
            status, data = http(self.base, '/api/generate', {'rig':'soma','tensors':tensors}); self.assertEqual(status, 202)
            job_id = json.loads(data)['id']
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(http(self.base, '/api/forge/stop', {}, {'X-Forge-Engine-Token':'control'})[0], 409)
            finally: release.set()
            wait_for(lambda: json.loads(http(self.base, '/api/jobs/'+job_id)[1])['status']=='completed')
            with worker.lock: worker.jobs.clear()
            status, data = http(self.base, '/api/jobs/'+job_id); self.assertEqual(status, 200)
            self.assertTrue(json.loads(data)['recovered'])
            status, data = http(self.base, '/api/jobs/'+job_id+'/output'); self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)['tensors']['pred_num_tokens'], [6])
            self.assertEqual(http(self.base, '/api/forge/stop', {})[0], 403)

    def test_bvh_generation_is_atomic_and_recoverable(self):
        entered, release = threading.Event(), threading.Event()
        def fake_infer(session, rig, tensors):
            entered.set()
            if not release.wait(5): raise RuntimeError('Timed out.')
            return {'motion': 'fixture'}
        with patch.object(bvh, 'parse_bvh', return_value='clip'), patch.object(bvh, 'encode_pose_windows', return_value=('tensors', 'alignment')), patch.object(bvh, 'decode_bvh', return_value='HIERARCHY\nMOTION\nfixture\n'), patch.object(worker, 'require_memory'), patch.object(worker, 'require_gpu_memory'), patch.object(backend, 'infer', side_effect=fake_infer):
            with worker.lock: worker.session = object(); worker.current_rig = 'soma'; worker.state['phase'] = 'ready'
            request = {'bvh':'fixture', 'context_frame':0, 'target_frame':20, 'min_tokens':8, 'max_tokens':14}
            code, data = http(self.base, '/api/generate-bvh', request); self.assertEqual(code, 202)
            job_id = json.loads(data)['id']
            try:
                self.assertTrue(entered.wait(5))
                self.assertEqual(http(self.base, '/api/forge/stop', {}, {'X-Forge-Engine-Token':'control'})[0], 409)
                self.assertEqual(http(self.base, '/api/generate-bvh', request)[0], 409)
                self.assertFalse((worker.OUTPUTS / f'{job_id}.bvh').exists())
            finally: release.set()
            wait_for(lambda: json.loads(http(self.base, '/api/jobs/'+job_id)[1])['status']=='completed')
            with worker.lock: worker.jobs.clear()
            code, data = http(self.base, '/api/jobs/'+job_id); self.assertEqual(code, 200)
            self.assertTrue(json.loads(data)['recovered'])
            code, data = http(self.base, '/api/jobs/'+job_id+'/output'); self.assertEqual(code, 200)
            self.assertEqual(data.decode().replace('\r\n', '\n'), 'HIERARCHY\nMOTION\nfixture\n')
            self.assertEqual(http(self.base, '/api/jobs/not-an-id/output')[0], 404)


if __name__ == '__main__': unittest.main()
