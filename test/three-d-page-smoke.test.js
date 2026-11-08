import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const projectId = '11111111-1111-4111-8111-111111111111';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mounts the whole studio at /3d in jsdom with a substitute API, then drives the controls:
// the start-from choice, text-to-3D, the TRELLIS.2 pipeline, remove-background and the chain
// requests they post. No engine runs.
test('the 3D page queues chained text-to-3D and background-removal renders', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost/3d?project=${projectId}`,
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
  const posts = [];
  const timers = [];
  let vite;
  try {
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
      if (options.method === 'POST' && url.endsWith('/references')) {
        posts.push({ url, body: 'file' });
        return json({ reference: { id: '22222222-2222-4222-8222-222222222222.png' } }, 201);
      }
      if (options.method === 'POST') {
        posts.push({ url, body: JSON.parse(options.body) });
        return json({ jobs: [{ id: 'a' }, { id: 'b' }] }, 201);
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
        return json({
          services: [{ id: '3d-trellis', status: 'reachable', pipelines: ['512', '1024'] }],
        });
      }
      return json({}, 404);
    });
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    });
    await act(async () => {
      await vite.ssrLoadModule('/src/main.jsx');
    });
    await act(async () => {
      await wait(300);
    });
    const page = document.querySelector('.editor-page') || document.body;
    assert.match(page.textContent, /3D model studio/);
    assert.match(page.textContent, /Start from/);
    assert.match(page.textContent, /Remove the background first \(uses SAM 3\.1\)/);
    assert.equal(document.querySelector('#three-d-text-prompt'), null);

    // Choose TRELLIS.2 and "A description": the reference picker goes away.
    const modelSelect = document.querySelector('#model3d');
    await act(async () => {
      modelSelect.value = 'TRELLIS.2';
      modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => {
      await wait(50);
    });
    assert.ok(document.querySelector('#trellis-pipeline'));
    await act(async () => {
      document.querySelectorAll('input[name="three-d-mode"]')[1].click();
    });
    assert.ok(document.querySelector('#three-d-text-prompt'));
    assert.equal(document.querySelector('#three-d-remove-background'), null);
    assert.doesNotMatch(document.body.textContent, /Choose a reference image/);
    assert.match(
      document.body.textContent,
      /frees the first model before loading the second when it can/,
    );

    const prompt = document.querySelector('#three-d-text-prompt');
    const type = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    };
    await act(async () => {
      type(prompt, 'a wooden barrel');
    });
    const pipeline = document.querySelector('#trellis-pipeline');
    await act(async () => {
      pipeline.value = '1024';
      pipeline.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector('button.create-action').click();
      await wait(100);
    });
    const chain = posts.find((post) => post.url === '/api/runtime/jobs/chain');
    assert.ok(chain, 'the page posts to the chain endpoint');
    assert.equal(chain.body.steps[0].type, 'images');
    assert.equal(chain.body.steps[0].request.prompt, 'a wooden barrel');
    assert.equal(chain.body.steps[0].request.transparent, true);
    assert.equal(chain.body.steps[1].type, 'trellis');
    assert.equal(chain.body.steps[1].request.pipeline, '1024');
    assert.deepEqual(chain.body.steps[1].request.referenceFrom, { step: 0 });
    assert.match(document.body.textContent, /Picture and 3D model added to the durable queue/);

    // Back to a reference image: an opaque photo is cut out first, then the model is chained.
    await act(async () => {
      document.querySelectorAll('input[name="three-d-mode"]')[0].click();
    });
    const upload = document.querySelector('.upload-box input[type="file"]');
    assert.equal(upload.getAttribute('accept'), 'image/png,image/webp');
    const checkbox = () => document.querySelector('#three-d-remove-background');
    await act(async () => {
      checkbox().click();
    });
    assert.equal(
      document.querySelector('input[type="file"]').getAttribute('accept'),
      'image/png,image/jpeg,image/webp',
    );
    assert.equal(
      document.querySelector('#three-d-remove-prompt').getAttribute('placeholder'),
      'main object',
    );
    const photo = new dom.window.File([new Uint8Array(20)], 'photo.jpg', { type: 'image/jpeg' });
    await act(async () => {
      Object.defineProperty(upload, 'files', { configurable: true, value: [photo] });
      upload.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await wait(50);
    });
    // A JPEG has no transparency, so the box stays usable and says the photo has none.
    assert.equal(checkbox().disabled, false);
    assert.match(document.body.textContent, /SAM 3.1 cuts out what you describe/);
    posts.length = 0;
    await act(async () => {
      type(document.querySelector('#three-d-remove-prompt'), 'the barrel');
    });
    await act(async () => {
      document.querySelector('button.create-action').click();
      await wait(150);
    });
    assert.equal(posts[0].body, 'file');
    const cutout = posts.find((post) => post.url === '/api/runtime/jobs/chain');
    assert.ok(cutout, 'the cutout recipe posts to the chain endpoint');
    assert.equal(cutout.body.steps[0].type, 'segmentation');
    assert.equal(cutout.body.steps[0].request.prompt, 'the barrel');
    assert.deepEqual(cutout.body.steps[0].request.references, [
      '22222222-2222-4222-8222-222222222222.png',
    ]);
    assert.equal(cutout.body.steps[1].type, 'trellis');
    assert.equal(cutout.body.steps[1].request.pipeline, '1024');
    assert.deepEqual(cutout.body.steps[1].request.referenceFrom, { step: 0 });
    assert.match(document.body.textContent, /Cutout and 3D model added to the durable queue/);
  } finally {
    await act(async () => {
      dom.window.close();
    });
    await vite?.close();
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
  }
});
