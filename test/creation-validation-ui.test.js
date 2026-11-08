import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createServer } from 'vite';
import { creationFieldErrors, validationSummary } from '../src/creation-validation.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const projectId = '11111111-1111-4111-8111-111111111111';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Rendering a creation page posts price estimates; only real queue submissions matter here.
// Estimates and browser log batches are not queue submissions.
const notEstimate = (url) => !url.endsWith('/estimate') && !url.endsWith('/api/logs/ingest');
const draftFor = (extra = {}) => ({ prompt: '', second: '', refs: [], ...extra });

test('required fields are reported in form order with the field that owns each message', () => {
  assert.deepEqual(
    creationFieldErrors({ section: 'music', draft: draftFor() }).map((error) => error.field),
    ['prompt', 'lyrics'],
  );
  const segmentation = creationFieldErrors({ section: 'segmentation', draft: draftFor() });
  assert.deepEqual(
    segmentation.map((error) => [error.field, error.id, error.focusId]),
    [
      ['prompt', 'prompt-error', 'prompt'],
      ['reference', 'reference-error', 'reference-file'],
    ],
  );
  assert.deepEqual(
    creationFieldErrors({
      section: '3d',
      draft: draftFor({ threeDMode: 'text', prompt: '   ' }),
    }).map((error) => error.field),
    ['description'],
  );
  assert.deepEqual(
    creationFieldErrors({
      section: '3d',
      draft: draftFor({ prompt: 'ignored for an image-first model' }),
      files: { shapeFiles: [] },
    }).map((error) => error.message),
    ['Choose a reference image before rendering.'],
  );
  assert.deepEqual(
    creationFieldErrors({
      section: 'motion',
      draft: draftFor(),
      model: 'NVIDIA MotionBricks',
      files: {},
    }).map((error) => error.field),
    ['pose'],
  );
  assert.equal(validationSummary([{}]), 'One field needs attention before this can be queued.');
  assert.equal(validationSummary([{}, {}]), '2 fields need attention before this can be queued.');
});

test('files that were listed but not attached ask to be chosen again, and size limits are checked', () => {
  const lostFile = creationFieldErrors({
    section: 'images',
    draft: draftFor({ prompt: 'a barrel', refs: [{ name: 'a.png', size: 10 }] }),
    files: { imageFiles: [] },
  });
  assert.match(lostFile[0].message, /Choose the image references again/);
  const big = { name: 'big.png', size: 11 * 1024 * 1024 };
  const tooBig = creationFieldErrors({
    section: 'images',
    draft: draftFor({ prompt: 'a barrel', refs: [big] }),
    files: { imageFiles: [big] },
  });
  assert.match(tooBig[0].message, /under 10 MiB each/);
  assert.deepEqual(
    creationFieldErrors({
      section: 'images',
      draft: draftFor({ prompt: 'a barrel' }),
      files: { imageFiles: [] },
    }),
    [],
  );
  const trellis = creationFieldErrors({
    section: '3d',
    draft: draftFor({ refs: [{ name: 'photo.jpg', size: 10 }] }),
    model: 'TRELLIS.2',
    files: { shapeFiles: [{ name: 'photo.jpg', size: 10 }] },
  });
  assert.match(trellis[0].message, /transparent PNG or WebP/);
});

test('the draft path only needs a description, or a reference for a 3D draft', () => {
  assert.deepEqual(
    creationFieldErrors({ section: 'game', draft: draftFor(), forDraft: true }).map(
      (error) => error.field,
    ),
    ['prompt'],
  );
  assert.deepEqual(
    creationFieldErrors({ section: '3d', draft: draftFor(), forDraft: true }).map(
      (error) => error.message,
    ),
    ['Add a reference image for your 3D draft.'],
  );
  assert.deepEqual(
    creationFieldErrors({
      section: 'motion',
      draft: draftFor(),
      model: 'NVIDIA MotionBricks',
      forDraft: true,
    }),
    [],
  );
});

