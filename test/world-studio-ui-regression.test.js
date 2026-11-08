import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';

// React reads the DOM once, when it loads, to decide how to listen for typing. Give it a window
// first; every render below then uses its own window.
const bootstrap = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const { default: React } = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function renderWorldStudio(search = '', { handoff, project } = {}) {
  const fixtureDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.world-studio-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost/world${search}`,
  });
  const globalDescriptors = new Map();
  let root;
  let objectUrlCount = 0;
  // Record focus requests; jsdom's focus events trip React's legacy input polyfill.
  const focused = [];
  dom.window.HTMLElement.prototype.focus = function recordFocus() {
    focused.push(this.id);
  };
  if (handoff) {
    dom.window.sessionStorage.setItem('forge-world-reuse', JSON.stringify(handoff));
  }

  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      FormData: dom.window.FormData,
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
        "import { Clock3, Dices, Globe2, ImagePlus, Layers3, Plus, RotateCcw, X } from 'lucide-react';",
        '',
      )
      .replace("import AssetPicker from './AssetPicker';", '')
      .replace("import { IMAGE_EXTENSIONS } from './asset-picker';", '')
      .replace("import PreviewArea from './PreviewArea';", '')
      .replace("import RuntimeQueue, { post } from './RuntimeQueue';", '')
      .replace("import { CreationQueueTiming } from './QueueTiming';", '')
      .replace("import { formatDuration } from './queue-timing';", '')
      .replace("import { reusePlan } from './generation-details';", '')
      .replace("import { routeDetails, updateSearch, useRouteToggle } from './useNav';", '')
      .replace("import './world-studio.css';", '')
      .replace(
        "import { useCallback, useEffect, useRef, useState } from 'react';",
        "import { useCallback, useEffect, useRef, useState } from 'react';\n" +
          'const Clock3 = () => null; const Globe2 = () => null; const ImagePlus = () => null;\n' +
          'const Layers3 = () => null; const Plus = () => null; const RotateCcw = () => null; const X = () => null;\n' +
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
          'const reusePlan = (meta) => (meta && meta.plan) || null;\n' +
          'const useRouteToggle = (key) => {\n' +
          '  const [current, change] = useSearchParams();\n' +
          '  return [current.get(key) === "1", (value) => updateSearch(change, { [key]: value ? "1" : null })];\n' +
          '};\n' +
          'const routeDetails = (open, setOpen) => ({ open, onToggle: (event) => {\n' +
          '  if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);\n' +
          '} });\n' +
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
          React.createElement(WorldStudio, {
            project: project === undefined ? { id: 'project-id' } : project,
            projects: [],
          }),
        ),
      );
    });

    return { container, dom, fixtureDirectory, focused, globalDescriptors, root };
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

const setValue = async (rendered, element, value) =>
  act(async () => {
    const window = rendered.dom.window;
    const prototype =
      element instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : element instanceof window.HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(
      new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });
const queueButton = (container) =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent.includes('Add world to queue'),
  );

test('World studio ties each validation message to its field and moves focus there', async () => {
  const rendered = await renderWorldStudio();
  try {
    const { container } = rendered;
    await act(async () => queueButton(container).click());
    const prompt = container.querySelector('#world-prompt');
    assert.equal(prompt.getAttribute('aria-invalid'), 'true');
    assert.match(prompt.getAttribute('aria-describedby'), /world-prompt-error/);
    assert.match(container.querySelector('#world-prompt-error').textContent, /Describe the world/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(rendered.focused, ['world-prompt']);
    // Labels name the control only; the help text is a description, not part of the name.
    assert.equal(
      container.querySelector('label[for="world-steps"]').textContent,
      'Generation steps',
    );
    assert.equal(container.querySelector('label[for="world-seed"]').textContent, 'Seed');

    await setValue(rendered, prompt, 'A quiet courtyard');
    assert.equal(container.querySelector('#world-prompt-error'), null);
    await setValue(rendered, container.querySelector('#world-steps'), '9');
    await act(async () => queueButton(container).click());
    assert.equal(container.querySelector('#world-steps').getAttribute('aria-invalid'), 'true');
    assert.match(container.querySelector('#world-steps-error').textContent, /10 to 60/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(rendered.focused.at(-1), 'world-steps');
    await setValue(rendered, container.querySelector('#world-steps'), '10');
    await setValue(rendered, container.querySelector('#world-seed'), '2147483648');
    await act(async () => queueButton(container).click());
    assert.match(container.querySelector('#world-seed-error').textContent, /2,147,483,647/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(rendered.focused.at(-1), 'world-seed');
  } finally {
    await cleanup(rendered);
  }
});

test('World studio queues only the options that apply and leaves a blank seed to the server', async () => {
  const rendered = await renderWorldStudio();
  const posted = [];
  try {
    const { container } = rendered;
    globalThis.__worldPost = async (url, body) => {
      if (url === '/api/runtime/jobs') {
        posted.push(body.request);
      }
      return {};
    };
    await setValue(rendered, container.querySelector('#world-prompt'), 'A quiet courtyard');
    await setValue(rendered, container.querySelector('#world-size'), '1024');
    await setValue(rendered, container.querySelector('#world-output'), 'glb');
    assert.match(container.querySelector('#world-size-help').textContent, /524k mesh vertices/);
    await act(async () => queueButton(container).click());
    assert.equal(
      container.querySelector('.world-notice').textContent,
      'World added to the render queue.',
    );
    assert.deepEqual(posted[0], {
      model: 'worldgen',
      mode: 'text',
      prompt: 'A quiet courtyard',
      output: 'glb',
      resolution: 1024,
      references: [],
      seed: null,
      steps: 50,
    });

    // Advanced WorldGen options travel only when they were set.
    assert.ok(container.querySelector('details.world-advanced'));
    await setValue(rendered, container.querySelector('#world-guidance'), '3.5');
    await act(async () => container.querySelector('#world-save-panorama').click());
    await act(async () => queueButton(container).click());
    assert.equal(posted[1].guidance, 3.5);
    assert.equal(posted[1].save_panorama, true);

    // A panorama start paints nothing, so seed, steps and guidance do not exist for it.
    await setValue(rendered, container.querySelector('#world-mode'), 'panorama');
    assert.equal(container.querySelector('#world-steps'), null);
    assert.equal(container.querySelector('#world-seed'), null);
    assert.equal(container.querySelector('details.world-advanced'), null);
  } finally {
    await cleanup(rendered);
  }
});

test('World studio offers HY-World splat controls and sends only changed ones', async () => {
  const rendered = await renderWorldStudio('?model=hy-world&tune=1');
  const posted = [];
  try {
    const { container } = rendered;
    globalThis.__worldPost = async (url, body) => {
      if (url === '/api/runtime/jobs') {
        posted.push(body.request);
      }
      return { reference: { id: 'reference-id' } };
    };
    const sizes = [...container.querySelectorAll('#world-size option')].map((o) => o.value);
    assert.deepEqual(sizes, ['336', '518', '700', '952']);
    assert.equal(container.querySelector('#world-seed'), null);
    assert.equal(container.querySelector('#world-guidance'), null);
    await setValue(rendered, container.querySelector('#world-splat-limit'), '250000');
    await act(async () => container.querySelector('#world-remove-sky').click());
    await setValue(rendered, container.querySelector('#world-confidence'), '60');
    const fileInput = container.querySelector('input[type="file"]');
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [new rendered.dom.window.File(['x'], 'view.png', { type: 'image/png' })],
      });
      fileInput.dispatchEvent(new rendered.dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => queueButton(container).click());
    assert.match(container.querySelector('#world-confidence-error').textContent, /0 to 50/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(rendered.focused.at(-1), 'world-confidence');
    await setValue(rendered, container.querySelector('#world-confidence'), '25');
    await act(async () => queueButton(container).click());
    assert.deepEqual(posted[0], {
      model: 'hy-world',
      mode: 'image',
      prompt: '',
      output: 'splat',
      resolution: 518,
      references: ['reference-id'],
      splat_limit: 250000,
      remove_sky: true,
      confidence_percentile: 25,
    });
  } finally {
    await cleanup(rendered);
  }
});

test('World studio refills its form from the settings of a reused world', async () => {
  const rendered = await renderWorldStudio('?model=worldgen', {
    handoff: {
      model: 'worldgen',
      mode: 'text',
      prompt: 'Frozen harbour at dusk',
      output: 'mesh',
      resolution: 2048,
      seed: 1234,
      steps: 24,
      guidance: 4,
      save_panorama: true,
    },
  });
  try {
    const { container } = rendered;
    assert.equal(container.querySelector('#world-prompt').value, 'Frozen harbour at dusk');
    assert.equal(container.querySelector('#world-output').value, 'mesh');
    assert.equal(container.querySelector('#world-size').value, '2048');
    assert.equal(container.querySelector('#world-seed').value, '1234');
    assert.equal(container.querySelector('#world-steps').value, '24');
    assert.equal(container.querySelector('#world-save-panorama').checked, true);
    assert.equal(
      container.querySelector('.world-notice').textContent,
      'Settings restored from the asset.',
    );
    // The note stays until the creator acts; typing does not wipe it.
    await setValue(rendered, container.querySelector('#world-prompt'), 'Frozen harbour at dawn');
    assert.ok(container.querySelector('.world-notice'));
  } finally {
    await cleanup(rendered);
  }
});

test('HY-World can start from reference views or one panorama, and says how a panorama is used', async () => {
  const rendered = await renderWorldStudio('?model=hy-world&mode=panorama');
  const posted = [];
  try {
    const { container } = rendered;
    globalThis.__worldPost = async (url, body) => {
      if (url === '/api/runtime/jobs') {
        posted.push(body.request);
      }
      return { reference: { id: 'reference-id' } };
    };
    const choices = [...container.querySelectorAll('#world-mode option')].map((o) => o.value);
    assert.deepEqual(choices, ['image', 'panorama']);
    assert.equal(container.querySelector('#world-mode').value, 'panorama');
    assert.equal(container.querySelector('input[type="file"]').multiple, false);
    assert.match(container.querySelector('#world-files-help').textContent, /eight 90° views/);
    assert.match(container.querySelector('#world-size-help').textContent, /eight views cut/);
    const fileInput = container.querySelector('input[type="file"]');
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [
          new rendered.dom.window.File(['a'], 'a.png', { type: 'image/png' }),
          new rendered.dom.window.File(['b'], 'b.png', { type: 'image/png' }),
        ],
      });
      fileInput.dispatchEvent(new rendered.dom.window.Event('change', { bubbles: true }));
    });
    // Only one panorama is kept.
    assert.match(container.querySelector('.world-reference-list .helper').textContent, /^1 of 1/);
    await act(async () => queueButton(container).click());
    assert.equal(posted[0].mode, 'panorama');
    assert.equal(posted[0].model, 'hy-world');
    assert.deepEqual(posted[0].references, ['reference-id']);
  } finally {
    await cleanup(rendered);
  }
});

test('HY-World warns when the chosen views have different shapes', async () => {
  const rendered = await renderWorldStudio('?model=hy-world');
  try {
    const { container } = rendered;
    const fileInput = container.querySelector('input[type="file"]');
    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: ['a', 'b'].map(
          (name) => new rendered.dom.window.File([name], `${name}.png`, { type: 'image/png' }),
        ),
      });
      fileInput.dispatchEvent(new rendered.dom.window.Event('change', { bubbles: true }));
    });
    const loadAs = async (image, width, height) =>
      act(async () => {
        Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
        Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
        image.dispatchEvent(new rendered.dom.window.Event('load'));
      });
    const images = [...container.querySelectorAll('.world-reference img')];
    assert.equal(images.length, 2);
    await loadAs(images[0], 800, 1312);
    await loadAs(images[1], 800, 1300);
    assert.equal(container.querySelector('#world-shapes-note'), null);
    await loadAs(images[1], 1000, 500);
    assert.match(container.querySelector('#world-shapes-note').textContent, /crops/);
    await loadAs(images[1], 400, 656);
    assert.equal(container.querySelector('#world-shapes-note'), null);
  } finally {
    await cleanup(rendered);
  }
});

test('World studio explains a missing project once and does not blame the fields', async () => {
  const rendered = await renderWorldStudio('', { project: null });
  try {
    const { container } = rendered;
    assert.match(container.querySelector('.world-project-note').textContent, /Choose a project/);
    assert.match(container.querySelector('.world-submit strong').textContent, /Select a project/);
    await act(async () => queueButton(container).click());
    assert.equal(
      container.querySelector('[role="alert"]').textContent,
      'Choose or create a project first.',
    );
    assert.equal(container.querySelector('#world-prompt').getAttribute('aria-invalid'), null);
    assert.equal(container.querySelector('#world-prompt-error'), null);
  } finally {
    await cleanup(rendered);
  }
});

test('Reset to defaults asks first, closes with Escape, and returns focus', async () => {
  const rendered = await renderWorldStudio();
  try {
    const { container } = rendered;
    const reset = () => container.querySelector('#world-reset');
    assert.equal(reset().disabled, true);
    await setValue(rendered, container.querySelector('#world-prompt'), 'A snowy pass');
    await setValue(rendered, container.querySelector('#world-seed'), '5');
    assert.equal(reset().disabled, false);
    await act(async () => reset().click());
    assert.match(container.querySelector('.reset-confirm').textContent, /Discard/);
    await act(async () =>
      container
        .querySelector('.reset-confirm')
        .dispatchEvent(
          new rendered.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(container.querySelector('.reset-confirm'), null);
    assert.equal(rendered.focused.at(-1), 'world-reset');
    assert.equal(container.querySelector('#world-prompt').value, 'A snowy pass');

    await act(async () => reset().click());
    const yes = [...container.querySelectorAll('.reset-confirm button')].find((button) =>
      button.textContent.includes('Yes'),
    );
    await act(async () => yes.click());
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(container.querySelector('#world-prompt').value, '');
    assert.equal(container.querySelector('#world-seed').value, '');
    assert.equal(reset().disabled, true);
    assert.equal(rendered.focused.at(-1), 'world-mode');
  } finally {
    await cleanup(rendered);
  }
});
