import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Renders the 3D page's new controls in jsdom: the start-from choice, text-to-3D fields, the
// remove-background option and the TRELLIS.2 pipeline select.
test('3D page controls: description mode, background removal and TRELLIS pipelines', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  let vite;
  let root;
  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // The pipeline list comes from the runtime service list; answer it without a network.
    let servicesPipelines = ['512', '1024'];
    globalThis.fetch = async (url) => {
      if (String(url) === '/api/runtime/services') {
        return {
          ok: true,
          json: async () => ({ services: [{ id: '3d-trellis', pipelines: servicesPipelines }] }),
        };
      }
      throw Error(`Unexpected request ${url}`);
    };
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: { ignored: ['**/.forge-runtime/**'] } },
    });
    const { ThreeDBackgroundOption, ThreeDModeSwitch } =
      await vite.ssrLoadModule('/src/ThreeDInputs.jsx');
    const { default: TrellisControls } = await vite.ssrLoadModule('/src/TrellisControls.jsx');
    const { fileKey } = await vite.ssrLoadModule('/src/image-alpha.js');
    const container = document.querySelector('#root');
    root = createRoot(container);
    const render = async (element) => act(async () => root.render(element));
    const changes = [];
    const onChange = (values) => changes.push(values);

    // Start from a reference image (default): no description fields.
    await render(React.createElement(ThreeDModeSwitch, { draft: {}, onChange, trellis: false }));
    assert.match(container.textContent, /Start from/);
    assert.equal(
      container.querySelector('input[type=radio]:checked').nextSibling.textContent,
      'A reference image',
    );
    assert.equal(container.querySelector('#three-d-text-prompt'), null);
    container.querySelectorAll('input[type=radio]')[1].click();
    assert.deepEqual(changes.at(-1), { threeDMode: 'text' });

    // Describe it instead: prompt, editable image steps and seed, model and memory copy.
    await render(
      React.createElement(ThreeDModeSwitch, {
        draft: { threeDMode: 'text', prompt: 'a barrel' },
        onChange,
        trellis: true,
      }),
    );
    assert.equal(container.querySelector('#three-d-text-prompt').value, 'a barrel');
    assert.equal(container.querySelector('#three-d-image-steps').value, '25');
    assert.equal(
      container.querySelector('#three-d-image-seed').getAttribute('placeholder'),
      'Random',
    );
    assert.match(container.textContent, /Qwen Image 2\.1/);
    assert.match(container.textContent, /1024\s+×\s+1024, transparent background/);
    assert.match(container.textContent, /builds the 3D model from it with TRELLIS\.2/);
    assert.match(
      container.textContent,
      /Forge frees the first model before loading the second when it can/,
    );
    assert.match(container.textContent, /estimate on this page covers the 3D step only/);
    assert.equal(
      container.querySelector('#three-d-image-steps').getAttribute('aria-invalid'),
      null,
    );

    await render(
      React.createElement(ThreeDModeSwitch, {
        draft: { threeDMode: 'text', textImageSteps: '0', textImageSeed: 'abc' },
        onChange,
        trellis: false,
      }),
    );
    assert.equal(
      container.querySelector('#three-d-image-steps').getAttribute('aria-invalid'),
      'true',
    );
    assert.equal(
      container.querySelector('#three-d-image-seed').getAttribute('aria-invalid'),
      'true',
    );
    assert.match(container.querySelector('[role=alert]').textContent, /whole number from 1 to 100/);
    assert.match(container.textContent, /builds the 3D model from it with Hunyuan3D 2\.1/);

    // Remove the background: needs a file to measure, then explains the result.
    const file = { name: 'photo.png', size: 100, lastModified: 1, type: 'image/png' };
    const key = fileKey(file);
    changes.length = 0;
    await render(
      React.createElement(ThreeDBackgroundOption, { draft: {}, onChange, file, trellis: true }),
    );
    assert.match(container.textContent, /Remove the background first \(uses SAM 3\.1\)/);
    // jsdom cannot decode images, so the measurement is "unknown" and nothing is blocked.
    assert.deepEqual(changes.at(-1), { refAlpha: { key, status: 'unknown' } });
    const checkbox = () => container.querySelector('#three-d-remove-background');
    assert.equal(checkbox().disabled, false);
    assert.equal(container.querySelector('#three-d-remove-prompt'), null);

    await render(
      React.createElement(ThreeDBackgroundOption, {
        draft: { refAlpha: { key, status: 'opaque' } },
        onChange,
        file,
        trellis: true,
      }),
    );
    assert.match(container.textContent, /TRELLIS\.2 rejects it\. Tick this box/);
    await render(
      React.createElement(ThreeDBackgroundOption, {
        draft: { refAlpha: { key, status: 'opaque' } },
        onChange,
        file,
        trellis: false,
      }),
    );
    assert.match(container.textContent, /treats an opaque picture as all object/);

    await render(
      React.createElement(ThreeDBackgroundOption, {
        draft: {
          refAlpha: { key, status: 'opaque' },
          removeBackground: true,
          removeBackgroundPrompt: '',
        },
        onChange,
        file,
        trellis: false,
      }),
    );
    assert.equal(checkbox().checked, true);
    assert.equal(
      container.querySelector('#three-d-remove-prompt').getAttribute('placeholder'),
      'main object',
    );
    assert.match(container.textContent, /SAM 3\.1 cuts out what you describe/);
    assert.match(container.textContent, /frees SAM 3.1 before loading the 3D model when it can/);
    checkbox().click();
    assert.deepEqual(changes.at(-1), { removeBackground: false });

    // A picture that already has a transparent background is left alone and the box is disabled.
    await render(
      React.createElement(ThreeDBackgroundOption, {
        draft: { refAlpha: { key, status: 'transparent' }, removeBackground: true },
        onChange,
        file,
        trellis: true,
      }),
    );
    assert.equal(checkbox().disabled, true);
    assert.equal(checkbox().checked, false);
    assert.match(container.textContent, /already has a transparent background/);
    assert.equal(container.querySelector('#three-d-remove-prompt'), null);

    // A stored measurement for another file is ignored.
    await render(
      React.createElement(ThreeDBackgroundOption, {
        draft: { refAlpha: { key: 'other.png:1:1', status: 'transparent' } },
        onChange,
        file,
        trellis: false,
      }),
    );
    assert.equal(checkbox().disabled, false);

    // TRELLIS pipelines: only installed ones are offered, with honest memory and timing copy.
    await render(
      React.createElement(TrellisControls, { draft: {}, onChange, installedPipelines: ['512'] }),
    );
    const options = () =>
      [...container.querySelectorAll('#trellis-pipeline option')].map((o) => o.value);
    assert.deepEqual(options(), ['512']);
    assert.match(container.querySelector('#trellis-pipeline-help').textContent, /about 24 GB/);
    await render(
      React.createElement(TrellisControls, {
        draft: { trellisPipeline: '1536_cascade' },
        onChange,
        installedPipelines: ['512', '1024', '1024_cascade', '1536_cascade'],
      }),
    );
    assert.deepEqual(options(), ['512', '1024', '1024_cascade', '1536_cascade']);
    assert.equal(container.querySelector('#trellis-pipeline').value, '1536_cascade');
    const help = container.querySelector('#trellis-pipeline-help').textContent;
    assert.match(help, /about 64 GB of free GPU memory/);
    assert.match(help, /about 5 GB of extra checkpoints/);
    assert.match(help, /One test object took about 9 minutes/);
    const select = container.querySelector('#trellis-pipeline');
    select.value = '1024';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.deepEqual(changes.at(-1), { trellisPipeline: '1024' });

    // Text-to-3D needs no reference, so the controls must not ask for one.
    await render(
      React.createElement(TrellisControls, {
        draft: { threeDMode: 'text' },
        onChange,
        installedPipelines: ['512'],
      }),
    );
    const referenceHelp = container.querySelector('.trellis-controls__reference-help').textContent;
    assert.match(referenceHelp, /no reference image is needed/);
    assert.doesNotMatch(referenceHelp, /Requires one PNG/);

    // Without a list the component asks the runtime; a missing pipeline is then hidden.
    await render(React.createElement(TrellisControls, { draft: {}, onChange }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.deepEqual(options(), ['512', '1024']);
    servicesPipelines = undefined;
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.close();
    globalThis.window = previousGlobals.window;
    globalThis.document = previousGlobals.document;
    globalThis.fetch = previousGlobals.fetch;
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
  }
});
