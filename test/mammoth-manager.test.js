import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineManager } from '../runtime/engines.js';

const desktop = path.join(os.homedir(), 'Desktop');
const python = path.join(desktop, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe');
const mammoth = path.join(desktop, 'Mammoth Studio');
// Mammoth is a local Windows install beside the studio, so every other setup skips this test.
const available =
  process.platform === 'win32' && existsSync(python) && existsSync(path.join(mammoth, 'server.py'));

test(
  'supervisor owns an isolated unloaded Mammoth worker and safely offloads it',
  { skip: !available, timeout: 20000 },
  async (t) => {
    // Probe for a free loopback port, then release it so the worker can bind it.
    const socket = createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const logDir = await mkdtemp(path.join(os.tmpdir(), 'forge-mammoth-'));
    const worker = fileURLToPath(new URL('../runtime/mammoth_worker.py', import.meta.url));
    const definition = {
      id: 'game',
      name: 'Mammoth test',
      port,
      endpoint: '/health',
      kind: 'mammoth',
      cwd: mammoth,
      command: python,
      args: ['-u', worker, '--port', String(port), '--engine-dir', mammoth],
      quiesce: 'mammoth-v1',
      onDemand: true,
    };
    const manager = new EngineManager({ definitions: [definition], logDir });
    // Kill the worker even when an assertion fails, so no child process outlives the test.
    t.after(() => {
      manager.closed = true;
      manager.children.get('game')?.child.kill();
    });
    const started = await manager.start('game');
    assert.equal(started.status, 'starting');
    let state = null;
    // Poll with a deadline (100 x 100 ms) instead of one fixed sleep, since startup time varies.
    for (let i = 0; i < 100 && !state; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await manager.gameActivity();
    }
    assert.ok(state, 'managed worker did not become ready');
    // Starting unloaded means offload only stops the process and never touches model weights.
    assert.equal(state.loaded, false);
    assert.equal(state.loading, false);
    assert.equal(manager.canOffload('game'), true);
    const stopped = await manager.offload('game');
    assert.equal(stopped.stopped, true);
    assert.equal(manager.owns('game'), false);
  },
);
