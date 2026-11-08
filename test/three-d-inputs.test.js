import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAlpha, alphaStatusFor, fileKey, measureTransparency } from '../src/image-alpha.js';
import {
  REMOVE_BACKGROUND_DEFAULT_PROMPT,
  removeBackgroundPrompt,
  removeBackgroundSteps,
  textImageRequest,
  textTo3dSteps,
  threeDRequest,
} from '../src/three-d-requests.js';
import { rerunRequest } from '../src/rerun-request.js';
import { trellisRequest } from '../src/trellis-settings.js';
import {
  chainHint,
  isChained,
  isWaitingForReference,
  jobLabel,
  orderChains,
  waitingDependents,
} from '../src/queue-chain.js';
import { removeBackgroundChain, textTo3dChain } from '../runtime/three-d-chain.js';
import { JobQueue } from '../runtime/jobs.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const project = randomUUID();
const staged = `${randomUUID()}.png`;

function pixels(width, height, alphaAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4 + 3] = alphaAt(index);
  }
  return data;
}

test('transparency detection follows the TRELLIS.2 worker rule', async () => {
  assert.equal(analyzeAlpha(pixels(10, 10, () => 255)).status, 'opaque');
  // A mostly opaque picture with a stray transparent pixel is still opaque (under 1%).
  assert.equal(analyzeAlpha(pixels(20, 20, (i) => (i === 3 ? 0 : 255))).status, 'opaque');
  // 10% transparent background around an opaque object is a real cutout.
  const cutout = analyzeAlpha(pixels(10, 10, (i) => (i < 10 ? 0 : 255)));
  assert.equal(cutout.status, 'transparent');
  assert.equal(cutout.transparentFraction, 0.1);
  // Fully transparent means no visible object.
  assert.equal(analyzeAlpha(pixels(10, 10, () => 0)).status, 'opaque');
  assert.equal(analyzeAlpha(new Uint8ClampedArray(0)).status, 'opaque');

  // JPEG has no alpha, so it needs no decoding; no file or no canvas means "unknown".
  assert.equal((await measureTransparency({ name: 'photo.JPG', type: '' })).status, 'opaque');
  assert.equal((await measureTransparency({ name: 'a.png', type: 'image/jpeg' })).status, 'opaque');
  assert.equal((await measureTransparency(null)).status, 'unknown');
  assert.equal((await measureTransparency({ name: 'a.png', type: 'image/png' })).status, 'unknown');
});

test('a stored measurement only applies to the file it was taken from', () => {
  const file = { name: 'a.png', size: 10, lastModified: 5 };
  const stored = { key: fileKey(file), status: 'transparent' };
  assert.equal(alphaStatusFor(file, stored), 'transparent');
  assert.equal(alphaStatusFor({ ...file, size: 11 }, stored), 'unknown');
  assert.equal(alphaStatusFor(undefined, stored), 'unknown');
  assert.equal(alphaStatusFor(file, null), 'unknown');
});

test('3D requests are built without a reference and validated like the queue does', () => {
  const hunyuan = threeDRequest(
    { model: 'Hunyuan3D 2.1', seed: 7, texture: true },
    'Hunyuan3D 2.1',
  );
  assert.equal(hunyuan.model, 'hunyuan');
  assert.equal('references' in hunyuan.request, false);
  assert.equal(hunyuan.request.seed, 7);
  assert.equal(hunyuan.request.texture, true);
  const trellis = threeDRequest(
    { model: 'TRELLIS.2', seed: '', trellisPipeline: '1024_cascade' },
    'Hunyuan3D 2.1',
  );
  assert.equal(trellis.model, 'trellis');
  assert.equal(trellis.request.pipeline, '1024_cascade');
  assert.ok(Number.isInteger(trellis.request.seed));
  // The 512 default stays out of the request so history and timing keep matching.
  assert.equal('pipeline' in threeDRequest({ model: 'TRELLIS.2' }, '').request, false);
  assert.equal('pipeline' in trellisRequest({ trellisPipeline: '512' }, [staged]), false);
  assert.throws(() => trellisRequest({ trellisPipeline: '2048' }, [staged]), /supported TRELLIS/);
  assert.throws(() => threeDRequest({ model: 'TRELLIS.2', trellisSteps: 99 }, ''), /Steps/);
});

