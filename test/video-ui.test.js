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
const url = (...parts) => pathToFileURL(path.join(repositoryRoot, ...parts)).href;

// Compiles one source component into a temporary module with its imports pointed at real files
// (or stand-ins), then renders it in jsdom.
async function render(file, props, { replacements = {}, extra = {} } = {}) {
  const directory = await mkdtemp(path.join(repositoryRoot, 'test', '.video-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/video',
  });
  const saved = {};
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    File: dom.window.File,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  for (const [name, code] of Object.entries(extra)) {
    await writeFile(path.join(directory, name), code, 'utf8');
  }
  const sourcePath = path.join(repositoryRoot, 'src', file);
  let source = await readFile(sourcePath, 'utf8');
  source = source.replace(/import '\.\/[\w-]+\.css';\r?\n/g, '');
  for (const [from, to] of Object.entries(replacements)) {
    source = source.replaceAll(`from '${from}'`, `from '${to}'`);
  }
  const { code } = await transformWithEsbuild(source, sourcePath, {
    loader: 'jsx',
    jsx: 'automatic',
  });
  const modulePath = path.join(directory, file.replace(/\.jsx$/, '.mjs'));
  await writeFile(modulePath, code, 'utf8');
  const { default: Component } = await import(pathToFileURL(modulePath).href);
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Component, props)));
  return {
    container: document.getElementById('root'),
    window: dom.window,
    async rerender(next) {
      await act(async () => root.render(React.createElement(Component, next)));
    },
    async cleanup() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor === undefined) {
          delete globalThis[key];
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
      dom.window.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const mediaReplacements = {
  './AssetPicker': './AssetPicker.mjs',
  './asset-picker.js': url('src', 'asset-picker.js'),
  './video-media-store': url('src', 'video-media-store.js'),
  '../runtime/video-options.js': url('runtime', 'video-options.js'),
  './imageVideoInputs': url('src', 'imageVideoInputs.js'),
};
// The real picker reads files over HTTP; this one hands back whatever the test set up.
const pickerStub = `import React from 'react';
export default function AssetPicker({ title, extensions, maxFiles, onSelect, onClose }) {
  return React.createElement('div', { role: 'dialog', 'aria-label': title, 'data-extensions': extensions.join(','), 'data-max': String(maxFiles) },
    React.createElement('button', { type: 'button', id: 'pick', onClick: () => onSelect(globalThis.__picked) }, 'Use'),
    React.createElement('button', { type: 'button', id: 'close', onClick: onClose }, 'Close'));
}
`;
const mediaOptions = { replacements: mediaReplacements, extra: { 'AssetPicker.mjs': pickerStub } };
const click = (window, element) =>
  act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const library = (window, name, pathName, size = 1000) => {
  const file = new window.File(['x'], name, { type: '' });
  Object.defineProperty(file, 'size', { value: size });
  file.forgeSource = { projectId: 'p', path: pathName };
  return file;
};

test('the start-from choice offers references, first and last frame, and text only', async () => {
  const changes = [];
  const view = await render(
    'VideoMediaInputs.jsx',
    {
      draft: { options: [] },
      update: (change) => changes.push(change),
      projects: [],
      part: 'source',
    },
    mediaOptions,
  );
  try {
    const radios = [...view.container.querySelectorAll('input[type="radio"]')];
    assert.deepEqual(
      radios.map((radio) => radio.value),
      ['references', 'frames', 'text'],
    );
    assert.equal(radios[0].checked, true);
    assert.match(view.container.textContent, /First and last frame/);
    assert.match(view.container.textContent, /cannot be combined with reference images/);
    // Only the choice is shown here; the details sit under the reference uploader.
    assert.equal(view.container.querySelector('.video-frame-slot'), null);
    await click(view.window, radios[1]);
    assert.deepEqual(changes, [{ videoSource: 'frames' }]);
  } finally {
    await view.cleanup();
  }
});

test('first and last frame slots accept images, reject other files and can be removed', async () => {
  const store = await import('../src/video-media-store.js');
  store.clearVideoFrames();
  const changes = [];
  const draft = { options: [], videoSource: 'frames' };
  const props = {
    draft,
    update: (change) => changes.push(change),
    projects: [],
    project: { id: 'p', assets: [] },
    part: 'details',
  };
  const view = await render('VideoMediaInputs.jsx', props, mediaOptions);
  try {
    const slots = [...view.container.querySelectorAll('.video-frame-slot')];
    assert.equal(slots.length, 2);
    assert.match(slots[0].textContent, /First frame\s*REQUIRED/);
    assert.match(slots[1].textContent, /Last frame\s*OPTIONAL/);
    assert.equal(view.container.querySelector('[data-kind="video"]'), null);
    const input = slots[0].querySelector('input[type="file"]');
    const bad = new view.window.File(['x'], 'notes.txt', { type: 'text/plain' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [bad], configurable: true });
      input.dispatchEvent(new view.window.Event('change', { bubbles: true }));
    });
    assert.match(slots[0].querySelector('[role="alert"]').textContent, /PNG, JPEG or WebP/);
    assert.equal(store.getVideoFrames().first, null);
    const good = new view.window.File(['png'], 'start.png', { type: 'image/png' });
    await act(async () => {
      Object.defineProperty(input, 'files', { value: [good], configurable: true });
      input.dispatchEvent(new view.window.Event('change', { bubbles: true }));
    });
    assert.equal(store.getVideoFrames().first.name, 'start.png');
    assert.deepEqual(changes.at(-1), { videoFirstFrame: { name: 'start.png', size: 3 } });
    // With a descriptor but no file (a saved draft) the page asks for the file again.
    await view.rerender({
      ...props,
      draft: {
        ...draft,
        videoFirstFrame: { name: 'start.png', size: 3 },
        videoLastFrame: { name: 'end.png', size: 3 },
      },
    });
    assert.match(view.container.textContent, /end\.png is listed from a saved draft/);
    const remove = view.container.querySelector('button[aria-label="Remove start.png"]');
    await click(view.window, remove);
    assert.equal(store.getVideoFrames().first, null);
    assert.deepEqual(changes.at(-1), { videoFirstFrame: null });
  } finally {
    await view.cleanup();
    store.clearVideoFrames();
  }
});

