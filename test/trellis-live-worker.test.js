import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineManager, engineDefinitions } from '../runtime/engines.js';

// The worker binds its port asynchronously, so poll until the status endpoint answers.
async function waitFor(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for TRELLIS.2 worker');
}

test(
  'native TRELLIS.2 worker starts unloaded and can be guardedly stopped',
  { timeout: 25000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trellis-worker-'));
    // Ask the OS for a free loopback port, then release it so the worker can bind it.
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const original = engineDefinitions.find((item) => item.id === '3d-trellis');
    if (!original || process.platform !== 'win32') {
      t.skip('Windows native TRELLIS.2 worker required');
      return;
    }
    const definition = {
      ...original,
      port,
      args: ['-u', original.args[1], '--port', String(port)],
      env: { FORGE_RUNTIME_DIR: dir },
    };
    const manager = new EngineManager({ definitions: [definition], logDir: dir });
    // Cleanup must not hide the test's own failure, so an offload error is ignored and
    // the directory removal still runs.
    t.after(async () => {
      if (manager.owns('3d-trellis')) {
        await manager.offload('3d-trellis').catch(() => {});
      }
      await manager.recoveryReady;
      await manager.recoveryLock?.release();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const started = await manager.start('3d-trellis');
    assert.equal(started.status, 'starting');
    let status;
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        status = await response.json();
        return response.ok;
      } catch {
        return false;
      }
    });
    assert.equal(status.engine, 'forge-trellis2-512-experimental-v1');
    assert.equal(status.loaded, false);
    assert.equal(status.phase, 'idle');
    assert.equal(manager.canOffload('3d-trellis'), true);
    assert.equal((await manager.offload('3d-trellis')).stopped, true);
  },
);
