import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test(
  'the real Windows tray message loop stays responsive while a queue request stalls',
  {
    skip: process.platform !== 'win32' || process.env.FORGE_RUN_TRAY_INTEGRATION !== '1',
    timeout: 20000,
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tray-responsive-'));
    const server = createServer((req, res) => {
      if (req.url === '/api/runtime/jobs') {
        const delayed = setTimeout(() => {
          res.writeHead(200);
          res.end('{"jobs":[]}');
        }, 6000);
        res.on('close', () => clearTimeout(delayed));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"services":[]}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const script = fileURLToPath(new URL('../runtime/windows-tray.ps1', import.meta.url));
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Port',
        String(port),
        '-OwnerPid',
        String(process.pid),
        '-TestResponsiveness',
      ],
      {
        env: { ...process.env, FORGE_RUNTIME_DIR: root, FORGE_TRAY_TEST_NO_TOAST: '1' },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let errors = '';
    child.stderr.on('data', (data) => {
      errors += data;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const marker = path.join(root, `tray-responsive-${port}.txt`);
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      try {
        await fs.access(marker);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.fail(`The tray message loop stalled while the server was slow. ${errors}`);
  },
);
