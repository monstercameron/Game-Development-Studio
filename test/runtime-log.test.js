import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeSupervisor } from '../runtime/supervisor.js';
import { createRuntimeLog } from '../runtime/runtime-log.js';

async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch {
      // The log entry may not have been written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error('Timed out waiting for runtime log');
}

test('runtime worker output and restart events remain available after a crash', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-runtime-log-'));
  const log = createRuntimeLog({ directory });
  const supervisor = new RuntimeSupervisor({
    workerUrl: new URL('./fixtures/log-worker.js', import.meta.url),
    restartDelay: 30,
    log: (...args) => log.write(...args),
  });
  t.after(() => {
    supervisor.stop();
    log.close();
  });
  supervisor.start();
  const pid = await waitFor(() => supervisor.ready && supervisor.child?.pid);
  await waitFor(async () => {
    const contents = await fs.readFile(path.join(directory, 'runtime-worker.log'), 'utf8');
    return contents.includes('Fixture worker error');
  });
  supervisor.child.kill();
  const next = await waitFor(
    () => supervisor.ready && supervisor.child?.pid !== pid && supervisor.child?.pid,
  );
  assert.notEqual(next, pid);
  const contents = await waitFor(async () => {
    const text = await fs.readFile(path.join(directory, 'runtime-worker.log'), 'utf8');
    return text.includes(`event=worker_stopped pid=${pid}`) &&
      text.includes(`event=worker_ready pid=${next}`)
      ? text
      : null;
  });
  assert.match(contents, /Fixture worker error/);
});