test('remove-background builds a cutout step and a dependent 3D step', () => {
  const steps = removeBackgroundSteps({
    projectId: project,
    draft: { model: 'Hunyuan3D 2.1', seed: 3, removeBackgroundPrompt: '  the dragon ' },
    fallbackModel: 'Hunyuan3D 2.1',
    referenceId: staged,
  });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0], {
    type: 'segmentation',
    projectId: project,
    request: { prompt: 'the dragon', references: [staged], output: 'transparent', confidence: 0.5 },
  });
  assert.equal(steps[1].type, '3d');
  assert.deepEqual(steps[1].request.references, []);
  assert.deepEqual(steps[1].request.referenceFrom, { step: 0 });
  assert.equal(steps[1].request.seed, 3);
  // The default description is used when the field is empty.
  assert.equal(removeBackgroundPrompt({}), REMOVE_BACKGROUND_DEFAULT_PROMPT);
  assert.throws(
    () => removeBackgroundPrompt({ removeBackgroundPrompt: 'x'.repeat(1001) }),
    /at most 1000/,
  );
  assert.throws(
    () =>
      removeBackgroundChain({ projectId: project, referenceId: staged, model: 'x', request: {} }),
    /Choose Hunyuan3D or TRELLIS/,
  );
  const trellis = removeBackgroundSteps({
    projectId: project,
    draft: { model: 'TRELLIS.2', seed: 1 },
    fallbackModel: '',
    referenceId: staged,
  });
  assert.equal(trellis[1].type, 'trellis');
});

test('text-to-3D uses the Images request builder with a transparent square image', () => {
  const image = textImageRequest({
    prompt: '  a wooden barrel ',
    textImageSteps: '20',
    textImageSeed: '55',
  });
  assert.deepEqual(image, {
    prompt: 'a wooden barrel',
    width: 1024,
    height: 1024,
    num_inference_steps: 20,
    references: [],
    transparent: true,
    seed: 55,
  });
  // Steps default to 25 and the seed is left for the queue to choose.
  const defaults = textImageRequest({ prompt: 'a lamp' });
  assert.equal(defaults.num_inference_steps, 25);
  assert.equal('seed' in defaults, false);
  assert.throws(() => textImageRequest({ prompt: '   ' }), /Describe the object/);
  assert.throws(() => textImageRequest({ prompt: 'x'.repeat(4001) }), /at most 4000/);
  assert.throws(() => textImageRequest({ prompt: 'x', textImageSteps: '0' }), /Image steps/);
  assert.throws(() => textImageRequest({ prompt: 'x', textImageSteps: '2.5' }), /Image steps/);

  const steps = textTo3dSteps({
    projectId: project,
    draft: { prompt: 'a lamp', model: 'TRELLIS.2', seed: 4, trellisPipeline: '1024' },
    fallbackModel: 'Hunyuan3D 2.1',
  });
  assert.equal(steps[0].type, 'images');
  assert.equal(steps[0].request.transparent, true);
  assert.equal(steps[1].type, 'trellis');
  assert.equal(steps[1].request.pipeline, '1024');
  assert.deepEqual(steps[1].request.referenceFrom, { step: 0 });
  assert.throws(
    () =>
      textTo3dChain({ projectId: project, model: 'trellis', image: { prompt: ' ' }, request: {} }),
    /Describe the object/,
  );
});