test('the frame picker takes one library image and fills the slot', async () => {
  const store = await import('../src/video-media-store.js');
  store.clearVideoFrames();
  const changes = [];
  const view = await render(
    'VideoMediaInputs.jsx',
    {
      draft: { options: [], videoSource: 'frames' },
      update: (change) => changes.push(change),
      projects: [{ id: 'p' }],
      project: { id: 'p', assets: [] },
      part: 'details',
    },
    mediaOptions,
  );
  try {
    const buttons = [...view.container.querySelectorAll('.asset-library-button')];
    assert.equal(buttons.length, 2);
    await click(view.window, buttons[1]);
    const dialog = view.container.querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-label'), 'Choose the last frame');
    assert.equal(dialog.dataset.max, '1');
    assert.match(dialog.dataset.extensions, /png/);
    globalThis.__picked = [library(view.window, 'end.png', 'images/end.png')];
    await click(view.window, view.container.querySelector('#pick'));
    assert.equal(store.getVideoFrames().last.name, 'end.png');
    assert.deepEqual(changes.at(-1), { videoLastFrame: { name: 'end.png', size: 1000 } });
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
  } finally {
    delete globalThis.__picked;
    await view.cleanup();
    store.clearVideoFrames();
  }
});

test('reference videos and audio are picked from the library, limited to three, and removable', async () => {
  const changes = [];
  const base = {
    update: (change) => changes.push(change),
    projects: [{ id: 'p' }],
    project: { id: 'p', assets: [] },
    part: 'details',
  };
  const view = await render(
    'VideoMediaInputs.jsx',
    { ...base, draft: { options: [] } },
    mediaOptions,
  );
  try {
    assert.equal(view.container.querySelector('.video-frame-slot'), null);
    assert.equal(view.container.querySelector('input[type="checkbox"]'), null);
    const [videoButton, audioButton] = view.container.querySelectorAll('.asset-library-button');
    await click(view.window, videoButton);
    const video = view.container.querySelector('[role="dialog"]');
    assert.match(video.dataset.extensions, /webm,mp4/);
    assert.equal(video.dataset.max, '3');
    globalThis.__picked = [library(view.window, 'walk.webm', 'video/walk.webm', 5000)];
    await click(view.window, view.container.querySelector('#pick'));
    assert.deepEqual(changes.at(-1), {
      videoClips: [{ name: 'walk.webm', path: 'video/walk.webm', size: 5000 }],
    });
    await click(view.window, audioButton);
    assert.match(view.container.querySelector('[role="dialog"]').dataset.extensions, /wav/);
    globalThis.__picked = [library(view.window, 'voice.wav', 'voices/voice.wav')];
    await click(view.window, view.container.querySelector('#pick'));
    assert.deepEqual(changes.at(-1), {
      videoAudios: [{ name: 'voice.wav', path: 'voices/voice.wav', size: 1000 }],
    });
    // Once clips are chosen the page explains the tags and offers the clip sound.
    const clips = [
      { name: 'a.webm', path: 'video/a.webm', size: 1 },
      { name: 'b.webm', path: 'video/b.webm', size: 2 },
      { name: 'c.webm', path: 'video/c.webm', size: 3 },
    ];
    await view.rerender({ ...base, draft: { options: [], videoClips: clips, videoAudios: [] } });
    assert.match(view.container.textContent, /<Video 1> a\.webm/);
    assert.match(view.container.textContent, /<Video 3> c\.webm/);
    assert.match(view.container.textContent, /first 3 seconds of a video/);
    assert.equal(view.container.querySelectorAll('.asset-library-button')[0].disabled, true);
    const sound = view.container.querySelector('input[type="checkbox"]');
    await click(view.window, sound);
    assert.deepEqual(changes.at(-1), { videoClipAudio: true });
    await click(view.window, view.container.querySelector('button[aria-label="Remove b.webm"]'));
    assert.deepEqual(
      changes.at(-1).videoClips.map((item) => item.name),
      ['a.webm', 'c.webm'],
    );
    // Removing the last video also drops the clip-sound choice.
    await view.rerender({
      ...base,
      draft: { options: [], videoClips: [clips[0]], videoClipAudio: true },
    });
    await click(view.window, view.container.querySelector('button[aria-label="Remove a.webm"]'));
    assert.deepEqual(changes.at(-1), { videoClips: [], videoClipAudio: false });
  } finally {
    delete globalThis.__picked;
    await view.cleanup();
  }
});

