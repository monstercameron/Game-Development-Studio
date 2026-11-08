import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { MemoryRouter } from 'react-router';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceUrl = (name) => pathToFileURL(path.join(repositoryRoot, 'src', name)).href;

// Renders one src component in jsdom. `replacements` rewrites its relative imports to files or
// stub modules, as the other UI tests do.
async function render(t, file, props, { replacements = {}, stubs = {}, route = '/', fetch } = {}) {
  const directory = await mkdtemp(path.join(repositoryRoot, 'test', '.audio-engine-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: `http://localhost${route}`,
  });
  const keys = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    ...(fetch ? { fetch } : {}),
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  // react-dom decides at load time whether the DOM supports input events, so it loads after jsdom.
  const { createRoot } = await import('react-dom/client');
  const mounted = { root: null };
  t.after(async () => {
    if (mounted.root) {
      await act(async () => mounted.root.unmount());
    }
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor === undefined) {
        delete globalThis[key];
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  });
  let source = (await readFile(path.join(repositoryRoot, 'src', file), 'utf8')).replace(
    /import '\.\/[a-z-]+\.css';\r?\n/g,
    '',
  );
  // The shared logger is not needed in these renders; a no-op keeps the transform self-contained.
  source = source.replace(
    "import { createLog } from './app-log.js';",
    'const createLog = () => ({ debug() {}, info() {}, warn() {}, error() {} });',
  );
  for (const [specifier, target] of Object.entries(replacements)) {
    source = source.replace(`from '${specifier}'`, `from '${target}'`);
  }
  for (const [name, code] of Object.entries(stubs)) {
    await writeFile(path.join(directory, name), code, 'utf8');
  }
  const transformed = await transformWithEsbuild(source, file, { loader: 'jsx', jsx: 'automatic' });
  const modulePath = path.join(directory, `${path.basename(file, '.jsx')}.mjs`);
  await writeFile(modulePath, transformed.code, 'utf8');
  const { default: Component } = await import(pathToFileURL(modulePath).href);
  const root = createRoot(document.getElementById('root'));
  mounted.root = root;
  const draw = (nextProps) =>
    act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [route] },
          React.createElement(Component, nextProps),
        ),
      );
    });
  await draw(props);
  return { container: document.getElementById('root'), draw, window: dom.window };
}