// Mounts the whole studio at a creation page in jsdom with a substitute API. No engine runs.
async function openPage(t, path) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost/${path}${path.includes('?') ? '&' : '?'}project=${projectId}`,
  });
  const names = [
    'window',
    'document',
    'navigator',
    'localStorage',
    'sessionStorage',
    'MutationObserver',
    'NodeFilter',
    'Node',
    'Element',
    'HTMLElement',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MouseEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IntersectionObserver',
  ];
  const previous = Object.fromEntries(
    names
      .concat(['fetch', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'matchMedia'])
      .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const set = (name, value) =>
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const timers = [];
  const posts = [];
  const server = { vite: null };
  t.after(async () => {
    await act(async () => {
      dom.window.close();
    });
    await server.vite?.close();
    for (const [name, real] of timers) {
      set(name, real);
    }
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  });
  for (const name of names) {
    const value = dom.window[name];
    set(
      name,
      typeof value === 'function' && name.includes('Animation') ? value.bind(dom.window) : value,
    );
  }
  set(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  // The app's polling timers must not keep this process alive once the page is closed.
  for (const name of ['setTimeout', 'setInterval']) {
    const real = globalThis[name];
    timers.push([name, real]);
    set(name, (...args) => real(...args).unref());
  }
  set('IS_REACT_ACT_ENVIRONMENT', true);
  set(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  set('matchMedia', matchMedia);
  dom.window.matchMedia = matchMedia;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  set('fetch', async (input, options = {}) => {
    const url = String(input);
    if (options.method === 'POST') {
      posts.push(url);
      return json({ jobs: [], job: { id: 'a' } }, 201);
    }
    if (url.startsWith('/api/projects')) {
      return json({
        projects: [
          { id: projectId, name: 'Game', assets: [], folder: 'x', createdAt: '2026-01-01' },
        ],
      });
    }
    if (url === '/api/runtime/jobs') {
      return json({ jobs: [] });
    }
    if (url === '/api/runtime/services') {
      return json({ services: [] });
    }
    return json({}, 404);
  });
  server.vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  await act(async () => {
    await server.vite.ssrLoadModule('/src/main.jsx');
  });
  await act(async () => {
    await wait(300);
  });
  const type = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const submit = async () => {
    await act(async () => {
      document.querySelector('button.create-action').click();
      await wait(50);
    });
  };
  const alertFor = (id) => document.getElementById(id);
  return { dom, posts, type, submit, alertFor };
}

function assertInvalid(field, errorId, pattern) {
  assert.equal(field.getAttribute('aria-invalid'), 'true');
  assert.ok(field.getAttribute('aria-describedby').split(' ').includes(errorId));
  const message = document.getElementById(errorId);
  assert.ok(message, `${errorId} is rendered`);
  assert.equal(message.getAttribute('role'), 'alert');
  assert.match(message.textContent, pattern);
}

test('Segmentation shows the prompt and reference problems beside their fields and moves focus', async (t) => {
  const { dom, type, submit, posts } = await openPage(t, 'segmentation');
  assert.equal(document.getElementById('prompt-error'), null, 'a fresh page shows no errors');

  await submit();
  assertInvalid(document.getElementById('prompt'), 'prompt-error', /Describe what to isolate/);
  assertInvalid(
    document.getElementById('reference-file'),
    'reference-error',
    /Choose a reference image to segment/,
  );
  assert.equal(document.activeElement.id, 'prompt', 'focus moves to the first invalid field');
  assert.match(document.querySelector('.toast').textContent, /2 fields need attention/);
  assert.deepEqual(posts.filter(notEstimate), [], 'nothing is queued');

  await act(async () => {
    type(document.getElementById('prompt'), 'the barrel');
  });
  assert.equal(document.getElementById('prompt-error'), null, 'the message clears once fixed');
  assert.equal(document.getElementById('prompt').getAttribute('aria-invalid'), null);
  assert.ok(document.getElementById('reference-error'), 'the other message stays');

  await submit();
  assert.equal(document.activeElement.id, 'reference-file');
  dom.window.close();
});

test('the 3D page explains a missing reference image and a missing description', async (t) => {
  const { submit, type } = await openPage(t, '3d');
  await submit();
  assertInvalid(
    document.getElementById('reference-file'),
    'reference-error',
    /Choose a reference image before rendering/,
  );
  assert.equal(document.activeElement.id, 'reference-file');

  await act(async () => {
    document.querySelectorAll('input[name="three-d-mode"]')[1].click();
  });
  assert.equal(
    document.getElementById('reference-error'),
    null,
    'the picker is hidden in text mode',
  );
  await submit();
  assertInvalid(
    document.getElementById('three-d-text-prompt'),
    'three-d-text-prompt-error',
    /Describe the object you want to create/,
  );
  assert.equal(document.activeElement.id, 'three-d-text-prompt');

  await act(async () => {
    type(document.getElementById('three-d-text-prompt'), 'a barrel');
  });
  assert.equal(document.getElementById('three-d-text-prompt-error'), null);
});

test('Sound effects, Images and Voices put the prompt message beside the prompt', async (t) => {
  for (const [path, pattern] of [
    ['sfx', /Add a sound description/],
    ['images', /Add an image description/],
    ['voices', /Add dialogue/],
  ]) {
    const { submit, posts } = await openPage(t, path);
    await submit();
    assertInvalid(document.getElementById('prompt'), 'prompt-error', pattern);
    assert.equal(document.activeElement.id, 'prompt', `${path}: focus is on the prompt`);
    assert.deepEqual(posts.filter(notEstimate), [], `${path}: nothing is queued`);
  }
});

test('Music asks for the style and the lyrics separately', async (t) => {
  const { submit, type } = await openPage(t, 'music');
  await submit();
  assertInvalid(document.getElementById('prompt'), 'prompt-error', /Add a music style/);
  assertInvalid(document.getElementById('extra'), 'extra-error', /Add lyrics/);
  await act(async () => {
    type(document.getElementById('prompt'), 'lofi piano');
  });
  await submit();
  assert.equal(document.activeElement.id, 'extra', 'focus moves on to the lyrics');
});

test('Video explains a missing description and then missing references', async (t) => {
  const { submit, type } = await openPage(t, 'video');
  await submit();
  assertInvalid(document.getElementById('prompt'), 'prompt-error', /Add a video description/);
  assert.equal(document.activeElement.id, 'prompt');
  await act(async () => {
    type(document.getElementById('prompt'), 'a knight rides');
  });
  await submit();
  assertInvalid(
    document.getElementById('reference-file'),
    'reference-error',
    /Add 1–9 reference images/,
  );
  assert.equal(document.activeElement.id, 'reference-file');
});

test('Motion shows the description error beside the description', async (t) => {
  const { submit } = await openPage(t, 'motion');
  await submit();
  assertInvalid(document.getElementById('prompt'), 'prompt-error', /Describe the human motion/);
});

test('MotionBricks asks for its pose file beside the file picker', async (t) => {
  const { submit } = await openPage(t, 'motion?model=NVIDIA%20MotionBricks');
  await submit();
  assertInvalid(
    document.getElementById('motionbricks-file'),
    'motionbricks-source-error',
    /Choose a SOMA BVH file/,
  );
  assert.equal(document.activeElement.id, 'motionbricks-file');
});
