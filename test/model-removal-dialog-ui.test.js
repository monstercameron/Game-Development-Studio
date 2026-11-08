import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('model removal dialog explains storage recovery and unavailable scan state', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.model-remove-ui-'));
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    },
  );
  const previousGlobals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    getComputedStyle: Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    actEnvironment: Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  let root;

  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: dom.window.document,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: dom.window.getComputedStyle.bind(dom.window),
    });
    dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 1, height: 1 }];
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1, height: 1 });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    const sourcePath = path.join(repositoryRoot, 'src', 'ModelRemovalDialog.jsx');
    const source = await readFile(sourcePath, 'utf8');
    const component = source.replace(/^import .*;\r?\n/gm, '');
    const focusHookUrl = pathToFileURL(path.join(repositoryRoot, 'src', 'useDialogFocus.js')).href;
    const prelude = `
      import React, { useEffect, useId, useRef, useState } from 'react';
      import useDialogFocus from '${focusHookUrl}';
      const LoaderCircle = () => null;
      const Power = () => null;
      const ShieldCheck = () => null;
      const Trash2 = () => null;
      const X = () => null;
    `;
    const transformed = await transformWithEsbuild(`${prelude}\n${component}`, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'ModelRemovalDialog.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: ModelRemovalDialog } = await import(pathToFileURL(modulePath).href);
    const container = document.querySelector('#root');
    root = createRoot(container);
    const opener = document.querySelector('#opener');
    opener.focus();
    assert.equal(document.activeElement, opener);
    const props = {
      model: { name: 'Forge model', category: 'Image', tone: 'image', icon: () => null },
      id: 'forge-model',
      storage: { path: 'C:\\models\\ForgeModel', installed: true, bytes: 8 * 1024 ** 3 },
      service: { status: 'unavailable', managed: false },
      removal: null,
      inventoryState: 'scanning',
      onClose: () => {},
      onRefresh: async () => {},
    };

    await act(async () => root.render(React.createElement(ModelRemovalDialog, props)));

    const dialog = container.querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-labelledby'), dialog.querySelector('h2').id);
    assert.equal(document.activeElement, dialog.querySelector('.icon-btn'));
    assert.match(dialog.textContent, /hard links/i);
    assert.match(dialog.textContent, /8\.0 GiB/);
    assert.match(dialog.textContent, /C:\\models\\ForgeModel/);
    assert.match(dialog.textContent, /Checking model storage/);
    assert.match(
      dialog.querySelector('button.danger-solid').textContent,
      /Permanently delete model/,
    );
    assert.equal(dialog.querySelector('button.danger-solid').disabled, true);

    await act(async () =>
      root.render(React.createElement(ModelRemovalDialog, { ...props, inventoryState: 'ready' })),
    );
    assert.equal(
      container.querySelector('button.danger-solid').disabled,
      true,
      'deleting stays disabled until the confirmation box is ticked',
    );
    await act(async () => container.querySelector('.model-remove-ack input').click());
    assert.equal(container.querySelector('button.danger-solid').disabled, false);

    let resolveRemoval;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/runtime/models/forge-model/remove');
      assert.equal(JSON.parse(options.body).confirmation, 'permanently-delete-model');
      return new Promise((resolve) => {
        resolveRemoval = resolve;
      });
    };
    await act(async () => container.querySelector('button.danger-solid').click());
    assert.equal(
      container.querySelector('[role="status"]')?.textContent,
      'Starting model removal.',
    );
    assert.equal(container.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
    assert.equal(container.querySelector('button.danger-solid').disabled, true);
    await act(async () => {
      resolveRemoval({ ok: true, json: async () => ({ state: 'prepared' }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(container.querySelector('[role="status"]'), null);
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previousGlobals)) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
});
