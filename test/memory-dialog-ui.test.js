import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

// A GPU shortfall: the render needs 21 GiB and the estimate says so; the device is measured live.
const gpuConflict = {
  code: 'insufficient_gpu_memory',
  device: { freeMiB: 19968 },
  requiredMiB: 21504,
  shortfallMiB: 1536,
  estimate: 'Estimated for the Qwen Image load.',
  candidates: [{ id: 'images', name: 'Qwen Image Studio', managed: true, busy: false }],
};

async function withMemoryDialog(
  { liveFreeMiB, liveTotalMiB = 24576, closeResponse, conflict = gpuConflict },
  body,
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
    getClientRects: dom.window.HTMLElement.prototype.getClientRects,
    getBoundingClientRect: dom.window.HTMLElement.prototype.getBoundingClientRect,
  };
  const requests = [];
  let vite;
  let root;
  try {
    dom.window.HTMLElement.prototype.getClientRects = () => [{}];
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 500, height: 300 });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET' });
      if (url === '/api/runtime/hardware') {
        return json({
          devices: [{ name: 'RTX test GPU', freeMiB: liveFreeMiB, totalMiB: liveTotalMiB }],
          available: true,
        });
      }
      if (String(url).startsWith('/api/runtime/models/images/close')) {
        return closeResponse;
      }
      return json({}, false, 404);
    };
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/.forge-runtime/**'] } },
    });
    const { default: MemoryDialog } = await vite.ssrLoadModule('/src/MemoryDialog.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);
    const onRetry = () => requests.push({ url: 'retry', method: 'RETRY' });
    await act(async () => {
      root.render(
        React.createElement(MemoryDialog, {
          conflict,
          target: 'Qwen Image',
          onClose: () => {},
          onRetry,
          onOffload: () => {},
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await body({ container, requests });
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.HTMLElement.prototype.getClientRects = previous.getClientRects;
    dom.window.HTMLElement.prototype.getBoundingClientRect = previous.getBoundingClientRect;
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.fetch = previous.fetch;
    if (previous.navigator) {
      Object.defineProperty(globalThis, 'navigator', previous.navigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
  }
}

test('the memory dialog shows live GPU memory, calls the estimate conservative, and reports when the live reading covers it', async () => {
  await withMemoryDialog({ liveFreeMiB: 23552 }, async ({ container }) => {
    const live = container.querySelector('.memory-live').textContent;
    assert.match(live, /Live GPU memory now/);
    assert.match(live, /23\.0 GiB free of 24\.0 GiB/);
    assert.match(container.textContent, /configured estimate, not a measurement/);
    assert.match(container.textContent, /now covers the estimate/);
    const retry = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Retry the render'),
    );
    assert.ok(retry, 'retry says what it does');
    assert.match(container.querySelector('.memory-actions-help').textContent, /Close if idle/);
    assert.match(container.querySelector('.memory-actions-help').textContent, /Force close/);
  });
  await withMemoryDialog({ liveFreeMiB: 19968 }, async ({ container }) => {
    assert.match(container.querySelector('.memory-live').textContent, /still below the estimate/);
  });
});

test('closing a service shows its outcome beside it, success or the reason it failed', async () => {
  await withMemoryDialog({ liveFreeMiB: 19968, closeResponse: json({}) }, async ({ container }) => {
    const closeIfIdle = container.querySelector(
      'button[aria-label="Stop Qwen Image Studio if idle"]',
    );
    await act(async () => closeIfIdle.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const outcome = container.querySelector('.memory-outcome');
    assert.equal(outcome.getAttribute('role'), 'status');
    assert.match(outcome.textContent, /^Stopped\./);
  });
  await withMemoryDialog(
    { liveFreeMiB: 19968, closeResponse: json({ error: 'The service is busy.' }, false, 409) },
    async ({ container }) => {
      const closeIfIdle = container.querySelector(
        'button[aria-label="Stop Qwen Image Studio if idle"]',
      );
      await act(async () => closeIfIdle.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.match(
        container.querySelector('.memory-outcome').textContent,
        /Not stopped: The service is busy/,
      );
      assert.equal(
        container.querySelector('button[aria-label="Stop Qwen Image Studio if idle"]').disabled,
        false,
        'a failed stop can be tried again',
      );
    },
  );
});

test('system-memory conflicts still show the separate 96 GiB GPU and the actual host floor', async () => {
  const GiB = 1024 ** 3;
  await withMemoryDialog(
    {
      liveFreeMiB: 20 * 1024,
      liveTotalMiB: 96 * 1024,
      conflict: {
        code: 'insufficient_host_memory',
        freeBytes: GiB,
        requiredBytes: 2 * GiB,
        shortfallBytes: GiB,
        estimatedBytes: 12 * GiB,
        hostPolicy: 'soft',
        candidates: [],
      },
    },
    async ({ container }) => {
      assert.match(
        container.querySelector('.memory-numbers').textContent,
        /1\.0 GiB.*2\.0 GiB.*1\.0 GiB/,
      );
      assert.match(
        container.querySelector('.memory-live').textContent,
        /20\.0 GiB free of 96\.0 GiB/,
      );
      assert.match(
        container.textContent,
        /system-memory requirement is the configured safety floor/,
      );
      assert.doesNotMatch(
        container.querySelector('.memory-live').textContent,
        /below the estimate/,
      );
    },
  );
});

test('unknown GPU total is described as unavailable, not zero or NaN', async () => {
  await withMemoryDialog({ liveFreeMiB: 20480, liveTotalMiB: null }, async ({ container }) => {
    const text = container.querySelector('.memory-live').textContent;
    assert.match(text, /20\.0 GiB free; total unavailable/);
    assert.doesNotMatch(text, /NaN|of 0\.0 GiB/);
  });
});

test('unknown host values remain unavailable instead of turning into zero GiB', async () => {
  await withMemoryDialog(
    {
      liveFreeMiB: 20 * 1024,
      liveTotalMiB: 96 * 1024,
      conflict: {
        code: 'insufficient_host_memory',
        freeBytes: null,
        requiredBytes: null,
        shortfallBytes: null,
        hostPolicy: 'soft',
        candidates: [],
      },
    },
    async ({ container }) => {
      const amounts = [...container.querySelectorAll('.memory-numbers strong')].map(
        (element) => element.textContent,
      );
      assert.deepEqual(amounts, ['Unavailable', 'Unavailable', 'Unavailable']);
      assert.match(container.querySelector('.memory-live').textContent, /96\.0 GiB/);
    },
  );
});
