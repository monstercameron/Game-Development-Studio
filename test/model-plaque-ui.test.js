import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('model plaque only offers a working change action when its selector exists', async () => {
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
      server: { middlewareMode: true, watch: null, hmr: false },
    });
    const { default: ModelPlaque } = await vite.ssrLoadModule('/src/ModelPlaque.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ModelPlaque, {
          model: 'Qwen Image 2.1',
          supportsRender: true,
          hasModelSelector: false,
        }),
      );
    });

    const fixedModelPlaque = container.querySelector('.model-plaque');
    assert.equal(fixedModelPlaque.tagName, 'DIV');
    assert.equal(fixedModelPlaque.querySelector('button'), null);
    assert.match(fixedModelPlaque.textContent, /Render workflow/);

    const selector = document.createElement('select');
    selector.id = 'model3d';
    selector.scrollIntoView = () => {};
    document.body.append(selector);

    await act(async () => {
      root.render(
        React.createElement(ModelPlaque, {
          model: 'TRELLIS.2',
          supportsRender: true,
          hasModelSelector: true,
        }),
      );
    });

    const selectorPlaque = container.querySelector('.model-plaque');
    assert.equal(selectorPlaque.tagName, 'BUTTON');
    assert.equal(selectorPlaque.querySelector('div'), null);
    assert.match(selectorPlaque.textContent, /Change model/);
    await act(async () => {
      selectorPlaque.click();
    });
    assert.equal(document.activeElement, selector);
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
