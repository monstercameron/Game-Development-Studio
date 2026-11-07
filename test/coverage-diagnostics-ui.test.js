import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('diagnostics distinguishes log-read errors from EventSource reconnects', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.diagnostics-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const originalGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let stream;
  let root;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        server: {
          url: 'http://127.0.0.1:5173',
          pid: 1,
          projectDirectory: 'test-project',
          nodeVersion: 'test',
          platform: 'win32',
          architecture: 'arm64',
          startedAt: '2026-01-01T00:00:00Z',
        },
        logEndpoints: { snapshot: '/api/logs', stream: '/api/logs/stream' },
        services: [],
      }),
    });
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    globalThis.EventSource = class {
      constructor(url) {
        assert.equal(url, '/api/logs/stream');
        stream = this;
      }

      addEventListener() {}

      close() {}
    };

    const sourcePath = path.join(repositoryRoot, 'src', 'Diagnostics.jsx');
    const source = await readFile(sourcePath, 'utf8');
    const normalizedSource = source
      .replace("from './useNav'", "from '../../src/useNav.js'")
      .replace("from './diagnostics-filter.js'", "from '../../src/diagnostics-filter.js'")
      .replace("import './diagnostics-page.css';", '');
    const transformed = await transformWithEsbuild(
      normalizedSource,
      path.join(temporaryDirectory, 'Diagnostics.jsx'),
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'Diagnostics.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: Diagnostics } = await import(pathToFileURL(modulePath).href);

    const container = document.getElementById('root');
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(MemoryRouter, null, React.createElement(Diagnostics)));
    });

    assert.ok(stream, 'component should open the log stream');
    await act(async () => {
      stream.onerror(new dom.window.MessageEvent('error', { data: 'log file unavailable' }));
    });
    assert.equal(
      container.querySelector('[aria-live="polite"]')?.textContent.trim(),
      'Log read failed',
    );

    await act(async () => {
      stream.onerror(new dom.window.Event('error'));
    });
    assert.equal(
      container.querySelector('[aria-live="polite"]')?.textContent.trim(),
      'Reconnecting',
    );
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    dom.window.close();
    if (originalGlobals.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalGlobals.window;
    }
    if (originalGlobals.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalGlobals.document;
    }
    if (originalGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', originalGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    for (const key of ['EventSource', 'fetch', 'setInterval', 'clearInterval']) {
      if (originalGlobals[key] === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = originalGlobals[key];
      }
    }
    if (originalGlobals.actEnvironment === undefined) {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalGlobals.actEnvironment;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
