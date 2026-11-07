"""Guarded speech service lifecycle and connection fencing tests."""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
import asr_guard


async def request(port, route, token='control', method='POST'):
    reader, writer = await asyncio.open_connection('127.0.0.1', port)
    writer.write(f'{method} {route} HTTP/1.1\r\nHost: localhost\r\nX-Forge-Engine-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'.encode()); await writer.drain()
    data = await reader.read(); writer.close(); await writer.wait_closed(); return data


class GuardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        asr_guard.TOKEN = 'control'; self.release = asyncio.Event(); self.entered = asyncio.Event(); self.stopped = asyncio.Event()
        async def upstream(reader, writer):
            await reader.readuntil(b'\r\n\r\n'); self.entered.set(); await self.release.wait()
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'); await writer.drain(); writer.close()
        self.backend = await asyncio.start_server(upstream, '127.0.0.1', 0)
        self.guard = asr_guard.Guard(self.backend.sockets[0].getsockname()[1], self.stopped)
        self.proxy = await asyncio.start_server(self.guard.handle, '127.0.0.1', 0, limit=asr_guard.MAX_HEADER+1)
        self.port = self.proxy.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        self.release.set(); self.proxy.close(); self.backend.close(); await self.proxy.wait_closed(); await self.backend.wait_closed()
        if self.guard.stop_handle: self.guard.stop_handle.cancel()

    async def test_active_session_blocks_stop_and_idle_stop_fences_new_sessions(self):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        writer.write(b'POST /v1/audio/transcriptions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n'); await writer.drain(); await asyncio.wait_for(self.entered.wait(), 3)
        self.assertIn(b'403 Forbidden', await request(self.port, '/api/forge/stop', 'wrong'))
        self.assertIn(b'"active":1', await request(self.port, '/api/forge/status', method='GET'))
        self.assertIn(b'409 Conflict', await request(self.port, '/api/forge/stop'))
        self.release.set(); self.assertIn(b'200 OK', await reader.read()); writer.close(); await writer.wait_closed()
        for _ in range(100):
            if not self.guard.active: break
            await asyncio.sleep(.01)
        self.assertFalse(self.guard.active)
        self.assertIn(b'200 OK', await request(self.port, '/api/forge/stop'))
        blocked_reader, blocked_writer = await asyncio.open_connection('127.0.0.1', self.port)
        blocked_writer.write(b'GET /v1/models HTTP/1.1\r\nHost: localhost\r\n\r\n'); await blocked_writer.drain()
        self.assertIn(b'503 Service Unavailable', await blocked_reader.read()); blocked_writer.close(); await blocked_writer.wait_closed()
        self.assertIn(b'200 OK', await request(self.port, '/api/forge/resume'))
        await asyncio.sleep(1.1); self.assertFalse(self.stopped.is_set())

    async def test_health_probe_does_not_count_as_transcription(self):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        writer.write(b'GET /ready HTTP/1.1\r\nHost: localhost\r\n\r\n'); await writer.drain(); await asyncio.wait_for(self.entered.wait(), 3)
        self.assertIn(b'"active":0', await request(self.port, '/api/forge/status', method='GET'))
        self.assertIn(b'200 OK', await request(self.port, '/api/forge/stop'))
        self.release.set(); await reader.read(); writer.close(); await writer.wait_closed()

    async def test_recovery_identity_requires_token_and_instance_nonce(self):
        with patch.dict(os.environ, {'FORGE_ENGINE_INSTANCE_NONCE':'a'*64}):
            self.assertIn(b'403 Forbidden', await request(self.port, '/api/forge/identity', 'wrong', 'GET'))
            result = await request(self.port, '/api/forge/identity', 'control', 'GET')
            self.assertIn(b'200 OK', result)
            self.assertIn(b'"engine":"asr"', result)
            self.assertIn(b'"nonce":"'+b'a'*64+b'"', result)


@unittest.skipUnless(os.name == 'nt', 'Windows job objects are Windows-only')
class WindowsJobTests(unittest.TestCase):
    def test_closing_job_terminates_owned_child(self):
        job = asr_guard.WindowsJob()
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            job.add(child); self.assertIsNone(child.poll()); job.close(); child.wait(timeout=10); self.assertIsNotNone(child.returncode)
        finally:
            job.close()
            if child.poll() is None: child.kill(); child.wait(timeout=10)


if __name__ == '__main__': unittest.main()
