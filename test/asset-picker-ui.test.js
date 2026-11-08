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

test('asset picker announces its states and preserves keyboard, filter, and project behavior', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    },
  );
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const originalRects = dom.window.Element.prototype.getClientRects;
  const originalBounds = dom.window.Element.prototype.getBoundingClientRect;
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.asset-picker-ui-'));
  let root;
  let releaseRead;
  let closeCalls = 0;
  const selectedFiles = [];

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.Element.prototype.getClientRects = () => [{ width: 800, height: 600 }];
    dom.window.Element.prototype.getBoundingClientRect = () => ({
      width: 800,
      height: 600,
      top: 0,
      right: 800,
      bottom: 600,
      left: 0,
    });
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseRead = resolve;
      });
    const focusSource = (
      await readFile(path.join(repositoryRoot, 'src', 'useDialogFocus.js'), 'utf8')
    ).replace(
      "from './modal-layer.js'",
      `from '${pathToFileURL(path.join(repositoryRoot, 'src', 'modal-layer.js'))}'`,
    );
    const transformedFocus = await transformWithEsbuild(
      focusSource,
      path.join(temporaryDirectory, 'useDialogFocus.js'),
    );
    const focusModulePath = path.join(temporaryDirectory, 'useDialogFocus.mjs');
    await writeFile(focusModulePath, transformedFocus.code, 'utf8');
    const loggerModulePath = path.join(temporaryDirectory, 'app-log.mjs');
    await writeFile(
      loggerModulePath,
      'export const createLog = () => ({ debug() {}, info() {}, warn() {}, error() {} });\n',
      'utf8',
    );
    const source = await readFile(path.join(repositoryRoot, 'src', 'AssetPicker.jsx'), 'utf8');
    const normalizedSource = source
      .replace(
        "from './asset-picker.js'",
        `from '${pathToFileURL(path.join(repositoryRoot, 'src', 'asset-picker.js'))}'`,
      )
      .replace("from './useDialogFocus'", `from '${pathToFileURL(focusModulePath)}'`)
      .replace("import './asset-picker.css';", '')
      .replace("from './app-log.js'", `from '${pathToFileURL(loggerModulePath)}'`);
    const transformed = await transformWithEsbuild(
      normalizedSource,
      path.join(temporaryDirectory, 'AssetPicker.jsx'),
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'AssetPicker.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: AssetPicker } = await import(pathToFileURL(modulePath).href);
    const container = document.querySelector('#root');
    const opener = document.querySelector('#opener');
    opener.focus();
    root = createRoot(container);
    const projects = [
      {
        id: 'project-one',
        name: 'Project One',
        assets: [
          {
            id: 'references/portrait.png',
            name: 'portrait.png',
            category: 'Images',
            size: 1800,
            url: '/portrait.png',
          },
          {
            id: 'references/landscape.png',
            name: 'landscape.png',
            category: 'Images',
            size: 1800,
            url: '/landscape.png',
          },
          { id: 'audio/voice.wav', name: 'voice.wav', category: 'Audio', size: 400 },
        ],
      },
      {
        id: 'project-two',
        name: 'Project Two',
        assets: [{ id: 'audio/clip.wav', name: 'clip.wav', category: 'Audio', size: 400 }],
      },
    ];
    const render = async () =>
      act(async () => {
        root.render(
          React.createElement(AssetPicker, {
            projects,
            project: projects[0],
            extensions: ['png'],
            maxFiles: 2,
            maxBytes: 5000,
            totalBytes: 3000,
            onSelect: (files) => selectedFiles.push(...files),
            onClose: () => closeCalls++,
          }),
        );
      });

    await render();
    assert.equal(document.activeElement, container.querySelector('.asset-picker-close'));
    assert.equal(container.querySelector('[role="dialog"]').getAttribute('aria-modal'), 'true');
    assert.equal(container.querySelector('[role="status"]').textContent.trim(), '2 files');
    assert.match(container.querySelector('.asset-picker-meta').textContent, /Folder: references/);
    assert.match(container.querySelector('.asset-picker-meta').textContent, /MiB/);

    await act(async () => {
      container.querySelector('select').value = 'project-two';
      container
        .querySelector('select')
        .dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.match(container.textContent, /No compatible files/);
    assert.match(container.textContent, /Add a supported file/);
    assert.equal(container.querySelector('[role="status"]').textContent.trim(), '0 files');

    await act(async () => {
      container.querySelector('select').value = 'project-one';
      container
        .querySelector('select')
        .dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('[aria-label="Select portrait.png"]').click();
    });
    assert.equal(
      container.querySelector('[aria-label="Deselect portrait.png"]').getAttribute('aria-pressed'),
      'true',
    );
    await act(async () => {
      container.querySelector('[aria-label="Select landscape.png"]').click();
    });
    assert.match(container.querySelector('[role="alert"]').textContent, /combined size limit/);

    await act(async () => {
      container.querySelector('[aria-label="Deselect portrait.png"]').click();
    });
    await act(async () => {
      container.querySelector('[aria-label="Select portrait.png"]').click();
    });
    await act(async () => {
      container.querySelector('.asset-picker-footer .primary').click();
    });
    const useButton = container.querySelector('.asset-picker-footer .primary');
    assert.equal(useButton.getAttribute('aria-busy'), 'true');
    assert.equal(useButton.disabled, true);
    assert.match(
      container.querySelector('.asset-picker-sr-status').textContent,
      /Reading selected files/,
    );
    assert.equal(container.querySelector('.asset-picker-close').disabled, true);
    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(closeCalls, 0, 'Escape must not close while a library read is active');

    await act(async () => {
      releaseRead({ ok: false, status: 503 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Could not read portrait.png/,
    );
    assert.equal(
      container.querySelector('.asset-picker-footer .primary').getAttribute('aria-busy'),
      'false',
    );
    assert.equal(selectedFiles.length, 0);

    await act(async () => {
      document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(closeCalls, 1, 'Escape should close when idle');
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    dom.window.close();
    dom.window.Element.prototype.getClientRects = originalRects;
    dom.window.Element.prototype.getBoundingClientRect = originalBounds;
    if (previousGlobals.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousGlobals.window;
    }
    if (previousGlobals.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousGlobals.document;
    }
    if (previousGlobals.getComputedStyle === undefined) {
      delete globalThis.getComputedStyle;
    } else {
      globalThis.getComputedStyle = previousGlobals.getComputedStyle;
    }
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    if (previousGlobals.fetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = previousGlobals.fetch;
    }
    if (previousGlobals.actEnvironment === undefined) {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
