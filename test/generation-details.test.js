import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { transformWithEsbuild } from 'vite';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { describeSettings, draftJob, reusePlan } from '../src/generation-details.js';
import { imageRequest, videoRequest } from '../src/imageVideoInputs.js';
import { audioPayload } from '../src/audio-payload.js';
import { hunyuanShapeRequest } from '../src/hunyuan-settings.js';
import { trellisRequest } from '../src/trellis-settings.js';
import { hyMotionRequest } from '../src/hymotion-settings.js';
import { motionBricksRequest } from '../src/motionbricks-settings.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
// What the API returns for a job, so tests exercise the same shapes the UI sees.
function record(type, request) {
  const id = randomUUID();
  const meta = buildJobMetadata(
    {
      id,
      type,
      request,
      startedAt: '2026-11-07T10:00:00.000Z',
      finishedAt: '2026-11-07T10:00:30Z',
    },
    `x/forge-${id}.bin`,
  );
  return {
    type: meta.jobType,
    job: { id, type },
    model: meta.model,
    prompt: {
      text: meta.prompt,
      negative: meta.negative,
      secondary: meta.secondary,
      title: meta.title,
    },
    seed: meta.seed,
    settings: meta.settings,
    references: meta.references,
    asset: { path: meta.path, kind: meta.kind },
  };
}
const ref = (ext = 'png') => `${randomUUID()}.${ext}`;
const without = (request, ...keys) => {
  const copy = { ...request };
  for (const key of keys) {
    delete copy[key];
  }
  return copy;
};
function draftFor(request, type) {
  const plan = reusePlan(record(type, request));
  assert.ok(plan, type);
  const job = draftJob(plan, randomUUID());
  return {
    ...job.draftSnapshot,
    options: job.options || job.draftSnapshot.options,
    seed: job.seed,
    prompt: job.prompt,
    second: job.second,
  };
}

