import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Renders the Segmentation page's "Which matches" controls in jsdom. No model or network.
test('segmentation match controls: choice, limit field and inline error', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
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
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: { ignored: ['**/.forge-runtime/**'] } },
    });
    const { default: SegmentationMatchControls } = await vite.ssrLoadModule(
      '/src/SegmentationMatchControls.jsx',
    );
    const container = document.querySelector('#root');
    root = createRoot(container);
    const changes = [];
    const render = async (draft) =>
      act(async () =>
        root.render(
          React.createElement(SegmentationMatchControls, {
            draft,
            onChange: (values) => changes.push(values),
          }),
        ),
      );

    // Default and drafts saved before this option existed: every match, no limit field.
    await render({});
    const select = () => container.querySelector('#segmentation-matches');
    assert.equal(select().value, 'all');
    assert.equal(container.querySelector('label[for=segmentation-matches]') !== null, true);
    assert.deepEqual(
      [...select().options].map((option) => option.value),
      ['all', 'best', 'largest', 'top'],
    );
    assert.equal(container.querySelector('#segmentation-max-instances'), null);

    await act(async () => {
      select().value = 'best';
      select().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.deepEqual(changes.at(-1), { matches: 'best' });

    // The limit field appears for "best-scoring matches", with its default and help text.
    await render({ matches: 'top' });
    const limit = () => container.querySelector('#segmentation-max-instances');
    assert.equal(limit().value, '3');
    assert.equal(limit().getAttribute('aria-invalid'), null);
    assert.equal(container.querySelector('[role=alert]'), null);
    assert.match(container.textContent, /1 to 50/);

    // A bad limit is explained next to the field, not only when queueing fails.
    for (const bad of ['0', '51', '', '2.5']) {
      await render({ matches: 'top', maxInstances: bad });
      assert.equal(limit().getAttribute('aria-invalid'), 'true', bad);
      assert.match(
        container.querySelector('[role=alert]').textContent,
        /whole number from 1 to 50/,
      );
      assert.equal(limit().getAttribute('aria-describedby'), 'segmentation-max-instances-help');
    }

    await render({ matches: 'top', maxInstances: '7' });
    assert.equal(limit().value, '7');
    assert.equal(limit().getAttribute('aria-invalid'), null);
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.close();
    globalThis.window = previousGlobals.window;
    globalThis.document = previousGlobals.document;
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
  }
});
