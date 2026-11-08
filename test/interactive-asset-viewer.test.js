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

test('interactive preview fills the inspection window and manages keyboard focus', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.inspection-ui-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    getComputedStyle: Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle'),
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
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    dom.window.HTMLElement.prototype.getClientRects = function getClientRects() {
      return this.isConnected ? [{ width: 100, height: 40 }] : [];
    };
    dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return this.isConnected
        ? { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }
        : { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    };

    const sourcePath = path.join(repositoryRoot, 'src', 'InteractiveAssetViewer.jsx');
    const source = await readFile(sourcePath, 'utf8');
    let component = source.replace(/^import .*;\r?\n/gm, '');
    component = component
      .replace(
        "const ModelPreview = React.lazy(() => import('./ModelPreview'));",
        'const ModelPreview = React.lazy(() => Promise.resolve({ default: () => <button type="button">Rotate left</button> }));',
      )
      .replace(
        "const MotionPreview = React.lazy(() => import('./MotionPreview'));",
        'const MotionPreview = React.lazy(() => Promise.resolve({ default: () => <button type="button">Pause motion</button> }));',
      )
      .replace(
        "const PlyAssetPreview = React.lazy(() => import('./PlyAssetPreview'));",
        'const PlyAssetPreview = React.lazy(() => Promise.resolve({ default: () => <button type="button">Zoom in</button> }));',
      );
    const prelude = `
      import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
      import { createPortal } from 'react-dom';
      import { topModal } from '${pathToFileURL(path.join(repositoryRoot, 'src', 'modal-layer.js')).href}';
      const Maximize2 = () => null;
      const Maximize = () => null;
      const Minimize2 = () => null;
      const ChevronLeft = () => null;
      const ChevronRight = () => null;
      const X = () => null;
      const useRouteToggle = () => useState(false);
    `;
    const transformed = await transformWithEsbuild(`${prelude}\n${component}`, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'InteractiveAssetViewer.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: InteractiveAssetViewer } = await import(pathToFileURL(modulePath).href);
    const container = document.querySelector('#root');
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(InteractiveAssetViewer, { url: '/asset.glb', name: 'asset.glb' }),
      );
    });

    const trigger = container.querySelector('.inspection-expand');
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => Promise.resolve());

    const dialog = document.querySelector('.inspection-dialog');
    assert.ok(dialog);
    const close = dialog.querySelector('.inspection-close');
    const previewControl = dialog.querySelector('button:not(.inspection-close)');
    assert.equal(document.activeElement, close);

    await act(async () => {
      close.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }),
      );
    });
    assert.equal(document.activeElement, previewControl);
    await act(async () => {
      previewControl.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    assert.equal(document.activeElement, close);

    const higherModal = document.createElement('div');
    higherModal.className = 'modal-backdrop';
    higherModal.style.zIndex = '2000';
    higherModal.innerHTML = '<section role="dialog" aria-modal="true"></section>';
    document.body.append(higherModal);
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.ok(
      document.querySelector('.inspection-dialog'),
      'a lower modal must not consume Escape',
    );
    higherModal.remove();

    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(document.querySelector('.inspection-dialog'), null);
    assert.equal(document.activeElement, trigger);
    assert.equal(document.body.style.overflow, '');

    const stylesheet = await readFile(
      path.join(repositoryRoot, 'src', 'interactive-asset-viewer.css'),
      'utf8',
    );
    assert.match(
      stylesheet,
      /\.inspection-dialog\s*\{[\s\S]*?width:\s*100%;[\s\S]*?height:\s*100%;/,
    );
    assert.match(stylesheet, /@media \(max-width: 620px\)/);
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
