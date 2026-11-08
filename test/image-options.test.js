import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobQueue } from '../runtime/jobs.js';
import {
  normalizeImageExtras,
  parseSigmaSchedule,
  variationRequests,
} from '../runtime/image-options.js';
import { assertKnownLora, isLoraName, listImageLoras } from '../runtime/image-loras.js';
import {
  imageRequest,
  variationRequests as clientVariationRequests,
} from '../src/imageVideoInputs.js';

const imageJobPath = fileURLToPath(new URL('../runtime/image-job.js', import.meta.url));

async function loraFolder(t, names = ['pixel-art.safetensors', 'ink wash (v2).safetensors']) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-lora-'));
  for (const name of names) {
    await fs.writeFile(path.join(directory, name), 'fixture');
  }
  await fs.writeFile(path.join(directory, 'notes.txt'), 'not a LoRA');
  await fs.mkdir(path.join(directory, 'folder.safetensors'));
  const previous = process.env.FORGE_QWEN_LORA_DIR;
  process.env.FORGE_QWEN_LORA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.FORGE_QWEN_LORA_DIR;
    } else {
      process.env.FORGE_QWEN_LORA_DIR = previous;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('LoRA names must be plain safetensors files that exist in the scanned folder', async (t) => {
  await loraFolder(t);
  assert.deepEqual(
    listImageLoras().map((item) => item.name),
    ['ink wash (v2).safetensors', 'pixel-art.safetensors'],
    'only regular .safetensors files are listed',
  );
  for (const bad of [
    '../pixel-art.safetensors',
    'sub/pixel-art.safetensors',
    'C:\\x.safetensors',
    '.hidden.safetensors',
    'pixel-art.ckpt',
    '',
    7,
  ]) {
    assert.equal(isLoraName(bad), false, String(bad));
    assert.throws(() => assertKnownLora(bad), /LoRA must be/);
  }
  assert.equal(assertKnownLora('pixel-art.safetensors'), 'pixel-art.safetensors');
  assert.throws(() => assertKnownLora('missing.safetensors'), /was not found/);
  assert.deepEqual(listImageLoras(path.join(os.tmpdir(), 'forge-no-such-lora-folder')), []);
});

test('sigma schedules must be falling values in (0, 1]', () => {
  assert.deepEqual(parseSigmaSchedule('1, 0.8; 0.5 0.2'), [1, 0.8, 0.5, 0.2]);
  assert.deepEqual(parseSigmaSchedule('0.5'), [0.5]);
  for (const bad of ['', 'a, b', '0, 0.5', '1.2, 0.5', '0.5, 0.5', '0.2, 0.6', '-1']) {
    assert.throws(() => parseSigmaSchedule(bad), undefined, bad);
  }
  assert.throws(
    () => parseSigmaSchedule(Array.from({ length: 51 }, (_, i) => 1 - i / 100).join(',')),
    /1 to 50/,
  );
});

test('optional image controls are stored only when they differ from the defaults', async (t) => {
  await loraFolder(t);
  assert.deepEqual(normalizeImageExtras({}, { sizeFromReference: false, steps: 30 }), {});
  assert.deepEqual(
    normalizeImageExtras(
      { output_resolution: 1024, use_kv_cache: true },
      { sizeFromReference: true, steps: 30 },
    ),
    {},
  );
  assert.deepEqual(
    normalizeImageExtras(
      {
        output_resolution: 1536,
        use_kv_cache: false,
        sigma_schedule: '1, 0.6, 0.2',
        lora: 'pixel-art.safetensors',
      },
      { sizeFromReference: true, steps: 3 },
    ),
    {
      output_resolution: 1536,
      use_kv_cache: false,
      sigma_schedule: '1, 0.6, 0.2',
      lora: 'pixel-art.safetensors',
      lora_scale: 1,
    },
  );
  const rejected = [
    [{ output_resolution: 1536 }, false, /only when the size follows/],
    [{ output_resolution: 1000 }, true, /multiples of 32/],
    [{ output_resolution: 4096 }, true, /256–2048/],
    [{ use_kv_cache: 'no' }, false, /true or false/],
    [{ sigma_schedule: '1, 0.5' }, false, /equal the number of sigma/],
    [{ lora: 'missing.safetensors' }, false, /was not found/],
    [{ lora: 'pixel-art.safetensors', lora_scale: 2.5 }, false, /0 to 2/],
    [{ lora_scale: 1 }, false, /needs a LoRA/],
    [{ variation_index: 1 }, false, /Variation needs/],
    [{ variation_group: randomUUID(), variation_index: 5, variation_count: 4 }, false, /Variation/],
    [{ variation_group: 'x', variation_index: 1, variation_count: 2 }, false, /Variation/],
  ];
  for (const [request, sizeFromReference, pattern] of rejected) {
    assert.throws(
      () => normalizeImageExtras(request, { sizeFromReference, steps: 3 }),
      pattern,
      JSON.stringify(request),
    );
  }
});

test('variations share every setting and differ in seed and position', () => {
  const ids = ['group-a'];
  const options = { randomSeed: () => 1, makeGroup: () => ids[0] };
  assert.deepEqual(variationRequests({ prompt: 'x' }, 1, options), [{ prompt: 'x' }]);
  const counted = variationRequests({ prompt: 'x', seed: 10 }, 3, options);
  assert.deepEqual(
    counted.map(({ seed, variation_index: index, variation_count: count }) => [seed, index, count]),
    [
      [10, 1, 3],
      [11, 2, 3],
      [12, 3, 3],
    ],
  );
  assert.equal(new Set(counted.map((item) => item.variation_group)).size, 1);
  let next = 0;
  const random = variationRequests({ prompt: 'x' }, 4, {
    randomSeed: () => [5, 5, 6, 7, 7, 8][next++],
    makeGroup: () => 'g',
  });
  assert.deepEqual(
    random.map((item) => item.seed),
    [5, 6, 7, 8],
    'random seeds never repeat within a set',
  );
  assert.throws(() => variationRequests({}, 5, options), /1 to 4/);
  // The browser builds the same sets.
  assert.deepEqual(
    clientVariationRequests({ prompt: 'x', seed: 3 }, 2, options).map((item) => item.seed),
    [3, 4],
  );
});

test('the browser builds the optional image fields the queue accepts', () => {
  const draft = {
    prompt: 'a castle',
    options: ['Square · 1:1', 'Balanced'],
    referenceIds: ['00000000-0000-0000-0000-000000000000.png'],
    imageMatchReference: true,
    imageTargetSize: '1536',
    imageKvCache: false,
    imageLora: 'pixel-art.safetensors',
    imageLoraScale: '0.7',
    imageSigmas: '1, 0.6, 0.2',
    imageSteps: '99',
  };
  assert.deepEqual(imageRequest(draft), {
    prompt: 'a castle',
    size_from_reference: true,
    num_inference_steps: 3,
    references: ['00000000-0000-0000-0000-000000000000.png'],
    output_resolution: 1536,
    use_kv_cache: false,
    sigma_schedule: '1, 0.6, 0.2',
    lora: 'pixel-art.safetensors',
    lora_scale: 0.7,
  });
  // A target that is no longer relevant is ignored rather than sent.
  assert.equal(
    Object.hasOwn(imageRequest({ ...draft, imageMatchReference: false }), 'output_resolution'),
    false,
  );
  for (const bad of [
    { imageTargetSize: '1000' },
    { imageLoraScale: '3' },
    { imageSigmas: '0.2, 0.6' },
    { imageVariations: 5 },
  ]) {
    assert.throws(() => imageRequest({ ...draft, ...bad }), undefined, JSON.stringify(bad));
  }
});

async function makeProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-image-options-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'Fixture');
  const projectId = randomUUID();
  await fs.mkdir(path.join(project, 'images'), { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  return { root, projects, project, projectId };
}

test('the queue records variation labels, LoRA and advanced image options', async (t) => {
  await loraFolder(t);
  const holder = { queue: null };
  t.after(() => holder.queue?.stop());
  const { root, projects, projectId } = await makeProject(t);
  const queue = new JobQueue({ directory: path.join(root, 'state'), projects, autoStart: false });
  holder.queue = queue;
  const group = randomUUID();
  const job = queue.enqueue({
    type: 'images',
    projectId,
    request: {
      prompt: 'a tree',
      seed: 5,
      lora: 'pixel-art.safetensors',
      lora_scale: 0.5,
      variation_group: group,
      variation_index: 2,
      variation_count: 3,
      use_kv_cache: false,
    },
  });
  assert.equal(job.request.lora, 'pixel-art.safetensors');
  assert.equal(job.request.lora_scale, 0.5);
  assert.equal(job.request.variation_group, group);
  assert.equal(job.request.use_kv_cache, false);
  const plain = queue.enqueue({ type: 'images', projectId, request: { prompt: 'a tree' } });
  for (const key of ['lora', 'lora_scale', 'variation_group', 'use_kv_cache', 'sigma_schedule']) {
    assert.equal(Object.hasOwn(plain.request, key), false, `${key} is absent by default`);
  }
  assert.throws(
    () =>
      queue.enqueue({
        type: 'images',
        projectId,
        request: { prompt: 'a tree', lora: '../escape.safetensors' },
      }),
    /LoRA must be/,
  );
  assert.equal(queue.list().length, 2, 'rejected requests are not persisted');
});

async function runImageWorker(t, { request, engine }) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      engine(req, res, requests);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-image-worker-'));
  await fs.mkdir(path.join(directory, 'images'));
  const child = fork(imageJobPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.connected) {
      child.disconnect();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const messages = [];
  const done = new Promise((resolve) => {
    child.on('message', (message) => {
      messages.push(message);
      if (['complete', 'failed', 'interrupted'].includes(message.type)) {
        resolve(message);
      }
    });
  });
  child.send({
    job: { id: 'image-options-job', request },
    projectFolder: directory,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  return { requests, outcome: await done, messages };
}

test('the image worker sends LoRA and a sigma list but keeps variation labels to itself', async (t) => {
  const { requests, outcome } = await runImageWorker(t, {
    request: {
      prompt: 'a tree',
      seed: 7,
      num_inference_steps: 3,
      width: 512,
      height: 512,
      references: [],
      lora: 'pixel-art.safetensors',
      lora_scale: 0.6,
      sigma_schedule: '1, 0.6, 0.2',
      use_kv_cache: false,
      variation_group: randomUUID(),
      variation_index: 1,
      variation_count: 2,
    },
    engine: (req, res) => {
      if (req.url === '/api/loras') {
        res.end(JSON.stringify({ loras: [{ name: 'pixel-art.safetensors' }] }));
      } else if (req.url === '/api/generate') {
        res.end(JSON.stringify({ id: 'engine-job' }));
      } else if (req.url === '/api/jobs/engine-job') {
        res.end(JSON.stringify({ status: 'completed', images: ['/outputs/result.png'] }));
      } else if (req.url === '/outputs/result.png') {
        res.end('image bytes');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    },
  });
  assert.equal(outcome.type, 'complete');
  const submitted = requests.find((item) => item.url === '/api/generate').body;
  assert.deepEqual(submitted, {
    prompt: 'a tree',
    seed: 7,
    num_inference_steps: 3,
    width: 512,
    height: 512,
    lora: 'pixel-art.safetensors',
    lora_scale: 0.6,
    use_kv_cache: false,
    sigmas: [1, 0.6, 0.2],
  });
});

test('the image worker refuses a LoRA the running engine cannot apply, without submitting', async (t) => {
  for (const loras of [undefined, [{ name: 'other.safetensors' }]]) {
    const { requests, outcome } = await runImageWorker(t, {
      request: {
        prompt: 'a tree',
        seed: 7,
        num_inference_steps: 3,
        width: 512,
        height: 512,
        references: [],
        lora: 'pixel-art.safetensors',
        lora_scale: 1,
      },
      engine: (req, res) => {
        if (req.url === '/api/loras' && loras) {
          res.end(JSON.stringify({ loras }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      },
    });
    assert.equal(outcome.type, 'failed');
    assert.match(outcome.error, /cannot apply the LoRA/);
    assert.equal(
      requests.some((item) => item.url === '/api/generate'),
      false,
      'nothing was submitted',
    );
  }
});
