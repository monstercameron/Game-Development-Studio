import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('native image thumbnails load directly even when the thumbnail cache is unavailable', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = new Map();
  let fetches = 0;
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => {
      fetches += 1;
      throw Error('cache unavailable');
    },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  const { default: AssetThumbnail } = await vite.ssrLoadModule('/src/AssetThumbnail.jsx');
  const root = createRoot(document.querySelector('#root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });
  const render = async (asset) =>
    act(async () =>
      root.render(React.createElement(AssetThumbnail, { asset, project: { id: 'p' } })),
    );
  await render({ id: 'images/one.png', category: 'Images', url: '/asset/one.png' });
  assert.equal(document.querySelector('img')?.getAttribute('src'), '/asset/one.png');
  assert.equal(fetches, 0, 'native images do not depend on the thumbnail cache');
  await act(async () => document.querySelector('img').dispatchEvent(new dom.window.Event('error')));
  assert.match(
    document.querySelector('.asset-thumbnail-placeholder').textContent,
    /Preview unavailable/,
  );
  await render({ id: 'masks/two.webp', category: 'Masks', url: '/asset/two.webp' });
  assert.equal(document.querySelector('img')?.getAttribute('src'), '/asset/two.webp');
});
