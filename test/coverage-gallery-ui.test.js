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

test('gallery preview arrows navigate with buttons and keyboard outside editable controls', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.gallery-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const originalGlobals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    Element: Object.getOwnPropertyDescriptor(globalThis, 'Element'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    IS_REACT_ACT_ENVIRONMENT: Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    ),
  };
  let root;

  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      Element: dom.window.Element,
      localStorage: dom.window.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    const sourcePath = path.join(repositoryRoot, 'src', 'Gallery.jsx');
    const source = await readFile(sourcePath, 'utf8');
    const componentStart = source.indexOf('const categories =');
    const componentEnd = source.indexOf('export default function Gallery');
    assert.ok(componentStart >= 0 && componentEnd > componentStart);

    const prelude = `
      import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
      const useSearchParams = () => [new URLSearchParams(), () => {}];
      const updateSearch = () => {};
      const useRouteToggle = () => [false, () => {}];
      const routeDetails = () => ({});
      const useDialogFocus = () => useRef(null);
      const TextAssetPreview = () => null;
      const InteractiveAssetViewer = () => null;
      const AssetThumbnail = () => null;
      const isVisualAsset = () => false;
      const AssetConverter = () => null;
      const canConvert = () => false;
      const ProjectTrash = () => null;
      const RuntimeQueue = () => null;
      const iconStub = () => null;
      const ArrowDownToLine = iconStub;
      const AudioLines = iconStub;
      const Box = iconStub;
      const ChevronLeft = iconStub;
      const ChevronRight = iconStub;
      const Clapperboard = iconStub;
      const Copy = iconStub;
      const FileOutput = iconStub;
      const FileText = iconStub;
      const FolderOpen = iconStub;
      const Image = iconStub;
      const LayoutGrid = iconStub;
      const List = iconStub;
      const Pencil = iconStub;
      const Plus = iconStub;
      const Search = iconStub;
      const Star = iconStub;
      const Trash2 = iconStub;
      const X = iconStub;
    `;
    const extractedSource = `${prelude}\n${source.slice(componentStart, componentEnd)}\nexport { AssetPreview };`;
    const transformed = await transformWithEsbuild(extractedSource, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'GalleryPreview.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { AssetPreview } = await import(pathToFileURL(modulePath).href);

    const steps = [];
    const container = document.getElementById('root');
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(AssetPreview, {
          asset: {
            id: 'sample-one',
            title: 'A sample note',
            file: 'sample.txt',
            category: 'Text',
            sample: true,
            description: 'Sample description',
          },
          position: 1,
          total: 3,
          onClose: () => {},
          onStep: (step) => steps.push(step),
          project: null,
          onMutate: async () => ({}),
          onConverted: () => {},
        }),
      );
    });

    const previousButton = container.querySelector('button[aria-label="Previous asset"]');
    const nextButton = container.querySelector('button[aria-label="Next asset"]');
    assert.ok(previousButton, 'the modal should expose its previous button');
    assert.ok(nextButton, 'the modal should expose its next button');

    await act(async () => previousButton.click());
    await act(async () => nextButton.click());
    assert.deepEqual(steps, [-1, 1]);

    const dispatchKey = (key, target = window) => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    };
    await act(async () => dispatchKey('ArrowLeft'));
    await act(async () => dispatchKey('ArrowRight'));
    assert.deepEqual(steps, [-1, 1, -1, 1]);

    const editableSelectors = [
      'input',
      'select',
      'textarea',
      '[contenteditable="true"]',
      '[role="slider"]',
      '[role="textbox"]',
    ];
    const dialog = container.querySelector('[role="dialog"]');
    for (const selector of editableSelectors) {
      const element = document.createElement(selector.startsWith('[') ? 'div' : selector);
      if (selector.startsWith('[')) {
        const [attribute, value] = selector.slice(1, -1).split('=');
        element.setAttribute(attribute, value.replaceAll('"', ''));
      }
      dialog.append(element);
      await act(async () => dispatchKey('ArrowRight', element));
      assert.deepEqual(steps, [-1, 1, -1, 1], `${selector} should keep arrow keys local`);
      element.remove();
    }
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    for (const [key, descriptor] of Object.entries(originalGlobals)) {
      if (descriptor === undefined) {
        delete globalThis[key];
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
    dom.window.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
