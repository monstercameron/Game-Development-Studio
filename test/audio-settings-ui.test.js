import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('audio numeric settings expose their help text to assistive technology', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.audio-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/music?tune=1',
  });
  const globals = Object.fromEntries(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  let root;

  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    const sourcePath = path.join(repositoryRoot, 'src', 'AudioSettings.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      "import './audio-settings.css';",
      '',
    );
    const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
    const transformed = await transformWithEsbuild(
      source.replace("from './useNav'", `from '${navModule}'`),
      sourcePath,
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'AudioSettings.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: AudioSettings } = await import(pathToFileURL(modulePath).href);

    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/music?tune=1'] },
          React.createElement(AudioSettings, {
            section: 'music',
            draft: {},
            update: () => {},
          }),
        ),
      );
    });

    const input = document.querySelector('#musicDuration');
    assert.equal(input.getAttribute('aria-describedby'), 'musicDuration-help');
    assert.match(
      document.querySelector('#musicDuration-help').textContent,
      /model may finish earlier/,
    );
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    for (const [key, descriptor] of Object.entries(globals)) {
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
