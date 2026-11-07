import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('trash confirmation names the action, manages focus, and announces request errors', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.trash-ui-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
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
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    globalThis.fetch = async (url) => {
      if (url.endsWith('/assets/trash')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ trashId: 'trash-1', path: 'images/asset.png', size: 100 }],
            warnings: [],
          }),
        };
      }
      return { ok: false, json: async () => ({ error: 'Trash could not be cleared.' }) };
    };

    const sourcePath = path.join(repositoryRoot, 'src', 'ProjectTrash.jsx');
    const source = await readFile(sourcePath, 'utf8');
    const component = source.replace(/^import .*;\r?\n/gm, '');
    const prelude = `
      import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
      const Trash2 = () => null;
      const useSearchParams = () => [new URLSearchParams(), () => {}];
      const updateSearch = () => {};
      const useRouteToggle = (key) => {
        const [open, setOpen] = useState(key === 'trash');
        return [open, setOpen];
      };
    `;
    const transformed = await transformWithEsbuild(`${prelude}\n${component}`, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'ProjectTrash.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: ProjectTrash } = await import(pathToFileURL(modulePath).href);
    const container = document.querySelector('#root');
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ProjectTrash, { projectId: 'project-1', onChanged: async () => {} }),
      );
    });

    const clearButton = container.querySelector('button.danger-solid');
    assert.ok(clearButton);
    clearButton.focus();
    await act(async () => clearButton.click());

    const dialog = container.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(dialog.getAttribute('aria-modal'), 'false');
    assert.equal(dialog.getAttribute('aria-labelledby'), 'project-trash-confirm-title');
    assert.equal(document.activeElement.textContent, 'Cancel');
    await act(async () => {
      dialog.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(container.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, clearButton);

    await act(async () => clearButton.click());
    await act(async () => container.querySelector('[role="dialog"] button.danger-solid').click());
    assert.equal(
      container.querySelector('[role="alert"]')?.textContent,
      'Trash could not be cleared.',
    );
    assert.equal(container.querySelector('[role="status"]'), null);
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previousGlobals)) {
      const globalKey = key === 'actEnvironment' ? 'IS_REACT_ACT_ENVIRONMENT' : key;
      if (descriptor) {
        Object.defineProperty(globalThis, globalKey, descriptor);
      } else {
        delete globalThis[globalKey];
      }
    }
  }
});
