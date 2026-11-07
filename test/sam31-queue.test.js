import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { stageProjectAsset } from '../runtime/references.js';
import {
  createSam31Loader,
  createSam31Preparation,
  createSam31RenderPreparation,
} from '../runtime/sam31-preparation.js';

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

test('SAM admission checks host and GPU memory and preserves uncertain-load barriers', async () => {
  let free = 1000,
    host = 1000,
    posts = 0;
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/api/status')) {
      return {
        ok: true,
        json: async () => ({
          engine: 'forge-sam31-image-experimental-v1',
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
  const load = createSam31Loader({
    hardware,
    services,
    baseUrl: 'http://127.0.0.1:8284',
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
  free = 30000;
  assert.equal((await load()).body.code, 'load_unknown');
  assert.equal(posts, 1);
  const prepare = createSam31Preparation({
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
  const render = createSam31RenderPreparation({ hardware, services, freeMemory: () => host });
  assert.equal(await render(), null);
  free = 1000;
  assert.equal((await render()).status, 'waiting_memory');
});

test(
  'SAM jobs snapshot one reference and save outputs in the project',
  { timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sam31-test-')),
      projects = path.join(dir, 'projects'),
      project = path.join(projects, 'Game'),
      id = randomUUID();
    await fs.mkdir(path.join(project, 'images'), { recursive: true });
    await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id }));
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('snapshot')]);
    await fs.writeFile(path.join(project, 'images', 'source.png'), png);
    const ref = await stageProjectAsset(project, 'images/source.png');
    await fs.writeFile(path.join(project, 'images', 'source.png'), 'changed');
    let submissions = 0;
    const remoteId = 'b'.repeat(32);
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/status') {
        return res.end(
          JSON.stringify({
            engine: 'forge-sam31-image-experimental-v1',
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
        assert.equal(body.image, `data:image/png;base64,${png.toString('base64')}`);
        assert.equal(body.output, 'transparent');
        assert.equal(body.confidence, 0.7);
        submissions++;
        return res.end(JSON.stringify({ id: remoteId }));
      }
      if (req.url === `/api/jobs/${remoteId}`) {
        return res.end(JSON.stringify({ status: 'completed' }));
      }
      if (req.url === `/api/jobs/${remoteId}/image`) {
        return res.end(png);
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const previous = process.env.FORGE_SAM31_URL;
    process.env.FORGE_SAM31_URL = `http://127.0.0.1:${server.address().port}`;
    const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, intervalMs: 50 });
    try {
      const input = {
        type: 'segmentation',
        projectId: id,
        request: { prompt: 'truck', references: [ref.id], output: 'transparent', confidence: 0.7 },
      };
      assert.throws(
        () => queue.enqueue({ ...input, request: { ...input.request, confidence: 2 } }),
        /confidence/i,
      );
      const job = queue.enqueue(input);
      await waitFor(() => queue.get(job.id)?.status === 'completed');
      assert.equal(submissions, 1);
      assert.match(queue.get(job.id).output, /^masks\//);
      assert.deepEqual(
        await fs.readFile(path.join(project, ...queue.get(job.id).output.split('/'))),
        png,
      );
      assert.equal(queue.estimate(input).sampleCount, 1);
    } finally {
      queue.stop();
      if (previous === undefined) {
        delete process.env.FORGE_SAM31_URL;
      } else {
        process.env.FORGE_SAM31_URL = previous;
      }
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
