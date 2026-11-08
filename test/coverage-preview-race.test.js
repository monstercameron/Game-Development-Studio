import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createServer, loadConfigFromFile } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function jsonResponse(value) {
  return {
    ok: true,
    json: async () => value,
  };
}

const previewTestStubs = {
  name: 'preview-area-race-test-stubs',
  enforce: 'pre',
  resolveId(source) {
    const modules = {
      'react-router': '\0preview-test-router',
      './useNav': '\0preview-test-nav',
      './TextAssetPreview': '\0preview-test-child',
      './InteractiveAssetViewer': '\0preview-test-child',
      './AssetThumbnail': '\0preview-test-thumbnail',
      './AssetConverter': '\0preview-test-converter',
    };
    return modules[source] || null;
  },
  load(id) {
    const modules = {
      '\0preview-test-router': `
        import { useState } from 'react';
        export function useSearchParams() {
          const [params] = useState(() => new URLSearchParams());
          return [params, () => {}];
        }
      `,
      '\0preview-test-nav': `
        import { useState } from 'react';
        export function useRouteToggle() {
          return useState(false);
        }
        export function updateSearch() {}
      `,
      '\0preview-test-child': `export default function Child() { return null; }`,
      '\0preview-test-thumbnail': `
        export const isVisualAsset = () => false;
        export default function AssetThumbnail() { return null; }
      `,
      '\0preview-test-converter': `
        export const canConvert = () => false;
        export default function AssetConverter() { return null; }
      `,
    };
    return modules[id] || null;
  },
};

test('a stale jobs poll cannot replace results from a newer overlapping poll', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const globalDescriptors = new Map();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event']) {
    globalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value:
        key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key],
      writable: true,
    });
  }

  const previousFetch = globalThis.fetch;
  const previousSetInterval = globalThis.setInterval;
  const previousClearInterval = globalThis.clearInterval;
  const previousActEnvironment = Object.getOwnPropertyDescriptor(
    globalThis,
    'IS_REACT_ACT_ENVIRONMENT',
  );
  const requests = [];
  const intervalCallbacks = new Map();
  let nextIntervalId = 1;
  let server;
  let root;
  let timersAreFaked = false;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url === '/api/runtime/jobs') {
      const request = deferred();
      requests.push(request);
      return request.promise;
    }

    // Keep any incidental component fetch deterministic and local.
    return Promise.resolve({
      ok: true,
      headers: { get: () => '18' },
      text: async () => '{"result":"fixture"}',
    });
  };
  function restoreTimers() {
    if (timersAreFaked) {
      globalThis.setInterval = previousSetInterval;
      globalThis.clearInterval = previousClearInterval;
      timersAreFaked = false;
    }
  }

  try {
    const { createRoot } = await import('react-dom/client');
    const loadedConfig = await loadConfigFromFile(
      { command: 'serve', mode: 'test' },
      path.join(repositoryRoot, 'vite.config.js'),
      repositoryRoot,
      'silent',
    );
    assert.ok(loadedConfig, 'Vite should load the project JSX configuration');
    server = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: loadedConfig.config.esbuild,
      ssr: { noExternal: ['react-router'] },
      plugins: [previewTestStubs],
      server: { middlewareMode: true, watch: null },
      appType: 'custom',
      logLevel: 'silent',
    });
    const { default: PreviewArea } = await server.ssrLoadModule('/src/PreviewArea.jsx');
    globalThis.setInterval = (callback, delay) => {
      const id = nextIntervalId++;
      intervalCallbacks.set(id, { callback, delay });
      return id;
    };
    globalThis.clearInterval = (id) => intervalCallbacks.delete(id);
    timersAreFaked = true;
    const container = dom.window.document.getElementById('root');
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(PreviewArea, {
          section: 'game',
          project: { id: 'project-a', assets: [] },
          onRefresh: async () => {},
          onOpenLibrary: () => {},
        }),
      );
    });
    assert.ok(
      container.textContent.includes('No saved decisions yet'),
      'an empty project renders its empty state without reading dimensions from a missing asset',
    );
    assert.equal(container.querySelector('.iteration-media'), null);

    const asset = {
      id: 'text/decision-current.json',
      category: 'Text',
      name: 'current.json',
      url: '/api/projects/project-a/assets/current.json',
      size: 18,
      rating: null,
    };
    const project = { id: 'project-a', assets: [asset] };
    const currentJob = {
      id: 'current-job',
      projectId: project.id,
      status: 'completed',
      type: 'game',
      output: asset.id,
      request: { prompt: 'Keep this output available.' },
    };

    await act(async () => {
      root.render(
        React.createElement(PreviewArea, {
          section: 'game',
          project,
          onRefresh: async () => {},
          onOpenLibrary: () => {},
        }),
      );
    });
    assert.equal(requests.length, 1, 'mount starts the first jobs request');

    const [pollInterval] = intervalCallbacks.values();
    assert.equal(pollInterval.delay, 5000, 'jobs are polled every five seconds');
    await act(async () => {
      pollInterval.callback();
    });
    assert.equal(
      requests.length,
      2,
      'the interval starts a second request before the first settles',
    );

    await act(async () => {
      requests[1].resolve(jsonResponse({ jobs: [currentJob] }));
      await requests[1].promise;
    });
    assert.ok(
      container.textContent.includes('Rerun / refine'),
      'the newer response exposes the completed job actions',
    );

    await act(async () => {
      requests[0].resolve(jsonResponse({ jobs: [] }));
      await requests[0].promise;
    });
    assert.ok(
      container.textContent.includes('Rerun / refine'),
      'the late stale response cannot erase the newer completed job',
    );
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    restoreTimers();
    if (server) {
      await server.close();
    }
    dom.window.close();
    globalThis.fetch = previousFetch;
    if (previousActEnvironment) {
      Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment);
    } else {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    }
    for (const [key, descriptor] of globalDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
});
