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
    clipboard: Object.getOwnPropertyDescriptor(dom.window.navigator, 'clipboard'),
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let stream;
  let root;
  let copiedText = '';
  let metadataAvailable = true;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => (copiedText = text) },
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = async () => ({
      ok: metadataAvailable,
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
        services: [
          {
            id: 'images',
            name: 'Qwen Image Studio',
            url: 'http://127.0.0.1:8189',
            reachable: true,
          },
        ],
      }),
    });
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};
    globalThis.EventSource = class {
      constructor(url) {
        assert.equal(url, '/api/logs/stream');
        stream = this;
      }

      addEventListener(type, handler) {
        this[`on${type}`] = handler;
      }

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
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/diagnostics?source=missing-engine'] },
          React.createElement(Diagnostics),
        ),
      );
    });

    assert.ok(stream, 'component should open the log stream');
    const pauseButton = container.querySelector('button.stream-toggle');
    assert.equal(pauseButton.textContent.trim(), 'Pause stream');
    assert.equal(pauseButton.getAttribute('aria-pressed'), 'false');
    await act(async () => {
      stream.onlogs({
        data: JSON.stringify({
          sources: [
            {
              id: 'studio',
              label: 'Forge Studio',
              available: true,
              lines: ['2026-01-01T00:00:00Z INFO Original line'],
            },
            {
              id: 'images',
              label: 'Images · log not configured',
              file: null,
              available: false,
              unavailable: 'Qwen Image Studio does not currently write a dedicated log file.',
              lines: [],
            },
            {
              id: 'music',
              label: 'Music · studio',
              file: 'C:\\long\\agent\\server.log',
              available: true,
              modified: '2026-01-01T00:01:00.000Z',
              lines: ['2026-01-01 00:00:30 source timestamp'],
            },
          ],
        }),
      });
    });
    assert.match(container.textContent, /Log source “missing-engine” is not available/);
    assert.doesNotMatch(container.textContent, /Waiting for logs/);
    await act(async () => {
      container.querySelector('.log-empty-state button').click();
    });
    assert.match(container.textContent, /Original line/);
    assert.match(container.textContent, /Log source unavailable/);
    assert.match(container.textContent, /Qwen Image Studio does not currently write/);
    assert.match(container.textContent, /File modified on server/);
    assert.match(container.textContent, /original timestamps/);
    assert.doesNotMatch(container.textContent, /Images · log not configured.*Offline/i);

    await act(async () => {
      container.querySelector('button.stream-toggle').click();
    });
    assert.equal(
      container.querySelector('button.stream-toggle').textContent.trim(),
      'Resume stream',
    );
    assert.equal(
      container.querySelector('button.stream-toggle').getAttribute('aria-pressed'),
      'true',
    );
    await act(async () => {
      container.querySelectorAll('.link-button')[1].click();
    });
    assert.match(copiedText, /Original line/);
    assert.match(copiedText, /source timestamp/);
    assert.doesNotMatch(copiedText, /Filter log lines/);

    await act(async () => {
      container.querySelector('button.stream-toggle').click();
    });
    assert.equal(
      container.querySelector('button.stream-toggle').textContent.trim(),
      'Pause stream',
    );
    await act(async () => {
      stream.onerror(new dom.window.MessageEvent('error', { data: 'log file unavailable' }));
    });
    assert.equal(
      container.querySelector('[aria-live="polite"]')?.textContent.trim(),
      'Log read failed: log file unavailable',
    );

    await act(async () => {
      stream.onerror(new dom.window.Event('error'));
    });
    assert.equal(
      container.querySelector('[aria-live="polite"]')?.textContent.trim(),
      'Reconnecting',
    );
    metadataAvailable = false;
    await act(async () => {
      container.querySelector('.metadata-panel .icon-btn').click();
    });
    assert.match(container.textContent, /Refresh server details/);
    assert.equal(container.querySelectorAll('.service-row').length, 0);
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
    if (originalGlobals.clipboard) {
      Object.defineProperty(dom.window.navigator, 'clipboard', originalGlobals.clipboard);
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
