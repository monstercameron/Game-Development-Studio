import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { readAssetMeta } from '../runtime/asset-metadata.js';
import { stageProjectAsset } from '../runtime/references.js';

// The whole chain through the real queue and the real job workers, against substitute engines
// on loopback ports. No model is loaded and nothing is rendered; this proves the hand-off of a
// finished image to the next render, not the quality of any model.

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake-cutout')]);
const ENV = ['FORGE_SAM31_URL', 'FORGE_HUNYUAN_URL', 'FORGE_TRELLIS_URL', 'FORGE_IMAGE_URL'];

async function waitFor(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function serve(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    const reply = handler(req, body);
    if (Buffer.isBuffer(reply) || typeof reply === 'string') {
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.end(reply);
    }
    res.statusCode = reply?.status || 200;
    res.end(JSON.stringify(reply?.json ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function setup(t, engines) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) {
    process.env[name] = engines[name] || 'http://127.0.0.1:1';
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-chain-e2e-')),
    projects = path.join(dir, 'projects'),
    folder = path.join(projects, 'Game'),
    projectId = randomUUID();
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, intervalMs: 50 });
  t.after(async () => {
    queue.stop();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { queue, folder, projectId };
}

test('remove background: the 3D render waits for SAM, then receives its cutout', async (t) => {
  let samDone = false;
  const sam = await serve(t, (req) => {
    if (req.url === '/api/status') {
      return {
        json: {
          engine: 'forge-sam31-image-experimental-v1',
          phase: 'ready',
          loaded: true,
          model_downloaded: true,
        },
      };
    }
    if (req.url === '/api/generate') {
      return { status: 202, json: { id: 'a'.repeat(32) } };
    }
    if (req.url === `/api/jobs/${'a'.repeat(32)}`) {
      return { json: { status: samDone ? 'completed' : 'running', message: 'Segmenting' } };
    }
    if (req.url === `/api/jobs/${'a'.repeat(32)}/image`) {
      return PNG;
    }
    return { status: 404 };
  });
  const hunyuan = await serve(t, (req) => {
    if (req.url === '/api/status') {
      return {
        json: {
          engine: 'forge-hunyuan-shape-v1',
          phase: 'ready',
          loaded: true,
          model_downloaded: true,
        },
      };
    }
    if (req.url === '/api/generate') {
      return { status: 202, json: { id: 'b'.repeat(32) } };
    }
    if (req.url === `/api/jobs/${'b'.repeat(32)}`) {
      return { json: { status: 'completed' } };
    }
    if (req.url === `/api/jobs/${'b'.repeat(32)}/mesh`) {
      return 'glTF-test';
    }
    return { status: 404 };
  });
  const { queue, folder, projectId } = await setup(t, {
    FORGE_SAM31_URL: sam.url,
    FORGE_HUNYUAN_URL: hunyuan.url,
  });
  // The opaque original, as a user would stage it.
  await fs.writeFile(
    path.join(folder, 'images', 'photo.png'),
    Buffer.concat([PNG, Buffer.from('x')]),
  );
  const photo = await stageProjectAsset(folder, 'images/photo.png');
  const [cutout, shape] = queue.enqueueChain([
    {
      type: 'segmentation',
      projectId,
      request: { prompt: 'the main object', references: [photo.id], output: 'transparent' },
    },
    { type: '3d', projectId, request: { references: [], referenceFrom: { step: 0 }, seed: 7 } },
  ]);

  // While SAM runs, the 3D render is listed as waiting and has no reference.
  await waitFor(() => queue.get(cutout.id).status === 'running', 'the cutout to run');
  const waiting = queue.get(shape.id);
  assert.equal(waiting.status, 'queued');
  assert.match(waiting.stage, /Waiting for the render it depends on/);
  assert.deepEqual(waiting.request.references, []);
  assert.equal(hunyuan.requests.filter((r) => r.url === '/api/generate').length, 0);

  samDone = true;
  const finished = await waitFor(
    () => queue.get(shape.id).status === 'completed' && queue.get(shape.id),
    'the 3D render to finish',
  );
  const sent = hunyuan.requests.find((r) => r.url === '/api/generate').body;
  assert.equal(sent.image, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(sent.seed, 7);
  const cutoutJob = queue.get(cutout.id);
  assert.equal(cutoutJob.status, 'completed');
  assert.match(cutoutJob.output, /^masks\/forge-.*\.png$/);
  assert.deepEqual(finished.request.referenceFrom, { jobId: cutout.id, output: cutoutJob.output });
  assert.equal(finished.request.references.length, 1);

  // The 3D asset's details say where its input came from.
  const meta = readAssetMeta(folder, finished.output);
  assert.equal(meta.settings.chained_from_job, cutout.id);
  assert.equal(meta.settings.chained_from_asset, cutoutJob.output);
  assert.equal(meta.references[0].id, finished.request.references[0]);
});

test('text to 3D: the picture is made first, then TRELLIS.2 gets it with its pipeline', async (t) => {
  const qwen = await serve(t, (req) => {
    if (req.url === '/api/status') {
      return { json: { status: 'ready', model_downloaded: true, busy: false } };
    }
    if (req.url === '/api/generate') {
      return { json: { id: 'img-1' } };
    }
    if (req.url === '/api/jobs/img-1') {
      return { json: { status: 'completed', images: ['/outputs/made.png'] } };
    }
    if (req.url === '/outputs/made.png') {
      return PNG;
    }
    return { status: 404 };
  });
  const trellis = await serve(t, (req) => {
    if (req.url === '/api/status') {
      return {
        json: {
          engine: 'forge-trellis2-512-experimental-v1',
          phase: 'ready',
          loaded: true,
          model_downloaded: true,
        },
      };
    }
    if (req.url === '/api/generate') {
      return { status: 202, json: { id: 'c'.repeat(32) } };
    }
    if (req.url === `/api/jobs/${'c'.repeat(32)}`) {
      return { json: { status: 'completed' } };
    }
    if (req.url === `/api/jobs/${'c'.repeat(32)}/mesh`) {
      return 'glTF-test';
    }
    return { status: 404 };
  });
  const { queue, folder, projectId } = await setup(t, {
    FORGE_IMAGE_URL: qwen.url,
    FORGE_TRELLIS_URL: trellis.url,
  });
  const [image, model] = queue.enqueueChain([
    {
      type: 'images',
      projectId,
      request: {
        prompt: 'a wooden barrel',
        width: 1024,
        height: 1024,
        num_inference_steps: 25,
        transparent: true,
        seed: 4,
      },
    },
    {
      type: 'trellis',
      projectId,
      request: { references: [], referenceFrom: { step: 0 }, pipeline: '1024', seed: 2, steps: 3 },
    },
  ]);
  await waitFor(() => queue.get(model.id).status === 'completed', 'the model to finish');
  const generate = qwen.requests.find((r) => r.url === '/api/generate').body;
  assert.match(generate.prompt, /RGBA image with transparency.*a wooden barrel/s);
  assert.equal(generate.num_inference_steps, 25);
  const sent = trellis.requests.find((r) => r.url === '/api/generate').body;
  assert.equal(sent.image, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(sent.pipeline, '1024');
  assert.equal(sent.steps, 3);
  // The intermediate picture is a normal image asset in the project, and the model records it.
  const imageJob = queue.get(image.id);
  assert.match(imageJob.output, /^images\/forge-.*\.png$/);
  assert.equal(
    await fs.readFile(path.join(folder, ...imageJob.output.split('/'))).then((b) => b.equals(PNG)),
    true,
  );
  const meta = readAssetMeta(folder, queue.get(model.id).output);
  assert.equal(meta.settings.chained_from_asset, imageJob.output);
  assert.equal(meta.settings.pipeline, '1024');
});

test('a failed first render stops the chain before the 3D engine is touched', async (t) => {
  const qwen = await serve(t, (req) => {
    if (req.url === '/api/status') {
      return { json: { status: 'ready', model_downloaded: true, busy: false } };
    }
    if (req.url === '/api/generate') {
      return { json: { id: 'img-2' } };
    }
    if (req.url === '/api/jobs/img-2') {
      return { json: { status: 'failed', message: 'CUDA out of memory' } };
    }
    return { status: 404 };
  });
  const hunyuan = await serve(t, () => ({ json: {} }));
  const { queue, projectId } = await setup(t, {
    FORGE_IMAGE_URL: qwen.url,
    FORGE_HUNYUAN_URL: hunyuan.url,
  });
  const [image, shape] = queue.enqueueChain([
    { type: 'images', projectId, request: { prompt: 'a barrel', transparent: true } },
    { type: '3d', projectId, request: { references: [], referenceFrom: { step: 0 } } },
  ]);
  await waitFor(() => queue.get(shape.id).status === 'failed', 'the 3D render to fail');
  assert.equal(queue.get(image.id).status, 'failed');
  const failed = queue.get(shape.id);
  assert.equal(failed.stage, 'Dependency failed.');
  assert.match(failed.error, /image this render depends on failed: .*CUDA out of memory/);
  assert.equal(hunyuan.requests.length, 0);
  // Retrying the image puts the 3D render back in line behind it.
  queue.retry(image.id);
  assert.equal(queue.get(shape.id).status, 'queued');
});
