import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createAutoMemoryManager } from '../runtime/auto-memory.js';
import { createImagePreparation } from '../runtime/image-preparation.js';
import { JobQueue } from '../runtime/jobs.js';

// One GiB in MiB, the unit of the GPU snapshot.
const GiB = 1024;
const TOTAL_MIB = 96 * GiB;

// A loopback fake stands in for Qwen Image Studio and the GPU monitor. These tests prove the
// queue's memory-wait handling (who is released, when the check repeats, what is never stopped),
// not real inference or real GPU memory.
async function startFixture(
  t,
  { freeMiB, canRestart, isOwned = true, memoryWaitLimitMs, readingAgeMs = 0 },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-image-memory-'));
  const projects = path.join(dir, 'projects');
  const project = path.join(projects, 'Fixture');
  const projectId = randomUUID();
  await fs.mkdir(path.join(project, 'images'), { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const world = {
    loaded: true,
    busy: false,
    freeMiB,
    readingAgeMs,
    // Holds a stop open so a test can look at the job while the engine is being stopped.
    offloadGate: Promise.resolve(),
    offloads: 0,
    generates: 0,
  };
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') {
      return res.end(
        JSON.stringify({
          status: world.loaded ? 'ready' : 'not loaded',
          model_downloaded: true,
          busy: world.busy,
        }),
      );
    }
    if (req.url === '/api/generate' && req.method === 'POST') {
      world.generates += 1;
      req.resume();
      res.statusCode = 202;
      return res.end(JSON.stringify({ id: 'remote-image' }));
    }
    if (req.url === '/api/jobs/remote-image') {
      return res.end(JSON.stringify({ status: 'running', message: 'Rendering' }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const previous = process.env.FORGE_IMAGE_URL;
  process.env.FORGE_IMAGE_URL = `http://127.0.0.1:${http.address().port}`;
  const hardware = async () => ({
    devices: [{ index: 0, name: 'GPU', freeMiB: world.freeMiB, totalMiB: TOTAL_MIB }],
    measuredAt: new Date(Date.now() - world.readingAgeMs).toISOString(),
  });
  const services = async () => [
    {
      id: 'images',
      name: 'Qwen Image 2.1',
      status: 'reachable',
      managed: isOwned,
      canUnload: isOwned,
      busy: world.busy,
      modelLoaded: world.loaded,
    },
  ];
  const autoMemory = createAutoMemoryManager({
    services,
    canRestart: () => canRestart,
    offload: async (id) => {
      assert.equal(id, 'images');
      world.offloads += 1;
      await world.offloadGate;
      // The restarted engine holds no model, and its cached memory is back with the GPU.
      world.loaded = false;
      world.freeMiB = 70 * GiB;
      return { stopped: true };
    },
  });
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    leaseMs: 1000,
    intervalMs: 40,
    prepareImage: createImagePreparation({ hardware, services }),
    autoMemory,
    ...(memoryWaitLimitMs === undefined ? {} : { memoryWaitLimitMs }),
  });
  t.after(async () => {
    queue.stop();
    http.closeAllConnections();
    http.close();
    if (previous === undefined) {
      delete process.env.FORGE_IMAGE_URL;
    } else {
      process.env.FORGE_IMAGE_URL = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { queue, world, projectId };
}

async function waitFor(condition, what) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`Timed out waiting for ${what}.`);
}

const large = { prompt: 'a vault', width: 1664, height: 928, seed: 1 };

test(
  'an idle loaded engine that holds the memory is released and the render proceeds by itself',
  { timeout: 15000 },
  async (t) => {
    // 20.1 GiB free on a 96 GiB card with the model loaded: 0.9 GiB short of the working set.
    const { queue, world, projectId } = await startFixture(t, {
      freeMiB: Math.round(20.1 * GiB),
      canRestart: true,
    });
    const job = queue.enqueue({ type: 'images', projectId, request: large });
    await waitFor(() => world.generates === 1, 'the render to reach the engine');
    assert.equal(world.offloads, 1, 'the idle engine was stopped once');
    assert.ok(['submitting', 'running'].includes(queue.get(job.id).status));
  },
);

test('the engine is not released when nothing restarts it', { timeout: 15000 }, async (t) => {
  const { queue, world, projectId } = await startFixture(t, {
    freeMiB: Math.round(20.1 * GiB),
    canRestart: false,
  });
  const job = queue.enqueue({ type: 'images', projectId, request: large });
  await waitFor(() => queue.get(job.id).status === 'waiting_memory', 'the memory wait');
  // Several queue ticks pass; the render keeps waiting and the engine is left running.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(queue.get(job.id).status, 'waiting_memory');
  assert.equal(world.offloads, 0);
  assert.equal(world.generates, 0);
});

test('a busy engine is never released', { timeout: 15000 }, async (t) => {
  const { queue, world, projectId } = await startFixture(t, {
    freeMiB: Math.round(20.1 * GiB),
    canRestart: true,
  });
  world.busy = true;
  const job = queue.enqueue({ type: 'images', projectId, request: large });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(world.offloads, 0);
  assert.equal(world.generates, 0);
  assert.notEqual(queue.get(job.id).status, 'completed');
});

test('a waiting render re-checks memory on its own and proceeds once it frees up', async (t) => {
  // Without a way to restart the engine nothing is released; memory freeing elsewhere is enough.
  const { queue, world, projectId } = await startFixture(t, {
    freeMiB: Math.round(20.1 * GiB),
    canRestart: false,
  });
  const job = queue.enqueue({ type: 'images', projectId, request: large });
  await waitFor(() => queue.get(job.id).status === 'waiting_memory', 'the memory wait');
  assert.equal(world.generates, 0);
  world.freeMiB = 30 * GiB;
  await waitFor(() => world.generates === 1, 'the automatic re-check to submit the render');
  assert.equal(world.offloads, 0);
});

test('a waiting render records why it waits, when it checks and that the budget is an estimate', async (t) => {
  const { queue, world, projectId } = await startFixture(t, {
    freeMiB: Math.round(20.1 * GiB),
    canRestart: false,
  });
  const job = queue.enqueue({ type: 'images', projectId, request: large });
  await waitFor(() => queue.get(job.id).details?.memoryWait?.checks >= 3, 'three memory checks');
  const wait = queue.get(job.id).details.memoryWait;
  assert.equal(wait.reason, 'insufficient_gpu_memory');
  assert.equal(wait.memory, 'gpu');
  assert.equal(wait.basis, 'working_memory_only');
  assert.equal(wait.estimate, 'conservative_estimate');
  assert.match(wait.estimateNote, /uncalibrated/i);
  assert.equal(wait.availableMiB, Math.round(20.1 * GiB));
  assert.ok(wait.requiredMiB > wait.availableMiB && wait.shortfallMiB > 0);
  assert.equal(wait.totalMiB, TOTAL_MIB);
  // Times are ISO strings: the wait began before the last check, and the next one is scheduled.
  assert.ok(Date.parse(wait.since) <= Date.parse(wait.lastCheckedAt));
  assert.ok(Date.parse(wait.nextCheckAt) > Date.parse(wait.lastCheckedAt));
  assert.ok(Date.parse(wait.expiresAt) > Date.parse(wait.since));
  assert.ok(Date.parse(wait.readingAt) <= Date.parse(wait.lastCheckedAt));
  // The queue tried to make room and found nothing it may stop (nothing restarts the engine).
  assert.equal(wait.lastAction.kind, 'release_idle_engine');
  assert.equal(wait.lastAction.outcome, 'unavailable');
  assert.equal(world.offloads, 0);
});

test(
  'a render that waits too long fails with the reason, and a retry runs it',
  {
    timeout: 15000,
  },
  async (t) => {
    const { queue, world, projectId } = await startFixture(t, {
      freeMiB: Math.round(20.1 * GiB),
      canRestart: false,
      memoryWaitLimitMs: 400,
    });
    const job = queue.enqueue({ type: 'images', projectId, request: large });
    await waitFor(() => queue.get(job.id).status === 'failed', 'the wait to end');
    const failed = queue.get(job.id);
    assert.match(failed.error, /Gave up after waiting/);
    assert.match(failed.error, /21\.0 GiB needed \(a conservative estimate\), 20\.1 GiB available/);
    assert.match(failed.error, /retry/i);
    assert.equal(failed.details.memoryWait.reason, 'insufficient_gpu_memory');
    assert.equal(failed.details.memoryWait.nextCheckAt, null);
    // Nothing reached the engine and nothing was stopped, so retrying is safe.
    assert.equal(world.generates, 0);
    assert.equal(world.offloads, 0);
    world.freeMiB = 40 * GiB;
    queue.retry(job.id);
    await waitFor(() => world.generates === 1, 'the retried render to reach the engine');
    assert.equal(queue.get(job.id).details, null);
  },
);

test(
  'an engine Forge does not own is never stopped, however long the render waits',
  {
    timeout: 15000,
  },
  async (t) => {
    const { queue, world, projectId } = await startFixture(t, {
      freeMiB: Math.round(20.1 * GiB),
      canRestart: true,
      isOwned: false,
    });
    const job = queue.enqueue({ type: 'images', projectId, request: large });
    await waitFor(() => queue.get(job.id).details?.memoryWait?.checks >= 3, 'three memory checks');
    assert.equal(queue.get(job.id).status, 'waiting_memory');
    assert.equal(queue.get(job.id).details.memoryWait.lastAction.outcome, 'unavailable');
    assert.equal(world.offloads, 0);
    assert.equal(world.generates, 0);
  },
);

test(
  'while an idle engine is stopped for a render, the job names the engine and the reason',
  { timeout: 15000 },
  async (t) => {
    const { queue, world, projectId } = await startFixture(t, {
      freeMiB: Math.round(20.1 * GiB),
      canRestart: true,
    });
    let openGate;
    world.offloadGate = new Promise((resolve) => {
      openGate = resolve;
    });
    const job = queue.enqueue({ type: 'images', projectId, request: large });
    await waitFor(() => world.offloads === 1, 'the stop to begin');
    const action = queue.get(job.id).details.memoryWait.lastAction;
    assert.equal(action.kind, 'release_idle_engine');
    assert.equal(action.outcome, 'stopping');
    assert.equal(action.engineId, 'images');
    assert.equal(action.isRequestedEngine, true);
    assert.match(queue.get(job.id).stage, /Making room: stopping idle Qwen Image 2.1/);
    openGate();
    await waitFor(() => world.generates === 1, 'the render to reach the engine');
  },
);

test(
  'a stale GPU reading is never used to admit a render; a fresh one is',
  {
    timeout: 15000,
  },
  async (t) => {
    const { queue, world, projectId } = await startFixture(t, {
      freeMiB: 60 * GiB,
      canRestart: false,
      readingAgeMs: 120000,
    });
    const job = queue.enqueue({ type: 'images', projectId, request: large });
    await waitFor(() => queue.get(job.id).status === 'needs_attention', 'the stale reading');
    assert.match(queue.get(job.id).error, /120 seconds old/);
    assert.equal(world.generates, 0);
    world.readingAgeMs = 0;
    queue.retry(job.id);
    await waitFor(() => world.generates === 1, 'the fresh reading to admit the render');
  },
);