test('memory warnings appear for large pictures, long clips, guidance and reference clips', async () => {
  const props = {
    update: () => {},
    projects: [],
    project: { id: 'p', assets: [] },
    part: 'details',
  };
  const view = await render(
    'VideoMediaInputs.jsx',
    {
      ...props,
      draft: { options: ['Landscape · 16:9', 'About 5 seconds'] },
    },
    mediaOptions,
  );
  try {
    assert.equal(view.container.querySelector('.video-media-warnings'), null);
    await view.rerender({
      ...props,
      draft: {
        options: ['Landscape · 16:9', 'About 15 seconds'],
        videoResolution: 'hd',
        videoNegative: 'blurry',
        videoClips: [{ name: 'a.webm', path: 'video/a.webm', size: 1 }],
      },
    });
    const text = view.container.querySelector('.video-media-warnings').textContent;
    assert.match(text, /five times/);
    assert.match(text, /longer than 10 seconds/);
    assert.match(text, /twice/);
    assert.match(text, /Reference clips/);
  } finally {
    await view.cleanup();
  }
});

const settingsReplacements = {
  '../runtime/video-options.js': url('runtime', 'video-options.js'),
  './imageVideoInputs': url('src', 'imageVideoInputs.js'),
};
const settings = (draft, update = () => {}) =>
  render(
    'VideoSettings.jsx',
    { draft, update, contentId: 'video-settings' },
    {
      replacements: settingsReplacements,
    },
  );
