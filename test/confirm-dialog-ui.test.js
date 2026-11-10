import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// Mounts a component from src/ in jsdom through Vite's SSR loader and runs `body` with helpers.
async function withDom(body) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = {
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
    const { default: ConfirmDialog } = await vite.ssrLoadModule('/src/ConfirmDialog.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);
    const render = async (props = {}) =>
      act(async () => {
        root.render(
          React.createElement(ConfirmDialog, {
            title: 'Mark this render cancelled?',
            confirmLabel: 'Mark cancelled',
            busyLabel: 'Marking cancelled…',
            onConfirm: () => {},
            onClose: () => {},
            children: React.createElement('p', null, 'The engine must be checked first.'),
            ...props,
          }),
        );
      });
    await body({ container, render, dom });
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
    if (previous.navigator) {
      Object.defineProperty(globalThis, 'navigator', previous.navigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
  }
}

test('the confirmation dialog names itself, focuses Cancel and closes on Escape', async () => {
  await withDom(async ({ container, render, dom }) => {
    let closes = 0;
    await render({ onClose: () => (closes += 1) });
    const dialog = container.querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'studio-confirm-title');
    assert.equal(
      container.querySelector('#studio-confirm-title').textContent,
      'Mark this render cancelled?',
    );
    assert.equal(document.activeElement.classList.contains('studio-confirm-cancel'), true);
    assert.match(container.querySelector('#studio-confirm-body').textContent, /must be checked/);

    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    assert.equal(closes, 1, 'Escape closes an idle dialog');
  });
});

test('the engine facts are shown as label and value pairs, with a refresh that is one click', async () => {
  await withDom(async ({ container, render }) => {
    let refreshes = 0;
    await render({
      facts: [
        { label: 'Engine', value: 'Reachable' },
        { label: 'Busy with a render', value: 'No' },
      ],
      onRefreshFacts: () => (refreshes += 1),
    });
    const pairs = [...container.querySelectorAll('.studio-confirm-facts dl > div')].map((row) => [
      row.querySelector('dt').textContent,
      row.querySelector('dd').textContent,
    ]);
    assert.deepEqual(pairs, [
      ['Engine', 'Reachable'],
      ['Busy with a render', 'No'],
    ]);
    const refresh = [...container.querySelectorAll('.studio-confirm-link')][0];
    await act(async () => refresh.click());
    assert.equal(refreshes, 1);
  });
});

test('a failed action stays in the dialog as an alert, and confirm can be pressed again', async () => {
  await withDom(async ({ container, render }) => {
    let confirms = 0;
    await render({
      error: 'The runtime refused: Only queued jobs can be cancelled here.',
      onConfirm: () => (confirms += 1),
    });
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Only queued jobs can be cancelled here/,
    );
    const confirm = container.querySelector('.project-dialog-actions .primary');
    assert.equal(confirm.disabled, false);
    await act(async () => confirm.click());
    assert.equal(confirms, 1);
  });
});

test('while busy nothing can be dismissed, and the progress is announced', async () => {
  await withDom(async ({ container, render, dom }) => {
    let closes = 0;
    await render({ busy: true, onClose: () => (closes += 1) });
    assert.equal(container.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
    assert.equal(container.querySelector('[role="status"]').textContent, 'Marking cancelled…');
    assert.equal(container.querySelector('.studio-confirm-cancel').disabled, true);
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      container.querySelector('.studio-confirm-backdrop').click();
    });
    assert.equal(closes, 0, 'Escape and a backdrop click are ignored while busy');
  });
});

test('a danger confirmation can be disabled, for example when there is nothing to cancel', async () => {
  await withDom(async ({ container, render }) => {
    await render({ tone: 'danger', confirmDisabled: true, confirmLabel: 'Cancel 0 renders' });
    const confirm = container.querySelector('.studio-confirm-danger');
    assert.ok(confirm, 'the danger tone uses its own style');
    assert.equal(confirm.disabled, true);
    assert.equal(confirm.textContent, 'Cancel 0 renders');
  });
});
