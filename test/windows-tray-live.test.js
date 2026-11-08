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

// Signal 0 only checks that the process exists; it does not stop it.
const isProcessGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
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
    // Drop inherited FORGE_* settings so the spawned Studio cannot reach the user's
    // runtime or projects.
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
        await waitFor(() => isProcessGone(state.trayPid), 12000).catch(() => {});
      }
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const heartbeat = await waitFor(async () => {
      const file = path.join(root, 'runtime', `tray-status-${port}.json`);
      // The status file may start with a byte order mark, which JSON.parse rejects.
      const candidate = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      return candidate.ownerPid === child.pid && candidate.pid ? candidate : null;
    });
    state.trayPid = heartbeat.pid;
    assert.notEqual(state.trayPid, child.pid);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/tray/status`)).json();
    assert.equal(status.active, true);
    child.kill();
    await waitFor(() => isProcessGone(state.trayPid), 12000);
  },
);
