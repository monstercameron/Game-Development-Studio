import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { createAutoMemoryManager } from '../runtime/auto-memory.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a replacement queue owner can reserve an engine without releasing the prior lease', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-queue-lock-race-'));
  const options = { directory, leaseMs: 50, autoStart: false };
  const previous = new JobQueue(options);
  const replacement = new JobQueue(options);
  t.after(async () => {
    if (!previous.stopped) {
      previous.stop();
    }
    if (!replacement.stopped) {
      replacement.stop();
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  previous.suspend('images');
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(replacement.lease(), true);
  replacement.suspend('images');
  assert.equal(replacement.suspendedEngines.has('images'), true);

  // Releasing the old process-local reservation must not release the new DB lease.
  previous.resume('images');
  assert.equal(
    replacement.db.prepare('SELECT owner FROM runtime_owner WHERE id=1').get().owner,
    replacement.owner,
  );
  assert.throws(() => previous.suspend('images'), /another runtime owns/i);
  replacement.resume('images');
});

test('cancelling a waiting job during guarded offload releases the engine reservation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-queue-cancel-offload-'));
  const projects = path.join(directory, 'projects');
  const project = path.join(projects, 'Example');
  const projectId = randomUUID();
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));

  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ready: true, files: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const previousVideoUrl = process.env.FORGE_VIDEO_URL;
  process.env.FORGE_VIDEO_URL = `http://127.0.0.1:${server.address().port}`;
  const offloadStarted = deferred();
  const finishOffload = deferred();
  const autoMemory = createAutoMemoryManager({
    services: async () => [
      {
        id: 'images',
        name: 'Image engine',
        status: 'reachable',
        managed: true,
        canUnload: true,
        busy: false,
        modelLoaded: true,
      },
    ],
    offload: async () => {
      offloadStarted.resolve();
      await finishOffload.promise;
      return { stopped: true };
    },
  });
  const queue = new JobQueue({
    directory: path.join(directory, 'runtime'),
    projects,
    autoStart: false,
    prepareVideo: async () => ({
      status: 'waiting_memory',
      stage: 'Waiting for GPU memory.',
      details: { code: 'insufficient_gpu_memory' },
    }),
    autoMemory,
  });

  t.after(async () => {
    queue.stop();
    await new Promise((resolve) => server.close(resolve));
    if (previousVideoUrl === undefined) {
      delete process.env.FORGE_VIDEO_URL;
    } else {
      process.env.FORGE_VIDEO_URL = previousVideoUrl;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const job = queue.enqueue({
    type: 'video',
    projectId,
    request: {
      prompt: 'A short test clip',
      references: [`${randomUUID()}.png`],
      aspect: 'landscape',
      frames: 56,
      steps: 8,
    },
  });

  const tick = queue.tick();
  await offloadStarted.promise;
  assert.equal(queue.get(job.id).status, 'waiting_memory');
  assert.equal(queue.suspendedEngines.has('images'), true);

  assert.equal(queue.cancel(job.id).status, 'cancelled');
  finishOffload.resolve();
  await tick;

  assert.equal(queue.get(job.id).status, 'cancelled');
  assert.equal(queue.suspendedEngines.has('images'), false);
  queue.suspend('images');
  assert.equal(queue.suspendedEngines.has('images'), true);
  queue.resume('images');
});
