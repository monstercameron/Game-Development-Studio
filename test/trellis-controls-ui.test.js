import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('TRELLIS.2 controls explain requirements and associate step errors with the step field', async () => {
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
      server: {
        middlewareMode: true,
        watch: { ignored: ['**/.forge-runtime/**'] },
      },
    });
    const { default: TrellisControls } = await vite.ssrLoadModule('/src/TrellisControls.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(TrellisControls, { draft: { seed: 42 }, onChange() {} }));
    });

    assert.match(container.textContent, /Experimental/);
    assert.match(container.textContent, /not yet calibrated/i);
    assert.match(container.textContent, /Triangle budget/);
    assert.match(container.textContent, /100,000 triangles · default/);
    assert.match(container.textContent, /transparent background \(alpha channel\)/i);

    await act(async () => {
      root.render(
        React.createElement(TrellisControls, {
          draft: { seed: 42, trellisSteps: '51' },
          onChange() {},
        }),
      );
    });

    const steps = container.querySelector('#trellis-steps');
    assert.equal(steps.getAttribute('aria-invalid'), 'true');
    assert.match(steps.getAttribute('aria-describedby'), /trellis-steps-error/);
    assert.match(container.querySelector('#trellis-steps-error').textContent, /1 to 50/);
    assert.equal(container.querySelector('#trellis-texture').getAttribute('aria-invalid'), null);
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
