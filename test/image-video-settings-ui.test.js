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

async function renderSettings(section, draft, search = '', props = {}) {
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
    const inputsModule = pathToFileURL(
      path.join(repositoryRoot, 'src', 'imageVideoInputs.js'),
    ).href;
    const preparedSource = source
      .replace("from './useNav'", `from '${navModule}'`)
      .replace("from './imageVideoInputs'", `from '${inputsModule}'`)
      .replace("from './VideoSettings'", "from './VideoSettings.mjs'");
    const transformed = await transformWithEsbuild(preparedSource, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    // The video controls live in their own component next to this one.
    const videoPath = path.join(repositoryRoot, 'src', 'VideoSettings.jsx');
    const optionsModule = pathToFileURL(
      path.join(repositoryRoot, 'runtime', 'video-options.js'),
    ).href;
    const videoSource = (await readFile(videoPath, 'utf8'))
      .replace("from '../runtime/video-options.js'", `from '${optionsModule}'`)
      .replace("from './imageVideoInputs'", `from '${inputsModule}'`);
    const videoTransformed = await transformWithEsbuild(videoSource, videoPath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    await writeFile(
      path.join(temporaryDirectory, 'VideoSettings.mjs'),
      videoTransformed.code,
      'utf8',
    );
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
            ...props,
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
    assert.match(summary.textContent, /Fine-tune video/);
    assert.match(summary.textContent, /Show optional controls/);

    const steps = container.querySelector('#video-steps');
    assert.equal(steps.value, '20', 'the selected supported quality remains visible');
    assert.ok(steps.getAttribute('aria-describedby'));
    assert.match(container.querySelector('.image-video-settings-facts').textContent, /448 × 448/);
    assert.match(
      container.querySelector('.image-video-settings-facts').textContent,
      /24 frames per second.*stereo sound/,
    );
    const seed = container.querySelector('#video-seed');
    assert.equal(seed.getAttribute('placeholder'), 'Random');
    assert.match(seed.getAttribute('aria-describedby'), /video-seed-help/);
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

test('image settings expose transparency and matched size, and say what is unavailable', async () => {
  const rendered = await renderSettings(
    'images',
    {
      options: ['Square · 1:1', 'Balanced'],
      imageTransparent: true,
      imageMatchReference: true,
      imageWidth: '640',
      refs: [{ name: 'a.png' }],
    },
    '?tune=1',
  );
  try {
    const { container } = rendered;
    assert.equal(container.querySelector('#image-transparent').checked, true);
    assert.equal(container.querySelector('#image-match-reference').checked, true);
    const width = container.querySelector('#image-width');
    assert.equal(width.disabled, true, 'the size follows the reference');
    assert.equal(width.value, '');
    assert.equal(container.querySelector('.image-video-settings-override'), null);
    assert.match(container.querySelector('#image-width-help').textContent, /last reference/);
    assert.match(
      container.querySelector('.image-video-settings-facts').textContent,
      /painted mask is not an engine input/,
    );
    assert.equal(
      container.querySelector('#image-target-size').placeholder,
      '1024',
      'a matched size can be built around a different target',
    );
  } finally {
    await cleanup(rendered);
  }

  const orphan = await renderSettings(
    'images',
    { imageMatchReference: true, imageWidth: '4096', refs: [] },
    '?tune=1',
  );
  try {
    assert.match(
      orphan.container.querySelector('#image-match-reference-help + [role="alert"]').textContent,
      /Add a reference image first/,
    );
    assert.equal(orphan.container.querySelector('#image-width').disabled, false);
    assert.match(orphan.container.querySelector('#image-width-error').textContent, /32 to 2752/);
  } finally {
    await cleanup(orphan);
  }
});

test('the closed disclosure names the hidden values that were changed', async () => {
  const rendered = await renderSettings('images', {
    options: ['Square · 1:1', 'Balanced'],
    imageWidth: '640',
    seed: '7',
    imageTransparent: true,
  });
  try {
    const summary = rendered.container.querySelector('summary');
    assert.match(summary.textContent, /changed: size, seed, transparent background/);
  } finally {
    await cleanup(rendered);
  }
});

test('video seed accepts 0 to 2147483647 and ties an error to its field', async () => {
  const rendered = await renderSettings('video', { seed: '2147483648' });
  try {
    const seed = rendered.container.querySelector('#video-seed');
    assert.equal(seed.getAttribute('aria-invalid'), 'true');
    assert.match(seed.getAttribute('aria-describedby'), /video-seed-error/);
    assert.match(
      rendered.container.querySelector('#video-seed-error').textContent,
      /0 to 2147483647/,
    );
    assert.match(rendered.container.querySelector('summary').textContent, /seed/);
  } finally {
    await cleanup(rendered);
  }
  const valid = await renderSettings('video', { seed: '0' }, '?tune=1');
  try {
    assert.equal(valid.container.querySelector('#video-seed').getAttribute('aria-invalid'), null);
    assert.equal(valid.container.querySelector('#video-seed-error'), null);
  } finally {
    await cleanup(valid);
  }
});

test('image settings offer variations, LoRA, KV cache and a sampling schedule', async () => {
  const rendered = await renderSettings(
    'images',
    {
      options: ['Square · 1:1', 'Balanced'],
      imageVariations: 3,
      imageLora: 'pixel-art.safetensors',
      imageLoraScale: '0.8',
      imageKvCache: false,
      imageSigmas: '1, 0.6, 0.2',
    },
    '',
    { loras: [{ name: 'pixel-art.safetensors' }, { name: 'ink.safetensors' }] },
  );
  try {
    const { container } = rendered;
    assert.equal(container.querySelector('#image-variations').value, '3');
    assert.match(container.querySelector('#image-variations-help').textContent, /variation 1 of 3/);
    const lora = container.querySelector('#image-lora');
    assert.equal(lora.value, 'pixel-art.safetensors');
    assert.deepEqual(
      [...lora.options].map((option) => option.value),
      ['', 'pixel-art.safetensors', 'ink.safetensors'],
    );
    assert.equal(container.querySelector('#image-lora-scale').value, '0.8');
    assert.equal(container.querySelector('#image-kv-cache').checked, false);
    assert.equal(container.querySelector('#image-sigmas').value, '1, 0.6, 0.2');
    assert.equal(container.querySelector('#image-steps').disabled, true, 'the schedule sets steps');
    assert.equal(container.querySelector('#image-target-size'), null, 'only with a matched size');
    assert.match(
      container.querySelector('summary').textContent,
      /variations, LoRA, KV cache off, sampling schedule/,
    );
  } finally {
    await cleanup(rendered);
  }
});

test('image settings explain an empty LoRA folder and reject bad schedules and strengths', async () => {
  const empty = await renderSettings('images', { imageLora: 'gone.safetensors' }, '?tune=1');
  try {
    assert.match(empty.container.querySelector('#image-lora-help').textContent, /No LoRA files/);
    assert.match(
      empty.container.querySelector('#image-lora-missing').textContent,
      /not in the LoRA/,
    );
  } finally {
    await cleanup(empty);
  }
  const invalid = await renderSettings(
    'images',
    { imageLora: 'a.safetensors', imageLoraScale: '3', imageSigmas: '0.2, 0.6' },
    '?tune=1',
    { loras: [{ name: 'a.safetensors' }] },
  );
  try {
    const { container } = invalid;
    assert.equal(container.querySelector('#image-lora-scale').getAttribute('aria-invalid'), 'true');
    assert.equal(container.querySelector('#image-sigmas').getAttribute('aria-invalid'), 'true');
    assert.match(container.querySelector('#image-sigmas-error').textContent, /must fall/);
    assert.equal(container.querySelector('#image-steps').disabled, false);
  } finally {
    await cleanup(invalid);
  }
});
