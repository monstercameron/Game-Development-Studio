import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import {
  createHyMotionLoader,
  createHyMotionPreparation,
  createHyMotionRenderPreparation,
} from '../runtime/hymotion-preparation.js';
import { hyMotionRequest } from '../src/hymotion-settings.js';
import { rerunRequest } from '../src/rerun-request.js';

async function waitFor(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error('Timed out');
}

test('motion settings and reruns preserve the supported controls', () => {
  const request = hyMotionRequest({
    prompt: 'walk',
    motionDuration: '4',
    motionSteps: '12',
    motionGuidance: '3.5',
    seed: '42',
  });
  assert.deepEqual(request, {
    model: 'hy-motion',
    prompt: 'walk',
    duration: 4,
    steps: 12,
    guidance: 3.5,
    seed: 42,
  });
  assert.deepEqual(rerunRequest({ type: 'motion', request }, 'run', { seed: 7 }), {
    ...request,
    prompt: 'run',
    seed: 7,
  });
  for (const draft of [
    { motionDuration: 13 },
    { motionSteps: 0 },
    { motionGuidance: 21 },
    { seed: true },
  ]) {
    assert.throws(() => hyMotionRequest({ prompt: 'walk', ...draft }));
  }
});

test('motion admission checks host and GPU memory and preserves uncertain-load barriers', async () => {
  let free = 1000,
    host = 1000,
    posts = 0;
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/api/status')) {
      return {
        ok: true,
        json: async () => ({
          engine: 'forge-hy-motion-v1',
          phase: 'idle',
          loaded: false,
          model_downloaded: true,
        }),
      };
    }
    if (options.method === 'POST') {
      posts++;
      throw Error('Response lost');
    }
    throw Error('Unexpected');
  };
  const services = async () => [{ id: 'tts', name: 'Voice', modelLoaded: true, canUnload: true }];
  const hardware = async () => ({ devices: [{ freeMiB: free }] });
  const load = createHyMotionLoader({
    hardware,
    services,
    baseUrl: 'http://127.0.0.1:8286',
    freeMemory: () => host,
    fetcher,
  });
  assert.equal((await load()).body.code, 'insufficient_host_memory');
  assert.equal(posts, 0);
  host = 16 * 1024 ** 3;
  const low = await load();
  assert.equal(low.body.code, 'insufficient_gpu_memory');
  assert.equal(low.body.candidates[0].id, 'tts');
  assert.equal(posts, 0);
  free = 40000;
  assert.equal((await load()).body.code, 'load_unknown');
  assert.equal(posts, 1);
  const prepare = createHyMotionPreparation({
    startEngine: async () => ({ status: 'starting' }),
    loadModel: load,
  });
  assert.equal(
    (
      await prepare({
        reachable: true,
        health: { phase: 'idle', model_downloaded: true },
        claimLoad: () => true,
      })
    ).loadBarrier,
    true,
  );
  const render = createHyMotionRenderPreparation({ hardware, services, freeMemory: () => host });
  assert.equal(await render({ duration: 3 }), null);
  free = 12000;
  assert.equal((await render({ duration: 10 })).status, 'waiting_memory');
});

test(
  'motion jobs preserve parameters and save a BVH clip in the project',
  { timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-hymotion-test-')),
      projects = path.join(dir, 'projects'),
      project = path.join(projects, 'Game'),
      id = randomUUID();
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id }));
    let submissions = 0;
    const remoteId = 'c'.repeat(32);
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/status') {
        return res.end(
          JSON.stringify({
            engine: 'forge-hy-motion-v1',
            phase: 'ready',
            loaded: true,
            model_downloaded: true,
          }),
        );
      }
      if (req.url === '/api/generate' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
        }
        const body = JSON.parse(raw);
        assert.deepEqual(body, { prompt: 'walk', duration: 2, seed: 42, steps: 8, guidance: 5 });
        submissions++;
        return res.end(JSON.stringify({ id: remoteId }));
      }
      if (req.url === `/api/jobs/${remoteId}`) {
        return res.end(JSON.stringify({ status: 'completed' }));
      }
      if (req.url === `/api/jobs/${remoteId}/motion`) {
        return res.end('HIERARCHY\nMOTION\nfixture');
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const previous = process.env.FORGE_HYMOTION_URL;
    process.env.FORGE_HYMOTION_URL = `http://127.0.0.1:${server.address().port}`;
    const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, intervalMs: 50 });
    try {
      const input = {
        type: 'motion',
        projectId: id,
        request: {
          model: 'hy-motion',
          prompt: 'walk',
          duration: 2,
          seed: 42,
          steps: 8,
          guidance: 5,
        },
      };
      assert.throws(
        () => queue.enqueue({ ...input, request: { ...input.request, model: 'motionbricks' } }),
        /Only HY-Motion/,
      );
      const job = queue.enqueue(input);
      await waitFor(() => queue.get(job.id)?.status === 'completed');
      assert.equal(submissions, 1);
      assert.match(queue.get(job.id).output, /^motion\/.*\.bvh$/);
      assert.match(
        await fs.readFile(path.join(project, ...queue.get(job.id).output.split('/')), 'utf8'),
        /HIERARCHY/,
      );
      assert.equal(queue.estimate(input).sampleCount, 1);
    } finally {
      queue.stop();
      if (previous === undefined) {
        delete process.env.FORGE_HYMOTION_URL;
      } else {
        process.env.FORGE_HYMOTION_URL = previous;
      }
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