test('reusing settings rebuilds the original request for every creation page', () => {
  const projectId = randomUUID();
  let request = {
    prompt: 'A bronze compass',
    width: 1024,
    height: 576,
    num_inference_steps: 30,
    references: [ref()],
    seed: 77,
    negative_prompt: 'blurry',
    true_cfg_scale: 3,
  };
  let draft = draftFor(request, 'images');
  assert.deepEqual(imageRequest(draft), { ...request, references: [] });

  // A custom size and step count that no preset covers still round-trips.
  request = { prompt: 'p', width: 800, height: 480, num_inference_steps: 17, references: [] };
  assert.deepEqual(imageRequest(draftFor(request, 'images')), request);

  // Transparency and a size taken from the last reference are restored; the reference is chosen again.
  request = { prompt: 'p', width: 1024, height: 1024, num_inference_steps: 12, references: [] };
  assert.deepEqual(imageRequest(draftFor({ ...request, transparent: true }, 'images')), {
    ...request,
    transparent: true,
  });
  request = {
    prompt: 'edit',
    size_from_reference: true,
    num_inference_steps: 12,
    references: ['a.png'],
  };
  assert.deepEqual(
    imageRequest({ ...draftFor(request, 'images'), referenceIds: ['a.png'] }),
    request,
  );

  request = { prompt: 'scene', references: [ref()], aspect: 'portrait', frames: 175, steps: 20 };
  draft = draftFor(request, 'video');
  assert.deepEqual(without(videoRequest(draft), 'references'), without(request, 'references'));

  request = {
    style: 'orchestral',
    lyrics: '[verse]\nhello',
    duration_seconds: 45,
    seed: 5,
    cot: 'melody',
    title: 'Theme',
    ode_steps: 24,
    negative: 'drums',
    cfg_scale: 3.5,
  };
  assert.deepEqual(audioPayload('music', projectId, draftFor(request, 'music')).request, request);
  request = { ...request, duration_seconds: 30, cfg_scale: null, cot: 'full' };
  assert.deepEqual(audioPayload('music', projectId, draftFor(request, 'music')).request, request);
  // A custom melody score and song sampling come back too.
  request = {
    ...request,
    abc: 'X:1\nK:C\nCDEF|',
    temperature: 0.8,
    top_p: 0.9,
    top_k: 50,
    repetition_penalty: 1.1,
  };
  assert.deepEqual(audioPayload('music', projectId, draftFor(request, 'music')).request, request);

  request = { prompt: 'door', duration: 12, steps: 20, seed: 9 };
  assert.deepEqual(audioPayload('sfx', projectId, draftFor(request, 'sfx')).request, request);
  request = { prompt: 'door', duration: 5, steps: 8, seed: -1 };
  assert.deepEqual(audioPayload('sfx', projectId, draftFor(request, 'sfx')).request, request);

  request = {
    text: 'Hello there',
    speaker: 'Vivian',
    language: 'French',
    instruct: 'softly',
    max_new_tokens: 512,
    seed: 31,
  };
  assert.deepEqual(audioPayload('voices', projectId, draftFor(request, 'voices')).request, request);
  request = { ...request, temperature: 0.6, top_p: 0.8, top_k: 20, repetition_penalty: 1.2 };
  assert.deepEqual(audioPayload('voices', projectId, draftFor(request, 'voices')).request, request);

  request = {
    model: 'hunyuan',
    references: [ref()],
    seed: 3,
    steps: 40,
    resolution: 256,
    guidance: 7.5,
    target_faces: 20000,
    texture: true,
    texture_size: 1024,
  };
  assert.deepEqual(
    without(hunyuanShapeRequest(draftFor(request, '3d')), 'references'),
    without(request, 'references'),
  );
  request = { model: 'hunyuan', references: [ref()], seed: 3, steps: 30, resolution: 128 };
  assert.deepEqual(
    without(hunyuanShapeRequest(draftFor(request, '3d')), 'references'),
    without(request, 'references'),
  );

  request = {
    model: 'trellis',
    references: [ref()],
    seed: 8,
    steps: 20,
    texture_size: 2048,
    target_faces: 250000,
  };
  assert.deepEqual(
    without(trellisRequest(draftFor(request, 'trellis')), 'references'),
    without(request, 'references'),
  );

  // A TRELLIS.2 render made before the triangle target existed exported up to a million.
  request = { model: 'trellis', references: [ref()], seed: 8, steps: 20, texture_size: 2048 };
  assert.equal(draftFor(request, 'trellis').trellisTriangles, '1000000');
  assert.equal(trellisRequest(draftFor(request, 'trellis')).target_faces, 1000000);

  request = {
    model: 'hy-motion',
    prompt: 'walks',
    duration: 4.5,
    seed: 11,
    steps: 40,
    guidance: 6,
  };
  assert.deepEqual(hyMotionRequest(draftFor(request, 'motion')), request);

  request = { pose: ref('bvh'), context_frame: 2, target_frame: 30, min_tokens: 7, max_tokens: 12 };
  assert.deepEqual(
    without(motionBricksRequest(draftFor(request, 'motion-bricks')), 'pose'),
    without(request, 'pose'),
  );

  const segmentation = reusePlan(
    record('segmentation', {
      prompt: 'compass',
      references: [ref()],
      output: 'mask',
      confidence: 0.4,
    }),
  );
  assert.equal(segmentation.section, 'segmentation');
  assert.equal(segmentation.draft.prompt, 'compass');
  assert.equal(segmentation.draft.confidence, '0.4');
  assert.equal(segmentation.draft.options[1], 'Mask PNG');
});

