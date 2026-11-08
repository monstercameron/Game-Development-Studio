import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAutoMemoryManager } from '../runtime/auto-memory.js';
import { createMusicPreparation } from '../runtime/music-preparation.js';
import { JobQueue } from '../runtime/jobs.js';

const service = (id, extra = {}) => ({
  id,
  name: id,
  status: 'reachable',
  managed: true,
  canUnload: true,
  busy: false,
  modelLoaded: true,
  ...extra,
});
const hooks = {
  target: 'music',
  upcoming: [],
  isCurrent: () => true,
  announce: () => true,
  reserve: () => {},
  release: () => {},
};

test('only guarded, owned, verified idle models are automatically stopped; preserve the next model', async () => {
  const stopped = [];
  const manager = createAutoMemoryManager({
    services: async () => [
      service('sfx'),
      service('asr'),
      service('game'),
      service('tts', { busy: true }),
      service('3d-trellis', { managed: false }),
      service('images', { busy: null }),
      service('motion-hy'),
      service('segmentation'),
    ],
    offload: async (id) => {
      stopped.push(id);
      return { stopped: true };
    },
  });
  const result = await manager({ ...hooks, upcoming: ['motion-hy'] });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(stopped, ['segmentation']);
});

test('cancelled jobs do not stop a model and failed stops cool down', async () => {
  let calls = 0,
    time = 100;
  const manager = createAutoMemoryManager({
    services: async () => [service('tts')],
    offload: async () => {
      calls++;
      throw Error('busy');
    },
    now: () => time,
    cooldownMs: 1000,
  });
  assert.equal((await manager({ ...hooks, isCurrent: () => false })).status, 'cancelled');
  assert.equal(calls, 0);
  assert.equal((await manager(hooks)).status, 'failed');
  assert.equal(calls, 1);
  assert.equal((await manager(hooks)).status, 'unavailable');
  assert.equal(calls, 1);
  time += 1001;
  assert.equal((await manager(hooks)).status, 'failed');
  assert.equal(calls, 2);
});

test('cancelling while checking services prevents an automatic stop', async () => {
  let resolve,
    active = true,
    stopped = 0;
  const manager = createAutoMemoryManager({
    services: () =>
      new Promise((resolveServices) => {
        resolve = resolveServices;
      }),
    offload: async () => {
      stopped++;
      return { stopped: true };
    },
  });
  const pending = manager({ ...hooks, isCurrent: () => active });
  active = false;
  resolve([service('tts')]);
  assert.equal((await pending).status, 'cancelled');
  assert.equal(stopped, 0);
});

// Wiring test: a loopback fake stands in for the music engine. It proves the queue, memory
// recheck and load-barrier handoff, not generated audio or real GPU inference.
test(
  'a queued render frees an idle model, rechecks memory, loads and completes',
  { timeout: 12000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-auto-memory-'));
    const projects = path.join(dir, 'projects'),
      project = path.join(projects, 'Example'),
      id = randomUUID();
    await fs.mkdir(path.join(project, 'music'), { recursive: true });
    await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id }));
    let loaded = false,
      free = false,
      submissions = 0,
      offloads = 0,
      loads = 0;
    const http = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/health') {
        return res.end(JSON.stringify({ api_version: '1', model: { loaded } }));
      }
      if (req.url === '/api/v1/jobs' && req.method === 'POST') {
        submissions++;
        req.resume();
        return res.end(JSON.stringify({ id: 'automatic-job' }));
      }
      if (req.url === '/api/v1/jobs/automatic-job') {
        return res.end(JSON.stringify({ status: 'done' }));
      }
      if (req.url === '/api/v1/jobs/automatic-job/audio') {
        return res.end('fLaC-automatic-test');
      }
      res.statusCode = 404;
      res.end('{}');
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const previous = process.env.FORGE_MUSIC_URL;
    process.env.FORGE_MUSIC_URL = `http://127.0.0.1:${http.address().port}`;
    const prepareMusic = createMusicPreparation({
      startEngine: async () => ({ status: 'already_running' }),
      loadModel: async () => {
        if (!free) {
          return {
            status: 409,
            body: { code: 'insufficient_gpu_memory', requiredMiB: 26624, candidates: [] },
          };
        }
        loads++;
        loaded = true;
        return { status: 202, body: { code: 'load_requested' } };
      },
    });
    const autoMemory = createAutoMemoryManager({
      services: async () => (free ? [] : [service('tts')]),
      offload: async (serviceId) => {
        assert.equal(serviceId, 'tts');
        offloads++;
        free = true;
        return { stopped: true };
      },
    });
    const queue = new JobQueue({
      directory: path.join(dir, 'state'),
      projects,
      leaseMs: 1000,
      intervalMs: 50,
      prepareMusic,
      autoMemory,
      onModelLoadBarrier: () => {
        if (loaded) {
          queue.resumeAfterModelLoad();
        }
      },
    });
    t.after(async () => {
      queue.stop();
      http.closeAllConnections();
      http.close();
      if (previous === undefined) {
        delete process.env.FORGE_MUSIC_URL;
      } else {
        process.env.FORGE_MUSIC_URL = previous;
      }
      await fs.rm(dir, { recursive: true, force: true });
    });
    const job = queue.enqueue({
      type: 'music',
      projectId: id,
      request: { style: 'piano', lyrics: '[Instrumental]' },
    });
    const deadline = Date.now() + 8000;
    while (queue.get(job.id)?.status !== 'completed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(queue.get(job.id).status, 'completed');
    assert.equal(offloads, 1);
    assert.equal(loads, 1);
    assert.equal(submissions, 1);
    assert.equal(
      await fs.readFile(path.join(project, ...queue.get(job.id).output.split('/')), 'utf8'),
      'fLaC-automatic-test',
    );
  },
);