async function change(window, element, value) {
  const prototype =
    element.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : element.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(
      new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const click = (window, element) =>
  act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const byText = (container, selector, pattern) =>
  [...container.querySelectorAll(selector)].find((element) => pattern.test(element.textContent));

test('the voice fine-tune panel exposes sub-talker sampling and the clone/design checkpoint note', async (t) => {
  const changes = [];
  const { container, window } = await render(
    t,
    'AudioSettings.jsx',
    {
      section: 'voices',
      draft: { voiceSubTemperature: '0.4', voiceDoSample: 'off', voiceSubDoSample: 'on' },
      update: (values) => changes.push(values),
    },
    { replacements: { './useNav': sourceUrl('useNav.js') }, route: '/voices' },
  );
  assert.match(container.querySelector('summary').textContent, /3 custom settings set/);
  assert.equal(container.querySelector('#voiceSubTemperature').value, '0.4');
  assert.equal(container.querySelector('#voiceDoSample').value, 'off');
  assert.deepEqual(
    [...container.querySelector('#voiceDoSample').options].map((option) => option.value),
    ['', 'on', 'off'],
  );
  for (const id of ['voiceSubDoSample', 'voiceSubTopP', 'voiceSubTopK']) {
    assert.ok(container.querySelector(`#${id}`), id);
  }
  assert.match(
    container.querySelector('#voiceDoSample-help').textContent,
    /Greedy always picks the likeliest/,
  );
  await change(window, container.querySelector('#voiceSubTopK'), '25');
  await change(window, container.querySelector('#voiceDoSample'), 'on');
  assert.deepEqual(changes, [{ voiceSubTopK: '25' }, { voiceDoSample: 'on' }]);
  assert.match(
    container.querySelector('.audio-settings-unavailable').textContent,
    /Base and\s+VoiceDesign/,
  );
});

test('the sound fine-tune panel shows the source-sound control it is given', async (t) => {
  const { container } = await render(
    t,
    'AudioSettings.jsx',
    {
      section: 'sfx',
      draft: { soundSourceId: 'abc.wav' },
      update: () => {},
      sourcePicker: React.createElement('div', { id: 'source-slot' }, 'slot'),
    },
    { replacements: { './useNav': sourceUrl('useNav.js') }, route: '/sfx' },
  );
  assert.ok(container.querySelector('#source-slot'));
  assert.match(container.querySelector('summary').textContent, /1 custom setting set/);
  const note = container.querySelector('.audio-settings-unavailable').textContent;
  assert.match(note, /negative prompt and guidance/);
  assert.doesNotMatch(note, /inpainting/, 'inpainting is no longer listed as unavailable');
});

test('the music fine-tune panel points to Extend and Re-synthesize', async (t) => {
  const music = await render(
    t,
    'AudioSettings.jsx',
    { section: 'music', draft: {}, update: () => {} },
    { replacements: { './useNav': sourceUrl('useNav.js') }, route: '/music?tune=1' },
  );
  assert.match(
    music.container.querySelector('.audio-settings-unavailable').textContent,
    /Extend this track or Re-synthesize/,
  );
});

const pickerStub = `
  import React from 'react';
  export default function AssetPicker({ onSelect, onClose }) {
    return React.createElement('div', { role: 'dialog' },
      React.createElement('button', { id: 'pick', onClick: () => {
        const file = new File(['x'], 'hit.wav');
        file.forgeSource = { projectId: '11111111-1111-1111-1111-111111111111', path: 'sfx/hit.wav' };
        onSelect([file]);
      } }, 'pick'),
      React.createElement('button', { id: 'close', onClick: onClose }, 'close'));
  }
`;

test('Start from an existing sound stages the chosen asset and keeps only its ID', async (t) => {
  const posts = [];
  const updates = [];
  const { container, window, draw } = await render(
    t,
    'SoundSource.jsx',
    {
      project: { id: '11111111-1111-1111-1111-111111111111' },
      projects: [{ id: '11111111-1111-1111-1111-111111111111', assets: [] }],
      draft: {},
      update: (values) => updates.push(values),
    },
    {
      route: '/sfx?tune=1&soundSource=1',
      replacements: {
        './AssetPicker': './AssetPickerStub.mjs',
        './useNav': sourceUrl('useNav.js'),
        './sound-source.js': sourceUrl('sound-source.js'),
      },
      stubs: { 'AssetPickerStub.mjs': pickerStub },
      fetch: async (url, options) => {
        posts.push({ url, options });
        return {
          ok: true,
          json: async () => ({ reference: { id: '99999999-2222-3333-4444-555555555555.wav' } }),
        };
      },
    },
  );
  await click(window, container.querySelector('#pick'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/projects/11111111-1111-1111-1111-111111111111/clips/from-asset');
  assert.equal(posts[0].options.headers['X-Forge-Request'], 'project');
  assert.deepEqual(JSON.parse(posts[0].options.body), { path: 'sfx/hit.wav' });
  assert.deepEqual(updates.at(-1), {
    soundSourceId: '99999999-2222-3333-4444-555555555555.wav',
    soundSourceName: 'sfx/hit.wav',
    soundEditMode: 'variation',
  });

  // With a source chosen, the mode controls appear and follow the draft.
  const props = (draft) => ({
    project: { id: 'p' },
    projects: [{ id: 'p', assets: [] }],
    draft,
    update: (values) => updates.push(values),
  });
  await draw(props({ soundSourceId: 'a.wav', soundSourceName: 'sfx/hit.wav' }));
  assert.match(container.querySelector('.sound-source-chosen').textContent, /sfx\/hit\.wav/);
  assert.ok(container.querySelector('#soundInitLevel'), 'variation shows the change amount');
  assert.equal(container.querySelector('#soundRegionStart'), null);
  await draw(props({ soundSourceId: 'a.wav', soundEditMode: 'replace' }));
  assert.ok(container.querySelector('#soundRegionStart'));
  assert.ok(container.querySelector('#soundRegionEnd'));
  await draw(props({ soundSourceId: 'a.wav', soundEditMode: 'continue' }));
  assert.match(container.querySelector('.sound-source-help').textContent, /longer than the source/);
  await click(window, byText(container, 'button', /Remove source/));
  assert.deepEqual(updates.at(-1), {
    soundSourceId: '',
    soundSourceName: '',
    soundRegionStart: '',
    soundRegionEnd: '',
  });
});

test('Start from an existing sound reports a staging failure instead of keeping a stale source', async (t) => {
  const updates = [];
  const { container, window } = await render(
    t,
    'SoundSource.jsx',
    {
      project: { id: 'p' },
      projects: [{ id: 'p', assets: [] }],
      draft: {},
      update: (values) => updates.push(values),
    },
    {
      route: '/sfx?soundSource=1',
      replacements: {
        './AssetPicker': './AssetPickerStub.mjs',
        './useNav': sourceUrl('useNav.js'),
        './sound-source.js': sourceUrl('sound-source.js'),
      },
      stubs: { 'AssetPickerStub.mjs': pickerStub },
      fetch: async () => ({
        ok: false,
        json: async () => ({ error: 'The audio must be a file of at most 32 MiB.' }),
      }),
    },
  );
  await click(window, container.querySelector('#pick'));
  assert.deepEqual(updates, []);
  assert.match(container.querySelector('[role="alert"]').textContent, /at most 32 MiB/);
});

test('Extend this track and Re-synthesize queue music jobs for the selected asset', async (t) => {
  const posts = [];
  const queued = [];
  const props = {
    project: { id: '11111111-1111-1111-1111-111111111111' },
    asset: { id: 'music/forge-a.flac', category: 'Audio' },
    onQueued: () => queued.push(true),
  };
  const { container, window, draw } = await render(t, 'MusicDerive.jsx', props, {
    replacements: { './music-derive.js': sourceUrl('music-derive.js') },
    fetch: async (url, options) => {
      posts.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ job: { id: 'j' } }) };
    },
  });
  await click(window, byText(container, 'button', /Extend this track/));
  await change(window, container.querySelector('#music-derive-seconds'), '40');
  await change(window, container.querySelector('#music-derive-lyrics'), '[Bridge]\nla');
  await act(async () => {
    container
      .querySelector('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/runtime/jobs');
  assert.equal(posts[0].options.headers['X-Forge-Request'], 'runtime');
  assert.deepEqual(posts[0].body, {
    type: 'music',
    projectId: '11111111-1111-1111-1111-111111111111',
    request: {
      operation: 'extend',
      source: 'music/forge-a.flac',
      add_seconds: 40,
      lyrics_addition: '[Bridge]\nla',
    },
  });
  assert.match(container.querySelector('.music-derive-message').textContent, /Extension added/);
  assert.equal(queued.length, 1);

  await click(window, byText(container, 'button', /Re-synthesize with a new seed/));
  assert.equal(container.querySelector('#music-derive-seconds'), null);
  await act(async () => {
    container
      .querySelector('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.deepEqual(posts[1].body.request, { operation: 'resynth', source: 'music/forge-a.flac' });

  // Only music files get the actions.
  await draw({ ...props, asset: { id: 'sfx/a.wav', category: 'Audio' } });
  assert.equal(container.querySelector('.music-derive'), null);
});

test('a refused extension shows the queue message and queues nothing else', async (t) => {
  const { container, window } = await render(
    t,
    'MusicDerive.jsx',
    { project: { id: 'p' }, asset: { id: 'music/imported.flac', category: 'Audio' } },
    {
      replacements: { './music-derive.js': sourceUrl('music-derive.js') },
      fetch: async () => ({
        ok: false,
        json: async () => ({
          error: 'Only a finished YuE2 track from this project can be extended.',
        }),
      }),
    },
  );
  await click(window, byText(container, 'button', /Extend this track/));
  await act(async () => {
    container
      .querySelector('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.match(container.querySelector('.music-derive-message').textContent, /Could not queue it/);
  assert.match(container.querySelector('.music-derive-message').textContent, /finished YuE2 track/);
  assert.equal(container.querySelector('.music-derive-message').getAttribute('role'), 'alert');
});

test('an open form, its entries and its message belong to one track only', async (t) => {
  const project = { id: '11111111-1111-1111-1111-111111111111' };
  const { container, window, draw } = await render(
    t,
    'MusicDerive.jsx',
    { project, asset: { id: 'music/forge-a.flac', category: 'Audio' } },
    { replacements: { './music-derive.js': sourceUrl('music-derive.js') } },
  );
  await click(window, byText(container, 'button', /Extend this track/));
  await change(window, container.querySelector('#music-derive-seconds'), '40');
  assert.equal(
    byText(container, 'button', /Extend this track/).getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(window.document.activeElement.id, 'music-derive-seconds');
  await draw({ project, asset: { id: 'music/forge-b.flac', category: 'Audio' } });
  assert.equal(container.querySelector('.music-derive-form'), null);
  await click(window, byText(container, 'button', /Extend this track/));
  assert.equal(container.querySelector('#music-derive-seconds').value, '');
});

test('Latency shows the saved mode and applies a change only when asked', async (t) => {
  const calls = [];
  const { container, window, draw } = await render(
    t,
    'AsrLatency.jsx',
    { disabled: false },
    {
      fetch: async (url, options) => {
        calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
        return {
          ok: true,
          json: async () =>
            options.method === 'GET'
              ? { latencyMs: 560, modes: [80, 160, 560, 1120] }
              : { latencyMs: 80, message: 'Restarting the speech engine with 80 ms chunks.' },
        };
      },
    },
  );
  const select = container.querySelector('select');
  assert.equal(select.value, '560', 'the saved mode is shown');
  const apply = byText(container, 'button', /Apply/);
  assert.equal(apply.disabled, true, 'nothing to apply while the choice matches');
  await change(window, select, '80');
  assert.equal(apply.disabled, false);
  assert.equal(calls.length, 1, 'choosing a mode alone does not restart anything');
  await click(window, apply);
  assert.deepEqual(calls[1], {
    url: '/api/runtime/asr/latency',
    method: 'POST',
    body: { latencyMs: 80 },
  });
  assert.match(
    container.querySelector('[role="status"]').textContent,
    /Restarting the speech engine/,
  );
  await draw({ disabled: true });
  assert.equal(container.querySelector('select').disabled, true, 'locked while transcribing');
});