const change = (window, element, value) =>
  act(async () => {
    const proto = element.tagName === 'SELECT' ? window.HTMLSelectElement : window.HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(element, value);
    element.dispatchEvent(
      new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });

test('video settings list the picture sizes of the chosen aspect and warn about large ones', async () => {
  const updates = [];
  const view = await settings(
    { options: ['Cinema · 21:9', 'About 5 seconds'], videoResolution: 'large' },
    (change) => updates.push(change),
  );
  try {
    const select = view.container.querySelector('#video-resolution');
    assert.deepEqual(
      [...select.options].map((option) => option.textContent),
      ['Standard · 672 × 288', 'Medium · 896 × 384', 'Large · 1120 × 480', '768p · 1568 × 672'],
    );
    assert.equal(select.value, 'large');
    assert.match(
      view.container.querySelector('.image-video-settings-warning').textContent,
      /Larger pictures/,
    );
    assert.match(
      view.container.querySelector('.image-video-settings-facts').textContent,
      /1120 × 480 pixels/,
    );
    await change(view.window, select, 'hd');
    assert.deepEqual(updates.at(-1), { videoResolution: 'hd' });
  } finally {
    await view.cleanup();
  }
});

test('the turbo adapter switches the step list and turns guidance off', async () => {
  const updates = [];
  const view = await settings(
    { options: [], videoTurbo: true, videoSteps: 4, videoNegative: 'x' },
    (c) => updates.push(c),
  );
  try {
    assert.deepEqual(
      [...view.container.querySelector('#video-steps').options].map((option) => option.value),
      ['4', '8'],
    );
    assert.equal(view.container.querySelector('#video-negative').disabled, true);
    assert.equal(view.container.querySelector('#video-cfg').disabled, true);
    assert.match(view.container.querySelector('#video-negative-help').textContent, /Not available/);
    const toggle = view.container.querySelector('#video-turbo');
    assert.equal(toggle.checked, true);
    await click(view.window, toggle);
    assert.deepEqual(updates.at(-1), { videoTurbo: false, videoSteps: 12 });
  } finally {
    await view.cleanup();
  }
  const plain = await settings({ options: [] });
  try {
    assert.deepEqual(
      [...plain.container.querySelector('#video-steps').options].map((option) => option.value),
      ['8', '12', '20', '30'],
    );
    await click(plain.window, plain.container.querySelector('#video-turbo'));
  } finally {
    await plain.cleanup();
  }
});

test('experimental controls are labelled, validated and passed through', async () => {
  const updates = [];
  const view = await settings(
    { options: [], videoCfg: '9', videoMaxVram: '30', videoSampler: 'res_multistep' },
    (c) => updates.push(c),
  );
  try {
    const advanced = view.container.querySelector('.image-video-settings-advanced');
    assert.match(advanced.textContent, /have not been tuned for this model/);
    assert.match(view.container.querySelector('#video-cfg-error').textContent, /1\.1 to 6/);
    assert.match(view.container.querySelector('#video-max-vram-error').textContent, /4 to 24/);
    assert.equal(view.container.querySelector('#video-cfg').getAttribute('aria-invalid'), 'true');
    assert.equal(view.container.querySelector('#video-sampler').value, 'res_multistep');
    assert.deepEqual(
      [...view.container.querySelector('#video-scheduler').options].map((option) => option.value),
      ['', 'simple', 'beta', 'discrete'],
    );
    assert.deepEqual(
      [...view.container.querySelector('#video-ref-detail').options].map((option) => option.value),
      ['', 'match', 'max'],
    );
    await change(view.window, view.container.querySelector('#video-scheduler'), 'beta');
    assert.deepEqual(updates.at(-1), { videoScheduler: 'beta' });
    await click(view.window, view.container.querySelector('#video-also-mp4'));
    assert.deepEqual(updates.at(-1), { videoAlsoMp4: true });
    assert.match(view.container.querySelector('#video-also-mp4-help').textContent, /AAC sound/);
  } finally {
    await view.cleanup();
  }
});

test('the closed disclosure names the new video settings that were changed', async () => {
  const { videoChangedLabels } = await import('../src/imageVideoInputs.js');
  assert.deepEqual(videoChangedLabels({ options: [] }), []);
  assert.deepEqual(
    videoChangedLabels({
      options: [],
      videoResolution: 'large',
      videoTurbo: true,
      seed: '5',
      videoNegative: 'blurry',
      videoSampler: 'euler',
      videoMaxVram: '12',
      videoRefDetail: 'max',
      videoAlsoMp4: true,
    }),
    [
      'size',
      'turbo adapter',
      'seed',
      'guidance',
      'sampler',
      'GPU memory',
      'reference detail',
      'MP4 copy',
    ],
  );
  assert.deepEqual(videoChangedLabels({ options: [], videoSteps: 20 }), ['steps']);
});

test('the converter offers MP4 and GIF for videos only', async () => {
  const view = await render(
    'AssetConverter.jsx',
    {
      asset: { id: 'video/forge-1.webm', category: 'Video' },
      project: { id: 'p' },
      onSaved: () => {},
      onClose: () => {},
    },
    {},
  );
  try {
    assert.deepEqual(
      [...view.container.querySelectorAll('select option')].map((option) => option.value),
      ['mp4', 'gif'],
    );
    assert.match(view.container.querySelector('.converter-note').textContent, /H\.264 \+ AAC MP4/);
    assert.match(view.container.textContent, /MP4 quality/);
    assert.equal(view.container.querySelector('.converter-background'), null);
  } finally {
    await view.cleanup();
  }
});
