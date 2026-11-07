import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const electron = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const probe = fileURLToPath(new URL('./fixtures/desktop-window-probe.js', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch {
      /* app is starting */
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for the desktop window.');
}

test(
  'real tray menu controls an Electron window, including when it is hidden',
  {
    skip: process.platform !== 'win32' || process.env.FORGE_RUN_TRAY_INTEGRATION !== '1',
    timeout: 60000,
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-desktop-window-'));
    const server = createServer((req, res) => {
      if (req.url === '/api/diagnostics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ server: { port, projectDirectory: appRoot, pid: process.pid } }));
      } else if (req.url === '/api/runtime/jobs' || req.url === '/api/runtime/services') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.url.endsWith('/jobs') ? '{"jobs":[]}' : '{"services":[]}');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Forge desktop test</title>');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const env = {
      ...process.env,
      FORGE_DESKTOP_USER_DATA: path.join(root, 'profile'),
      FORGE_DESKTOP_PROBE_DIR: root,
      FORGE_RUNTIME_DIR: path.join(root, 'runtime'),
      FORGE_TRAY_TEST_NO_TOAST: '1',
    };
    const child = spawn(electron, [probe, '--port', String(port)], {
      env,
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-4000);
    });
    const tray = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(appRoot, 'runtime', 'windows-tray.ps1'),
        '-Port',
        String(port),
        '-OwnerPid',
        String(process.pid),
        '-TestWindowActions',
      ],
      {
        env,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    tray.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-4000);
    });
    t.after(async () => {
      if (tray.exitCode === null && tray.signalCode === null) {
        tray.kill();
      }
      await fs.writeFile(path.join(root, 'stop'), '');
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([once(child, 'exit'), sleep(5000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const state = async () => JSON.parse(await fs.readFile(path.join(root, 'window.json'), 'utf8'));
    const waitState = (check) =>
      waitFor(async () => {
        const value = await state();
        return check(value) && value;
      });
    let sequence = 0;
    const action = async (name) =>
      fs.writeFile(
        path.join(root, 'runtime', `tray-test-command-${port}.json`),
        JSON.stringify({ sequence: ++sequence, action: name }),
      );
    await waitState((value) => value.visible);
    await waitFor(() =>
      fs.access(path.join(root, 'runtime', `tray-status-${port}.json`)).then(() => true),
    );
    await action('minimize');
    await waitState((value) => value.minimized);
    await action('maximize');
    await waitState((value) => value.visible && value.maximized && !value.minimized);
    await fs.writeFile(path.join(root, 'hide'), '');
    await waitState((value) => !value.visible);
    await action('maximize');
    await waitState((value) => value.visible && value.maximized && !value.minimized);
    await fs.writeFile(path.join(root, 'hide'), '');
    await waitState((value) => !value.visible);
    await action('open');
    assert.equal((await waitState((value) => value.visible && !value.minimized)).visible, true);
  },
);
