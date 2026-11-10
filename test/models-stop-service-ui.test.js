import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('Stop service is disabled with the reason while a render is using the service', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/models',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
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
    // Two managed, reachable services with a model loaded: one is rendering, one is idle.
    const services = [
      {
        id: 'images',
        status: 'reachable',
        managed: true,
        busy: true,
        canUnload: false,
        canForceStop: true,
        modelLoaded: true,
        startsOnDemand: true,
      },
      {
        id: 'sfx',
        status: 'reachable',
        managed: true,
        busy: false,
        canUnload: true,
        canForceStop: true,
        modelLoaded: true,
        startsOnDemand: true,
      },
    ];
    globalThis.fetch = async (url) => {
      if (url === '/api/runtime/hardware') {
        return json({ devices: [], available: true });
      }
      if (url === '/api/runtime/services') {
        return json({ services });
      }
      if (url === '/api/runtime/health') {
        return json({ state: 'ready' });
      }
      if (url === '/api/runtime/model-storage') {
        return json({ state: 'ready', entries: [], removals: {} });
      }
      return json({}, false, 404);
    };
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      resolve: {
        alias: {
          'react-router': fileURLToPath(
            new URL('./fixtures/react-router-stub.js', import.meta.url),
          ),
        },
      },
      server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/.forge-runtime/**'] } },
    });
    const { default: Models } = await vite.ssrLoadModule('/src/Models.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(Models, { onNavigate() {} }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const stopButtons = [...container.querySelectorAll('button')].filter((button) =>
      /^Stop .* service$/.test(button.getAttribute('aria-label') || ''),
    );
    const blocked = stopButtons.filter((button) => button.disabled);
    const idle = stopButtons.filter((button) => !button.disabled);
    assert.equal(blocked.length, 1, 'the busy service shows a disabled Stop service');
    assert.equal(idle.length, 1, 'the idle service keeps an enabled Stop service');
    const reason = container.querySelector(`#${blocked[0].getAttribute('aria-describedby')}`);
    assert.ok(reason, 'the disabled button points at its reason');
    assert.match(reason.textContent, /Stop unavailable: A render is using this service/);
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
