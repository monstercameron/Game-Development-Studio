import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';
import { RuntimeSupervisor } from '../runtime/supervisor.js';

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for worker recovery.');
}

test('worker recovery keeps a model-load barrier while health still reports loading', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-worker-barrier-'));
  const queue = new JobQueue({ directory, autoStart: false });
  queue.suspendForModelLoad('music');
  assert.equal(queue.markModelLoadRequested('music'), true);
  queue.stop();

  let loading = true;
  const engine = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        api_version: '1',
        model: { loaded: true, loading },
      }),
    );
  });
  engine.listen(0, '127.0.0.1');
  await once(engine, 'listening');

  const supervisor = new RuntimeSupervisor({
    restartDelay: 50,
    env: {
      ...process.env,
      FORGE_RUNTIME_DIR: directory,
      FORGE_MUSIC_URL: `http://127.0.0.1:${engine.address().port}`,
    },
  });
  supervisor.start();
  t.after(async () => {
    supervisor.stop();
    await waitFor(() => supervisor.status().pid === null);
    await new Promise((resolve) => engine.close(resolve));
    const resolved = await fs.realpath(directory);
    const tempRoot = await fs.realpath(os.tmpdir());
    if (
      path.dirname(resolved) !== tempRoot ||
      !path.basename(resolved).startsWith('forge-worker-barrier-')
    ) {
      throw Error('Unexpected test directory.');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await waitFor(() => supervisor.status().ready);

  await assert.rejects(
    supervisor.call('clearMusicLoadBarrier', { confirmNotLoading: true }),
    /still loading/,
  );
  // Let several health polls run; the barrier must not clear while the engine still loads.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await supervisor.call('health')).modelLoadBarrier, 'loading');

  loading = false;
  await waitFor(async () => (await supervisor.call('health')).modelLoadBarrier === 'idle');
});
