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

async function renderWorldStudio(search = '') {
  const fixtureDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.world-studio-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost/world${search}`,
  });
  const globalDescriptors = new Map();
  let root;
  let objectUrlCount = 0;

  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      __worldPost: async () => ({}),
    })) {
      globalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    globalDescriptors.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'));
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ reference: { id: 'reference-id' } }),
    });
    globalDescriptors.set(
      'createObjectURL',
      Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
    );
    globalDescriptors.set(
      'revokeObjectURL',
      Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
    );
    URL.createObjectURL = () => `blob:world-${++objectUrlCount}`;
    URL.revokeObjectURL = () => {};

    const sourcePath = path.join(repositoryRoot, 'src', 'WorldStudio.jsx');
    let source = await readFile(sourcePath, 'utf8');
    source = source
      .replace(
        "import { Clock3, Dices, Globe2, ImagePlus, Layers3, Plus, X } from 'lucide-react';",
        '',
      )
      .replace("import AssetPicker from './AssetPicker';", '')
      .replace("import { IMAGE_EXTENSIONS } from './asset-picker';", '')
      .replace("import PreviewArea from './PreviewArea';", '')
      .replace("import RuntimeQueue, { post } from './RuntimeQueue';", '')
      .replace("import { CreationQueueTiming } from './QueueTiming';", '')
      .replace("import { formatDuration } from './queue-timing';", '')
      .replace("import { updateSearch } from './useNav';", '')
      .replace("import './world-studio.css';", '')
      .replace(
        "import { useCallback, useEffect, useState } from 'react';",
        "import { useCallback, useEffect, useState } from 'react';\n" +
          'const Clock3 = () => null; const Globe2 = () => null; const ImagePlus = () => null;\n' +
          'const Layers3 = () => null; const Plus = () => null; const X = () => null;\n' +
          'const Dices = () => null; const AssetPicker = () => null;\n' +
          'const PreviewArea = () => null; const RuntimeQueue = () => null;\n' +
          'const CreationQueueTiming = () => null;\n' +
          'const IMAGE_EXTENSIONS = [];\n' +
          'const formatDuration = (value) => String(value);\n' +
          'const updateSearch = (setter, changes) => setter((current) => {\n' +
          '  const next = new URLSearchParams(current);\n' +
          '  for (const [key, value] of Object.entries(changes)) {\n' +
          '    if (value == null || value === "") next.delete(key);\n' +
          '    else next.set(key, String(value));\n' +
          '  }\n' +
          '  return next;\n' +
          '});\n' +
          'const post = (...args) => globalThis.__worldPost(...args);',
      );
    const transformed = await transformWithEsbuild(source, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(fixtureDirectory, 'WorldStudio.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: WorldStudio } = await import(pathToFileURL(modulePath).href);
    const container = document.getElementById('root');
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [`/world${search}`] },
          React.createElement(WorldStudio, { project: { id: 'project-id' }, projects: [] }),
        ),
      );
    });

    return { container, dom, fixtureDirectory, globalDescriptors, root };
  } catch (error) {
    if (root) {
      await act(async () => root.unmount());
    }
    restoreGlobals(globalDescriptors);
    dom.window.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
    throw error;
  }
}

function restoreGlobals(descriptors) {
  for (const [key, descriptor] of descriptors) {
    if (descriptor === undefined) {
      delete globalThis[key];
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  for (const key of ['createObjectURL', 'revokeObjectURL']) {
    const descriptor = descriptors.get(key);
    if (descriptor === undefined) {
      delete URL[key];
    } else {
      Object.defineProperty(URL, key, descriptor);
    }
  }
}

async function cleanup(rendered) {
  await act(async () => rendered.root.unmount());
  restoreGlobals(rendered.globalDescriptors);
  rendered.dom.window.close();
  await rm(rendered.fixtureDirectory, { recursive: true, force: true });
}

test('World studio shows validation, enforces the eight-view cap, and guides uncertain submissions', async () => {
  const rendered = await renderWorldStudio();

  try {
    const { container } = rendered;
    const submit = () =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Add world to queue'),
      );

    await act(async () => submit().click());
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || '',
      /Describe the world/,
    );

    const multiViewButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('HY-World 2.0'),
    );
    await act(async () => multiViewButton.click());
    await act(async () => submit().click());
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || '',
      /Choose a reference image/,
    );
    const fileInput = container.querySelector('input[type="file"]');
    const files = Array.from(
      { length: 9 },
      (_, index) =>
        new rendered.dom.window.File([`image-${index}`], `view-${index}.png`, {
          type: 'image/png',
        }),
    );
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: files });
      fileInput.dispatchEvent(new rendered.dom.window.Event('change', { bubbles: true }));
    });
    assert.match(
      container.querySelector('.world-reference-list .helper')?.textContent || '',
      /^8 of 8 selected$/,
    );
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || '',
      /maximum of eight views/,
    );

    rendered.dom.window.confirm = () => false;
    const worldGenButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('WorldGen'),
    );
    await act(async () => worldGenButton.click());
    assert.match(
      container.querySelector('.world-reference-list .helper')?.textContent || '',
      /8 of 8/,
    );

    globalThis.__worldPost = async (url) => {
      if (url === '/api/runtime/jobs') {
        throw new Error('socket closed');
      }
      return {};
    };
    await act(async () => submit().click());
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || '',
      /Check the render queue before submitting again/,
    );
  } finally {
    await cleanup(rendered);
  }
});
