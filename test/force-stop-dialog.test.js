import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('force-stop dialog explains the risk and keeps in-flight stops open', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
    getClientRects: dom.window.HTMLElement.prototype.getClientRects,
    getBoundingClientRect: dom.window.HTMLElement.prototype.getBoundingClientRect,
  };
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
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        middlewareMode: true,
        hmr: false,
        watch: { ignored: ['**/.forge-runtime/**'] },
      },
    });
    const { default: ForceStopDialog } = await vite.ssrLoadModule('/src/ForceStopDialog.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);
    let closeCalls = 0;
    const onClose = () => {
      closeCalls += 1;
    };
    let forceStopCalls = 0;
    const onForceStop = () => {
      forceStopCalls += 1;
    };
    const renderDialog = (props = {}) =>
      root.render(
        React.createElement(ForceStopDialog, {
          name: 'Mammoth service',
          working: false,
          result: null,
          error: '',
          onClose,
          onForceStop,
          ...props,
        }),
      );

    await act(async () => renderDialog());
    const dialog = container.querySelector('[role="dialog"]');
    assert.equal(document.activeElement.classList.contains('force-stop-cancel'), true);
    assert.match(dialog.textContent, /Try Stop service first/);
    assert.match(dialog.textContent, /Active work may be lost/);
    assert.match(
      dialog.textContent,
      /only a process whose identity and ownership Forge can verify/i,
    );
    assert.equal(dialog.getAttribute('aria-describedby'), 'force-stop-summary force-stop-warning');

    await act(async () => {
      container.querySelector('.force-stop-confirm').click();
    });
    assert.equal(forceStopCalls, 1);

    await act(async () => renderDialog({ working: true }));
    assert.equal(
      container.querySelector('.force-stop-confirm').textContent.includes('Stopping'),
      true,
    );
    assert.equal(container.querySelector('.force-stop-cancel').disabled, true);
    assert.equal(
      container.querySelector('[role="status"]').textContent.includes('verifying'),
      true,
    );
    const escape = new dom.window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      document.dispatchEvent(escape);
      container.querySelector('.force-stop-backdrop').click();
    });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(closeCalls, 0);

    await act(async () =>
      renderDialog({ error: 'The process stopped, but cleanup could not be verified.' }),
    );
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /did not confirm that the service stopped/i,
    );
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Check service status, the render queue, and Diagnostics/,
    );
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /cleanup could not be verified/,
    );

    await act(async () =>
      renderDialog({ result: { interruptedJobId: 'job-1', barrierNeedsReview: true } }),
    );
    assert.equal(container.querySelector('#force-stop-title').textContent, 'Service stopped');
    assert.match(container.textContent, /marked interrupted/i);
    assert.match(container.textContent, /needs review in Models & services/i);
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.HTMLElement.prototype.getClientRects = previousGlobals.getClientRects;
    dom.window.HTMLElement.prototype.getBoundingClientRect = previousGlobals.getBoundingClientRect;
    dom.window.close();
    globalThis.window = previousGlobals.window;
    globalThis.document = previousGlobals.document;
    globalThis.getComputedStyle = previousGlobals.getComputedStyle;
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
  }
});
