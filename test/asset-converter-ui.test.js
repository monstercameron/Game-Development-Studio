import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('asset conversion explains copy location and reports the backend returned by the service', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let vite;
  let root;
  let savedCount = 0;
  const requests = [];

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          name: 'portrait-converted.jpg',
          path: 'Images/portrait-converted.jpg',
          backend: 'CPU',
          url: '/api/projects/example/asset?path=Images%2Fportrait-converted.jpg',
        }),
      };
    };
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false },
    });
    const { default: AssetConverter } = await vite.ssrLoadModule('/src/AssetConverter.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(AssetConverter, {
          asset: { id: 'Images/portrait.png', category: 'Images' },
          project: { id: 'example' },
          onSaved: () => {
            savedCount++;
          },
        }),
      );
    });

    assert.match(container.textContent, /portrait\.png/);
    assert.match(container.textContent, /Same project folder/);
    const format = container.querySelector('select');
    assert.deepEqual(
      [...format.options].map((option) => option.value),
      ['png', 'webp', 'jpeg', 'bmp', 'tga'],
    );
    await act(async () => {
      format.value = 'jpeg';
      format.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.match(container.textContent, /nvJPEG/);
    await act(async () => {
      container
        .querySelector('form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });

    assert.deepEqual(requests, [
      {
        url: '/api/projects/example/assets/convert',
        body: {
          path: 'Images/portrait.png',
          format: 'jpeg',
          quality: 90,
          background: '#ffffff',
        },
      },
    ]);
    assert.equal(savedCount, 1);
    assert.match(container.querySelector('[role="status"]')?.textContent || '', /CPU/);
    assert.match(container.textContent, /Saved to Images\/portrait-converted\.jpg/);
    assert.match(container.textContent, /Saved portrait-converted\.jpg/);
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.close();
    if (previousGlobals.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousGlobals.window;
    }
    if (previousGlobals.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousGlobals.document;
    }
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    if (previousGlobals.fetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = previousGlobals.fetch;
    }
    if (previousGlobals.actEnvironment === undefined) {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
    }
  }
});