test('reuse targets the right page and model, never carries references, and skips unknown types', () => {
  const trellis = reusePlan(
    record('trellis', {
      model: 'trellis',
      references: [ref()],
      seed: 1,
      steps: 12,
      texture_size: 1024,
    }),
  );
  assert.equal(trellis.section, '3d');
  assert.equal(trellis.model, 'TRELLIS.2');
  const job = draftJob(trellis, 'project-1');
  assert.equal(job.kind, '3d');
  assert.deepEqual(job.refs, []);
  assert.equal(job.model, 'TRELLIS.2');
  assert.equal(
    draftJob(
      reusePlan(
        record('images', {
          prompt: 'x',
          width: 1024,
          height: 1024,
          num_inference_steps: 30,
          references: [],
        }),
      ),
      'p',
    ).model,
    undefined,
  );
  const world = reusePlan(
    record('world', {
      model: 'hy-world',
      mode: 'image',
      references: [ref()],
      resolution: 518,
      seed: 1,
      steps: 20,
      output: 'splat',
    }),
  );
  assert.deepEqual([world.section, world.model], ['world', 'hy-world']);
  assert.equal(reusePlan({ source: 'saved-text', job: null, settings: {} }), null);
  assert.equal(reusePlan(null), null);
});

test('settings are listed in a stable order with readable labels', () => {
  const meta = record('sfx', { prompt: 'x', duration: 5, steps: 8, seed: -1 });
  const list = describeSettings(meta);
  assert.deepEqual(
    list.map((item) => [item.label, item.value]),
    [
      ['Seed', 'Random'],
      ['Steps', '8'],
      ['Duration (s)', '5'],
    ],
  );
  const bool = describeSettings({ settings: { texture: true, custom_value: 2 }, seed: 4 });
  assert.deepEqual(
    bool.map((item) => [item.label, item.value]),
    [
      ['Seed', '4'],
      ['Texture', 'On'],
      ['Custom value', '2'],
    ],
  );
});

test('music settings read in plain words, including the planning mode and a custom score', () => {
  const meta = record('music', {
    style: 's',
    lyrics: '[Instrumental]',
    duration_seconds: 8,
    seed: 4,
    cot: 'full',
    ode_steps: 16,
    abc: 'X:1',
    temperature: 0.9,
    top_p: 0.9,
    top_k: 40,
    repetition_penalty: 1.1,
  });
  const byLabel = Object.fromEntries(
    describeSettings(meta).map((item) => [item.label, item.value]),
  );
  assert.equal(byLabel.Planning, 'Full arrangement');
  assert.equal(byLabel['Melody score'], 'Custom ABC score (3 characters)');
  assert.equal(byLabel.Temperature, '0.9');
  assert.equal(byLabel['Top-p'], '0.9');
  assert.equal(byLabel['Top-k'], '40');
  assert.equal(byLabel['Repetition penalty'], '1.1');
});

async function renderDetails(responses, props = {}) {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.generation-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const names = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  });
  const requests = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url) => {
      requests.push(String(url));
      const body = responses(String(url));
      return { ok: body !== undefined, json: async () => body ?? { error: 'nope' } };
    },
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  let root;
  try {
    const sourcePath = path.join(repositoryRoot, 'src', 'GenerationDetails.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(/^import [^;]*;\r?\n/gm, '');
    const helperUrl = pathToFileURL(path.join(repositoryRoot, 'src', 'generation-details.js')).href;
    const prelude = `
      import React, { useEffect, useId, useState } from 'react';
      import { describeSettings, describeSource, formatSeconds, modelLabel, negativeLabel, reusePlan, secondaryLabel } from '${helperUrl}';
      const Check = () => null;
      const Copy = () => null;
      const RotateCcw = () => null;
    `;
    const transformed = await transformWithEsbuild(`${prelude}\n${source}`, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'GenerationDetails.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: GenerationDetails } = await import(pathToFileURL(modulePath).href);
    const container = document.querySelector('#root');
    root = createRoot(container);
    const element = (asset) =>
      React.createElement(GenerationDetails, {
        project: { id: 'project-1' },
        asset,
        ...props,
      });
    const asset = { id: 'images/forge-a.png', sample: false };
    await act(async () => root.render(element(asset)));
    await act(async () => {});
    return { container, requests, copied, asset, root, element, window: dom.window };
  } catch (error) {
    root?.unmount();
    throw error;
  } finally {
    // Cleanup is registered by the caller through the returned dispose function.
    renderDetails.cleanup = async () => {
      await act(async () => root?.unmount());
      dom.window.close();
      for (const [name, descriptor] of Object.entries(previous)) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete globalThis[name];
        }
      }
      await rm(temporaryDirectory, { recursive: true, force: true });
    };
  }
}

