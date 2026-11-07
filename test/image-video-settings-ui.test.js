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

async function renderSettings(section, draft, search = '') {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.image-video-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost/${section}${search}`,
  });
  const globals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
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
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    const sourcePath = path.join(repositoryRoot, 'src', 'ImageVideoSettings.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      "import './image-video-settings.css';",
      '',
    );
    const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
    const preparedSource = source.replace("from './useNav'", `from '${navModule}'`);
    const transformed = await transformWithEsbuild(preparedSource, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'ImageVideoSettings.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: ImageVideoSettings } = await import(pathToFileURL(modulePath).href);

    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [`/${section}${search}`] },
          React.createElement(ImageVideoSettings, {
            section,
            draft,
            update: () => {},
          }),
        ),
      );
    });

    return {
      container: document.getElementById('root'),
      dom,
      globals,
      root,
      temporaryDirectory,
    };
  } catch (error) {
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
    throw error;
  }
}

async function cleanup(rendered) {
  await act(async () => rendered.root.unmount());
  for (const [key, descriptor] of Object.entries(rendered.globals)) {
    if (descriptor === undefined) {
      delete globalThis[key];
    } else {
      Object.defineProperty(globalThis, key, descriptor);
    }
  }
  rendered.dom.window.close();
  await rm(rendered.temporaryDirectory, { recursive: true, force: true });
}

test('image settings identify optional controls and explain preset overrides', async () => {
  const rendered = await renderSettings(
    'images',
    { options: ['Portrait · 9:16', 'Draft'], imageWidth: '640' },
    '?tune=1',
  );

  try {
    const { container } = rendered;
    const disclosure = container.querySelector('details');
    const summary = disclosure.querySelector('summary');
    assert.equal(disclosure.open, true, 'the tune query keeps the disclosure open');
    assert.equal(summary.getAttribute('aria-expanded'), 'true');
    assert.match(summary.textContent, /Fine-tune image/);
    assert.match(summary.textContent, /Hide optional controls/);

    const width = container.querySelector('#image-width');
    assert.equal(width.value, '640', 'custom values remain visible');
    assert.equal(width.placeholder, '576', 'the selected aspect ratio remains the fallback');
    assert.match(container.querySelector('#image-width-help').textContent, /multiples of 32/);
    assert.match(container.querySelector('#image-height-help').textContent, /uses 1024 px/);
    assert.match(container.querySelector('#image-steps-help').textContent, /blank uses 12/);
    assert.match(
      container.querySelector('#image-negative-prompt-help').textContent,
      /guidance control appears below when you enter text/,
    );
    assert.match(container.querySelector('.image-video-optional').textContent, /Optional/);
    assert.equal(container.querySelector('#image-guidance'), null);
  } finally {
    await cleanup(rendered);
  }
});

test('video settings keep the supported quality value and explain its render context', async () => {
  const rendered = await renderSettings('video', {
    options: ['Square · 1:1', 'About 7 seconds'],
    videoSteps: 20,
  });

  try {
    const { container } = rendered;
    const disclosure = container.querySelector('details');
    const summary = disclosure.querySelector('summary');
    assert.equal(disclosure.open, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.match(summary.textContent, /Video quality/);
    assert.match(summary.textContent, /Show optional controls/);

    const steps = container.querySelector('#video-steps');
    assert.equal(steps.value, '20', 'the selected supported quality remains visible');
    assert.ok(steps.getAttribute('aria-describedby'));
    assert.match(container.querySelector('.image-video-settings-facts').textContent, /448 × 448/);
    assert.match(
      container.querySelector('.image-video-settings-facts').textContent,
      /24 frames per second/,
    );
  } finally {
    await cleanup(rendered);
  }
});

test('negative prompt guidance accepts supported decimal values', async () => {
  const rendered = await renderSettings('images', {
    options: ['Square · 1:1', 'Balanced'],
    imageNegativePrompt: 'blur',
    imageGuidance: '2.5',
  });
  try {
    const guidance = rendered.container.querySelector('#image-guidance');
    assert.equal(guidance.value, '2.5');
    assert.notEqual(guidance.getAttribute('aria-invalid'), 'true');
  } finally {
    await cleanup(rendered);
  }
});

test('invalid image size is associated with its explanatory error', async () => {
  const rendered = await renderSettings('images', { imageWidth: '35' });
  try {
    const width = rendered.container.querySelector('#image-width');
    assert.equal(width.getAttribute('aria-invalid'), 'true');
    assert.match(width.getAttribute('aria-describedby'), /image-width-error/);
    assert.match(
      rendered.container.querySelector('#image-width-error').textContent,
      /multiples of 32/,
    );
  } finally {
    await cleanup(rendered);
  }
});
