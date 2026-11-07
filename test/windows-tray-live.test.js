import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch {
      /* service is starting */
    }
    await sleep(200);
  }
  throw new Error('Timed out waiting for the isolated tray.');
}

test(
  'real Windows tray follows the lifetime of its isolated Studio supervisor',
  {
    skip: process.platform !== 'win32' || process.env.FORGE_RUN_TRAY_INTEGRATION !== '1',
    timeout: 40000,
  },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tray-live-'));
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('FORGE_')),
    );
    Object.assign(environment, {
      FORGE_RUNTIME_DIR: path.join(root, 'runtime'),
      FORGE_PROJECTS_DIR: path.join(root, 'projects'),
      FORGE_ENGINE_CONFIG: '[]',
      FORGE_TRAY_TEST_NO_TOAST: '1',
    });
    const serverEntry = fileURLToPath(new URL('../server.js', import.meta.url));
    const child = spawn(process.execPath, [serverEntry, '--port', String(port)], {
      env: environment,
      windowsHide: true,
      stdio: 'ignore',
    });
    const state = { trayPid: null };
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      if (state.trayPid) {
        await waitFor(() => {
          try {
            process.kill(state.trayPid, 0);
            return false;
          } catch {
            return true;
          }
        }, 12000).catch(() => {});
      }
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const heartbeat = await waitFor(async () => {
      const file = path.join(root, 'runtime', `tray-status-${port}.json`);
      const value = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      return value.ownerPid === child.pid && value.pid ? value : null;
    });
    state.trayPid = heartbeat.pid;
    assert.notEqual(state.trayPid, child.pid);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/tray/status`)).json();
    assert.equal(status.active, true);
    child.kill();
    await waitFor(() => {
      try {
        process.kill(state.trayPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 12000);
  },
);