const longPrompt = `${'A weathered potion shop in an enchanted forest. '.repeat(12)}END`;
const fullMeta = {
  schemaVersion: 1,
  asset: { path: 'images/forge-a.png', kind: 'image', createdAt: '2026-11-07T10:00:30.000Z' },
  source: 'job',
  backfilled: true,
  type: 'images',
  job: { id: '11111111-2222-3333-4444-555555555555', type: 'images' },
  model: { name: 'Qwen Image 2.1', id: 'images', version: 'Qwen-Image-2.1' },
  prompt: { text: longPrompt, negative: 'blurry', secondary: null, title: null },
  seed: 77,
  settings: { width: 1024, height: 576, num_inference_steps: 30, seed: 77 },
  references: [{ name: 'abc.png', id: 'abc.png', mime: 'image/png', size: 4096 }],
  timing: { startedAt: null, finishedAt: null, seconds: 42 },
  parent: null,
  tool: { name: 'Forge', version: '0.1.0' },
};

test('generation details show model, prompt, settings, references and reuse', async (t) => {
  let reused = null;
  const view = await renderDetails(() => ({ metadata: fullMeta }), {
    onReuse: (meta) => (reused = meta),
  });
  t.after(() => renderDetails.cleanup());
  const { container } = view;
  assert.ok(
    view.requests[0].includes('/api/projects/project-1/assets/details?path=images%2Fforge-a.png'),
  );
  assert.equal(container.querySelector('h3').textContent, 'Generation details');
  const text = container.textContent;
  for (const expected of [
    'Qwen Image 2.1',
    'Qwen-Image-2.1',
    'Negative prompt',
    'blurry',
    '42 s',
    'Steps',
    '1024',
    'abc.png',
    '4 KB',
    'recovered from render history',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.ok(!text.includes('END'), 'a long prompt is clamped until expanded');
  const more = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await act(async () => more.click());
  assert.ok(container.textContent.includes('END'));
  assert.equal(more.getAttribute('aria-expanded'), 'true');

  const copy = [...container.querySelectorAll('button')].find((b) =>
    /Copy\s*prompt/.test(b.textContent),
  );
  await act(async () => copy.click());
  assert.deepEqual(view.copied, [longPrompt]);
  assert.ok(container.textContent.includes('Prompt copied.'));

  const reuse = [...container.querySelectorAll('button')].find((b) =>
    b.textContent.includes('Reuse settings'),
  );
  assert.ok(container.textContent.includes('not attached automatically'));
  await act(async () => reuse.click());
  assert.equal(reused, fullMeta);
});

test('generation details say plainly when nothing was recorded or the service failed', async (t) => {
  let view = await renderDetails(() => ({ metadata: null }));
  assert.ok(view.container.textContent.includes('No generation details recorded for this file.'));
  assert.equal(view.container.querySelector('button'), null);
  await renderDetails.cleanup();

  view = await renderDetails(() => ({ metadata: null, unavailable: true }));
  assert.ok(view.container.textContent.includes('unavailable right now'));
  assert.ok(!view.container.textContent.includes('No generation details recorded'));
  await renderDetails.cleanup();

  view = await renderDetails(() => undefined);
  assert.ok(view.container.textContent.includes('unavailable right now'));
  await renderDetails.cleanup();

  // Samples have no project record to read.
  view = await renderDetails(() => ({ metadata: fullMeta }));
  await act(async () => view.root.render(view.element({ id: 'sample', sample: true })));
  assert.equal(view.container.querySelector('section'), null);
  t.after(() => renderDetails.cleanup());
});

test('3D triangle targets are shown with thousands separators and the engine id is hidden', () => {
  const rows = describeSettings({
    type: 'trellis',
    settings: { model: 'trellis', target_faces: 100000, steps: 12 },
  });
  assert.deepEqual(
    rows.map((row) => [row.label, row.value]),
    [
      ['Steps', '12'],
      ['Triangle target', '100,000'],
    ],
  );
});