test('the page recipes are accepted by the real queue and wait on each other', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-three-d-'));
  const projects = path.join(dir, 'projects');
  const id = randomUUID();
  await fs.mkdir(path.join(projects, 'P'), { recursive: true });
  await fs.writeFile(path.join(projects, 'P', '.forge-project.json'), JSON.stringify({ id }));
  const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, autoStart: false });
  t.after(async () => {
    queue.stop();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const remove = queue.enqueueChain(
    removeBackgroundSteps({
      projectId: id,
      draft: { model: 'TRELLIS.2', seed: 1, trellisPipeline: '1536_cascade' },
      fallbackModel: '',
      referenceId: staged,
    }),
  );
  assert.equal(remove[1].dependsOn, remove[0].id);
  assert.equal(remove[1].request.pipeline, '1536_cascade');
  const text = queue.enqueueChain(
    textTo3dSteps({
      projectId: id,
      draft: { prompt: 'a barrel', model: 'Hunyuan3D 2.1', seed: 2, texture: true },
      fallbackModel: 'Hunyuan3D 2.1',
    }),
  );
  assert.equal(text[0].type, 'images');
  assert.equal(text[1].dependsOn, text[0].id);
  assert.equal(text[1].request.texture, true);
});

test('the queue shows what a chained render waits for', () => {
  const parent = {
    id: 'a',
    type: 'segmentation',
    status: 'running',
    request: { prompt: 'the dragon' },
  };
  const child = {
    id: 'b',
    type: 'trellis',
    status: 'queued',
    dependsOn: 'a',
    request: { referenceFrom: { jobId: 'a' } },
  };
  const jobs = [parent, child];
  assert.equal(isChained(child), true);
  assert.equal(isChained(parent), false);
  assert.equal(isWaitingForReference(child), true);
  assert.equal(chainHint(child, jobs), 'Waiting for cutout “the dragon” (running).');
  assert.equal(chainHint(parent, jobs), '');
  assert.match(chainHint(child, [{ ...parent, status: 'failed' }, child]), /which failed/);
  assert.match(chainHint(child, [{ ...parent, status: 'cancelled' }, child]), /which cancelled/);
  assert.match(chainHint(child, [{ ...parent, status: 'completed' }, child]), /finished/);
  assert.match(chainHint(child, [child]), /no longer in the list/);
  const resolved = { ...child, request: { referenceFrom: { jobId: 'a', output: 'masks/x.png' } } };
  assert.equal(isWaitingForReference(resolved), false);
  assert.match(chainHint(resolved, jobs), /Built from the finished cutout/);
  assert.equal(jobLabel({ type: 'images', request: { prompt: 'x'.repeat(60) } }).length < 60, true);
  assert.equal(jobLabel(undefined), 'an earlier render');
  assert.deepEqual(
    waitingDependents(parent, jobs).map((job) => job.id),
    ['b'],
  );
  assert.deepEqual(waitingDependents(parent, [parent, resolved]), []);
});

test('chained renders are listed directly under the render they wait for', () => {
  const make = (id, dependsOn) => ({ id, dependsOn, request: {} });
  const items = [make('p'), make('other'), make('c1', 'p'), make('c2', 'p'), make('g', 'c1')];
  const { ordered, nested } = orderChains(items);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ['p', 'c1', 'g', 'c2', 'other'],
  );
  assert.deepEqual([...nested].sort(), ['c1', 'c2', 'g']);
  // A parent in another group leaves the child in place; a dependency loop never hides a job.
  assert.deepEqual(
    orderChains([make('x', 'missing'), make('y')]).ordered.map((item) => item.id),
    ['x', 'y'],
  );
  const loop = orderChains([make('a', 'b'), make('b', 'a')]);
  assert.deepEqual(loop.ordered.map((item) => item.id).sort(), ['a', 'b']);
});

test('running a chained 3D render again reuses its staged reference and drops the dependency', () => {
  const job = {
    type: 'trellis',
    request: {
      model: 'trellis',
      references: [staged],
      referenceFrom: { jobId: randomUUID(), output: 'masks/forge-x.png' },
      seed: 1,
      pipeline: '1024',
    },
  };
  const again = rerunRequest(job, '', { seed: 9 });
  assert.equal('referenceFrom' in again, false);
  assert.deepEqual(again.references, [staged]);
  assert.equal(again.seed, 9);
  assert.equal(again.pipeline, '1024');
  // The original job is not modified.
  assert.ok(job.request.referenceFrom);
});
