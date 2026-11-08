import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('Models & services offers Start only for a stopped service that a plain start allows', async () => {
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
  const posts = [];
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
    const service = (id, extra = {}) => ({
      id,
      status: 'unavailable',
      managed: false,
      canUnload: false,
      canForceStop: false,
      startsOnDemand: false,
      modelLoaded: null,
      busy: null,
      ...extra,
    });
    let services = [
      service('video'),
      service('music', { managed: true }),
      service('world', { startsOnDemand: true }),
      service('sfx', { ownershipRecovery: 'unresolved' }),
      service('images', { status: 'reachable', modelLoaded: false, busy: false }),
    ];
    globalThis.fetch = async (url, options = {}) => {
      posts.push([String(url), options.method || 'GET']);
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
      if (url === '/api/runtime/engines/video/start') {
        services = services.map((item) =>
          item.id === 'video' ? { ...item, managed: true } : item,
        );
        return json({ id: 'video', status: 'starting', pid: 123 });
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
    const startButtons = [...container.querySelectorAll('button')].filter((button) =>
      /^Start .* service$/.test(button.getAttribute('aria-label') || ''),
    );
    // Only the stopped, not owned, not on-demand, not fenced services get one: video, and sfx is
    // fenced by an unresolved ownership record, music is already managed, world is on demand.
    assert.deepEqual(
      startButtons.map((button) => button.getAttribute('aria-label')),
      ['Start MiniMax H3 Ref2VA service'],
    );
    await act(async () => {
      startButtons[0].click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.ok(
      posts.some(
        ([url, method]) => url === '/api/runtime/engines/video/start' && method === 'POST',
      ),
    );
    assert.match(container.textContent, /MiniMax H3 Ref2VA is starting/);
    assert.equal(
      [...container.querySelectorAll('button')].some((button) =>
        /^Start .* service$/.test(button.getAttribute('aria-label') || ''),
      ),
      false,
      'once the service is managed the button is gone',
    );
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
