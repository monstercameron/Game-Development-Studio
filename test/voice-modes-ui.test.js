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

test('the voice mode switch disables uninstalled checkpoints and shows the mode fields', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.voice-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/voices',
  });
  const globals = Object.fromEntries(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const previousFetch = globalThis.fetch;
  let root;

  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url) => {
        assert.equal(url, '/api/runtime/model-storage');
        return {
          ok: true,
          json: async () => ({
            state: 'ready',
            entries: [
              { id: 'tts-base', installed: false },
              { id: 'tts-voicedesign', installed: true },
            ],
          }),
        };
      },
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    const sourcePath = path.join(repositoryRoot, 'src', 'VoiceModeControls.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      "import AssetPicker from './AssetPicker';",
      'const AssetPicker = () => null;',
    );
    const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
    const modesModule = pathToFileURL(path.join(repositoryRoot, 'src', 'voice-modes.js')).href;
    const transformed = await transformWithEsbuild(
      source
        .replace("from './useNav'", `from '${navModule}'`)
        .replace("from './voice-modes.js'", `from '${modesModule}'`),
      sourcePath,
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'VoiceModeControls.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: VoiceModeControls } = await import(pathToFileURL(modulePath).href);

    const updates = [];
    const render = async (draft) => {
      if (root) {
        await act(async () => root.unmount());
      }
      root = createRoot(document.getElementById('root'));
      await act(async () => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/voices'] },
            React.createElement(VoiceModeControls, {
              project: null,
              projects: [],
              draft,
              update: (patch) => updates.push(patch),
            }),
          ),
        );
      });
      // Let the storage request resolve before reading the disabled state.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await render({ voiceMode: 'preset', second: '' });
    const base = document.querySelector('#voice-mode-clone');
    const design = document.querySelector('#voice-mode-design');
    assert.equal(base.disabled, true, 'the Base checkpoint is not staged');
    assert.match(
      document.querySelector('#voice-mode-clone-help').textContent,
      /install\.ps1 -Models tts-base/,
    );
    assert.equal(design.disabled, false, 'the VoiceDesign checkpoint is staged');
    assert.ok(document.querySelector('#extra'), 'preset direction is shown for preset voices');

    await render({ voiceMode: 'design', voiceDescription: '' });
    const description = document.querySelector('#voiceDescription');
    assert.ok(description, 'the design description field is shown');
    assert.equal(description.getAttribute('aria-describedby'), 'voiceDescription-help');
    assert.equal(document.querySelector('#extra'), null, 'preset direction is hidden');

    await render({ voiceMode: 'clone', voiceReferenceId: '', voiceConsent: false });
    const consent = document.querySelector('#voiceConsent');
    assert.equal(consent.checked, false);
    assert.match(
      document.querySelector('label[for="voiceConsent"]').textContent,
      /Only clone voices you have the right to use/,
    );
    assert.ok(document.querySelector('#voiceReferenceText'));
    assert.equal(
      document.querySelector('#voiceReferenceText').getAttribute('aria-describedby'),
      'voiceReferenceText-help',
    );
    assert.ok(
      [...document.querySelectorAll('button')].some((button) =>
        /Choose from asset library/.test(button.textContent),
      ),
      'clone asks for a project reference clip',
    );

    await act(async () => {
      consent.click();
    });
    assert.deepEqual(updates.at(-1), { voiceConsent: true });
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
    globalThis.fetch = previousFetch;
    dom.window.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('choosing a reference clip moves focus to the transcript instead of the page body', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.voice-focus-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/voices',
  });
  const globals = Object.fromEntries(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const previousFetch = globalThis.fetch;
  const requestedUrls = [];
  let root;

  try {
    const fetchStub = async (url) => {
      requestedUrls.push(url);
      if (url === '/api/runtime/model-storage') {
        return { ok: true, json: async () => ({ entries: [] }) };
      }
      if (url === '/api/projects/project-1/clips/from-asset') {
        return { ok: true, json: async () => ({ reference: { id: 'ref-1' } }) };
      }
      throw Error(`unexpected request ${url}`);
    };
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: fetchStub,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    // Stands in for the asset picker: one button that picks a clip, as the real "Use file" does.
    const sourcePath = path.join(repositoryRoot, 'src', 'VoiceModeControls.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      "import AssetPicker from './AssetPicker';",
      `const AssetPicker = ({ onSelect }) => (
          <button
            type="button"
            id="stub-use-file"
            onClick={() =>
              onSelect([{ forgeSource: { projectId: 'project-1', path: 'clips/take-1.wav' } }])
            }
          >
            Use file
          </button>
        );`,
    );
    const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
    const modesModule = pathToFileURL(path.join(repositoryRoot, 'src', 'voice-modes.js')).href;
    const transformed = await transformWithEsbuild(
      source
        .replace("from './useNav'", `from '${navModule}'`)
        .replace("from './voice-modes.js'", `from '${modesModule}'`),
      sourcePath,
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'VoiceModeControls.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: VoiceModeControls } = await import(pathToFileURL(modulePath).href);

    function Harness() {
      const [draft, setDraft] = React.useState({
        voiceMode: 'clone',
        voiceReferenceId: '',
        voiceReferenceText: '',
        voiceConsent: false,
      });
      return React.createElement(VoiceModeControls, {
        project: { id: 'project-1' },
        projects: [{ id: 'project-1', assets: [] }],
        draft,
        update: (patch) => setDraft((current) => ({ ...current, ...patch })),
      });
    }

    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/voices'] },
          React.createElement(Harness),
        ),
      );
    });
    const flush = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await flush();

    const chooser = [...document.querySelectorAll('button')].find((button) =>
      /Choose from asset library/.test(button.textContent),
    );
    await act(async () => chooser.click());
    await act(async () => document.getElementById('stub-use-file').click());
    await flush();
    await flush();

    assert.ok(
      requestedUrls.includes('/api/projects/project-1/clips/from-asset'),
      'the chosen clip is copied into the project',
    );
    assert.equal(
      document.activeElement,
      document.getElementById('voiceReferenceText'),
      'focus moves to the transcript, the next required field',
    );
    assert.notEqual(document.activeElement, document.body);
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
    globalThis.fetch = previousFetch;
    dom.window.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

// Mounts the clone page with stub clips. The transcript belongs to the clip it was written for, so
// these tests drive the real pick, type and remove paths and read back the draft.
async function mountClonePage(initialDraft) {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.voice-pair-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/voices',
  });
  const globals = Object.fromEntries(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const previousFetch = globalThis.fetch;
  // React's IE fallback calls attachEvent when focus moves into a field; jsdom does not have it.
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  let copyCount = 0;
  const fetchStub = async (url, options) => {
    if (url === '/api/runtime/model-storage') {
      return { ok: true, json: async () => ({ entries: [] }) };
    }
    if (url === '/api/projects/project-1/clips/from-asset') {
      copyCount += 1;
      assert.ok(JSON.parse(options.body).path, 'the clip path is sent');
      return { ok: true, json: async () => ({ reference: { id: `ref-${copyCount}` } }) };
    }
    throw Error(`unexpected request ${url}`);
  };

  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchStub,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }

  const sourcePath = path.join(repositoryRoot, 'src', 'VoiceModeControls.jsx');
  const source = (await readFile(sourcePath, 'utf8')).replace(
    "import AssetPicker from './AssetPicker';",
    `const AssetPicker = ({ onSelect }) => (
      <>
        <button
          type="button"
          id="stub-clip-a"
          onClick={() => onSelect([{ forgeSource: { projectId: 'project-1', path: 'clips/a.wav' } }])}
        >
          Use clip A
        </button>
        <button
          type="button"
          id="stub-clip-b"
          onClick={() => onSelect([{ forgeSource: { projectId: 'project-1', path: 'clips/b.wav' } }])}
        >
          Use clip B
        </button>
      </>
    );`,
  );
  const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
  const modesModule = pathToFileURL(path.join(repositoryRoot, 'src', 'voice-modes.js')).href;
  const transformed = await transformWithEsbuild(
    source
      .replace("from './useNav'", `from '${navModule}'`)
      .replace("from './voice-modes.js'", `from '${modesModule}'`),
    sourcePath,
    { loader: 'jsx', jsx: 'automatic' },
  );
  const modulePath = path.join(temporaryDirectory, 'VoiceModeControls.mjs');
  await writeFile(modulePath, transformed.code, 'utf8');
  const { default: VoiceModeControls } = await import(pathToFileURL(modulePath).href);

  let setDraftState;
  let currentDraft = initialDraft;
  function Harness() {
    const [draft, setDraft] = React.useState(initialDraft);
    setDraftState = setDraft;
    currentDraft = draft;
    return React.createElement(VoiceModeControls, {
      project: { id: 'project-1' },
      projects: [{ id: 'project-1', assets: [] }],
      draft,
      update: (patch) => setDraft((current) => ({ ...current, ...patch })),
    });
  }

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const buttonByText = (pattern) =>
    [...document.querySelectorAll('button')].find((button) => pattern.test(button.textContent));
  const transcriptElement = () => document.getElementById('voiceReferenceText');

  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/voices'] },
        React.createElement(Harness),
      ),
    );
  });
  await flush();

  return {
    temporaryDirectory,
    draft: () => currentDraft,
    transcript: () => transcriptElement().value,
    merge: async (patch) => {
      await act(async () => setDraftState((current) => ({ ...current, ...patch })));
    },
    chooseClip: async (id) => {
      await act(async () => buttonByText(/Choose from asset library/).click());
      await act(async () => document.getElementById(id).click());
      await flush();
      await flush();
    },
    removeClip: async () => {
      await act(async () => buttonByText(/Remove clip/).click());
      await flush();
    },
    typeTranscript: async (value) => {
      // react-dom loaded before this jsdom existed, so it reads typing through its IE fallback and
      // DOM input events do not reach onChange. Calling the handler with the same event shape
      // exercises the same component code.
      const element = transcriptElement();
      const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
      await act(async () => element[propsKey].onChange({ target: { value } }));
    },
    dispose: async () => {
      await act(async () => root.unmount());
      for (const [key, descriptor] of Object.entries(globals)) {
        if (descriptor === undefined) {
          delete globalThis[key];
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      }
      globalThis.fetch = previousFetch;
      dom.window.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

const cloneDraft = {
  voiceMode: 'clone',
  voiceReferenceId: '',
  voiceReferenceName: '',
  voiceReferenceSourceKey: '',
  voiceReferenceTextKey: '',
  voiceReferenceText: '',
  voiceConsent: false,
};

test('removing a clip keeps its transcript, and choosing a different clip clears it', async () => {
  const page = await mountClonePage(cloneDraft);
  try {
    await page.chooseClip('stub-clip-a');
    assert.equal(page.draft().voiceReferenceName, 'clips/a.wav');
    await page.typeTranscript('Words spoken in clip A.');

    await page.removeClip();
    assert.equal(page.draft().voiceReferenceId, '', 'the clip is removed');
    assert.equal(page.transcript(), 'Words spoken in clip A.', 'the transcript is kept');

    await page.chooseClip('stub-clip-b');
    assert.equal(page.draft().voiceReferenceName, 'clips/b.wav');
    assert.equal(page.transcript(), '', 'the clip A transcript is not kept for clip B');
    assert.equal(page.draft().voiceReferenceText, '', 'the draft transcript is cleared too');
  } finally {
    await page.dispose();
  }
});

test('choosing the same clip again after removal keeps the transcript', async () => {
  const page = await mountClonePage(cloneDraft);
  try {
    await page.chooseClip('stub-clip-a');
    await page.typeTranscript('Words spoken in clip A.');
    await page.removeClip();
    await page.chooseClip('stub-clip-a');
    assert.equal(page.transcript(), 'Words spoken in clip A.');
  } finally {
    await page.dispose();
  }
});

test('typing after removing a clip keeps the transcript tied to that clip', async () => {
  const page = await mountClonePage(cloneDraft);
  try {
    await page.chooseClip('stub-clip-a');
    await page.typeTranscript('Words spoken in clip A.');
    await page.removeClip();
    await page.typeTranscript('Words spoken in clip A, edited.');
    await page.chooseClip('stub-clip-b');
    assert.equal(page.transcript(), '', 'an edit with no clip staged still belongs to clip A');
  } finally {
    await page.dispose();
  }
});

test('a transcript typed before any clip is kept for the first clip chosen', async () => {
  const page = await mountClonePage(cloneDraft);
  try {
    await page.typeTranscript('Typed before choosing a clip.');
    await page.chooseClip('stub-clip-a');
    assert.equal(page.transcript(), 'Typed before choosing a clip.');
    await page.removeClip();
    await page.chooseClip('stub-clip-b');
    assert.equal(page.transcript(), '', 'once bound to clip A, the text does not follow clip B');
  } finally {
    await page.dispose();
  }
});

test('the transcript restored by Reuse settings survives the first clip choice', async () => {
  const clipAKey = JSON.stringify(['project-1', 'clips/a.wav']);
  const page = await mountClonePage({
    ...cloneDraft,
    voiceReferenceId: 'ref-old',
    voiceReferenceName: 'clips/a.wav',
    voiceReferenceSourceKey: clipAKey,
    voiceReferenceTextKey: clipAKey,
    voiceReferenceText: 'Words from an earlier clip.',
  });
  try {
    const generationSourcePath = path.join(repositoryRoot, 'src', 'generation-details.js');
    const videoOptionsModule = pathToFileURL(
      path.join(repositoryRoot, 'runtime', 'video-options.js'),
    ).href;
    const generationSource = (await readFile(generationSourcePath, 'utf8')).replace(
      "from '../runtime/video-options.js'",
      `from '${videoOptionsModule}'`,
    );
    const generationTransformed = await transformWithEsbuild(
      generationSource,
      generationSourcePath,
      { loader: 'js' },
    );
    const generationModule = path.join(page.temporaryDirectory, 'generation-details.mjs');
    await writeFile(generationModule, generationTransformed.code, 'utf8');
    const { reusePlan } = await import(pathToFileURL(generationModule).href);
    const plan = reusePlan({
      job: { type: 'voices' },
      settings: {
        mode: 'clone',
        reference_text: 'Restored words from the asset.',
        speaker: 'Ryan',
        language: 'English',
      },
      prompt: { text: 'Line of dialogue.', secondary: '' },
      seed: 7,
    });
    assert.equal(plan.section, 'voices');
    // Reuse merges into the saved draft, the same way the page updates a section.
    await page.merge(plan.draft);
    assert.equal(page.draft().voiceReferenceId, '', 'the earlier clip is cleared by reuse');
    assert.equal(page.transcript(), 'Restored words from the asset.');

    await page.chooseClip('stub-clip-b');
    assert.equal(page.draft().voiceReferenceName, 'clips/b.wav');
    assert.equal(
      page.transcript(),
      'Restored words from the asset.',
      'the restored transcript is kept for the first clip chosen after reuse',
    );
  } finally {
    await page.dispose();
  }
});

test('a clone clip shows its length and warns when it is outside 3 to 30 seconds', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.voice-length-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/voices',
  });
  const keys = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'Audio'];
  const globals = Object.fromEntries(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const urlFunctions = {
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  // What the stubbed Audio element reports for the next clip: a duration, or a decode error.
  let clipOutcome = { duration: 1.2 };
  class FakeAudio {
    set src(_value) {
      setTimeout(() => {
        if (clipOutcome.error) {
          this.onerror?.(new Event('error'));
          return;
        }
        this.duration = clipOutcome.duration;
        this.onloadedmetadata?.();
      }, 0);
    }
  }
  const updates = [];
  let root;

  try {
    const fetchStub = async (url) => {
      if (url === '/api/runtime/model-storage') {
        return { ok: true, json: async () => ({ entries: [] }) };
      }
      if (url === '/api/projects/p1/clips/from-asset') {
        return {
          ok: true,
          json: async () => ({ reference: { id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f.wav' } }),
        };
      }
      throw Error(`unexpected request ${url}`);
    };
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      Audio: FakeAudio,
      fetch: fetchStub,
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }
    URL.createObjectURL = () => 'blob:forge-test-clip';
    URL.revokeObjectURL = () => {};

    // The picker stub keeps its props so the test can choose a clip the way the picker does.
    const sourcePath = path.join(repositoryRoot, 'src', 'VoiceModeControls.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      "import AssetPicker from './AssetPicker';",
      'const AssetPicker = (props) => {\n  globalThis.__forgeVoicePicker = props;\n  return null;\n};',
    );
    const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
    const modesModule = pathToFileURL(path.join(repositoryRoot, 'src', 'voice-modes.js')).href;
    const transformed = await transformWithEsbuild(
      source
        .replace("from './useNav'", `from '${navModule}'`)
        .replace("from './voice-modes.js'", `from '${modesModule}'`),
      sourcePath,
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'VoiceModeControls.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: VoiceModeControls } = await import(pathToFileURL(modulePath).href);

    const render = async (draft) => {
      if (root) {
        await act(async () => root.unmount());
      }
      root = createRoot(document.getElementById('root'));
      await act(async () => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/voices'] },
            React.createElement(VoiceModeControls, {
              project: { id: 'p1' },
              projects: [{ id: 'p1', assets: [] }],
              draft,
              update: (patch) => updates.push(patch),
            }),
          ),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const chooseClip = async (seconds) => {
      clipOutcome = seconds === null ? { error: true } : { duration: seconds };
      await act(async () => {
        [...document.querySelectorAll('button')]
          .find((button) => /Choose from asset library/.test(button.textContent))
          .click();
      });
      const clip = new File(['clip'], 'clip.wav', { type: 'audio/wav' });
      clip.forgeSource = { projectId: 'p1', path: 'clip.wav' };
      await act(async () => {
        globalThis.__forgeVoicePicker.onSelect([clip]);
      });
      await settle();
    };

    // Choosing a clip reports its length with the staged reference; an unreadable one reports null.
    await render({ voiceMode: 'clone', voiceReferenceId: '', voiceConsent: false });
    await chooseClip(1.2);
    assert.equal(updates.at(-1).voiceReferenceSeconds, 1.2);
    await chooseClip(null);
    assert.equal(updates.at(-1).voiceReferenceSeconds, null, 'an unreadable clip is not blocked');

    // The chosen clip row shows its length, and an alert when the length is out of range.
    const staged = {
      voiceMode: 'clone',
      voiceReferenceId: 'x.wav',
      voiceReferenceName: 'clip.wav',
      voiceReferenceText: 'Words',
      voiceConsent: true,
    };
    await render({ ...staged, voiceReferenceSeconds: 1.2 });
    const alert = document.querySelector('[role="alert"]');
    assert.equal(alert.textContent, 'Reference audio must be 3 to 30 seconds long.');
    const row = document.querySelector('.sound-source-chosen');
    assert.equal(row.getAttribute('aria-describedby'), alert.id);
    assert.match(row.textContent, /Length 1\.2 s/);

    await render({ ...staged, voiceReferenceSeconds: 45 });
    assert.equal(
      document.querySelector('[role="alert"]').textContent,
      'Reference audio must be 3 to 30 seconds long.',
    );

    await render({ ...staged, voiceReferenceSeconds: 7.5 });
    assert.equal(document.querySelector('[role="alert"]'), null, 'an in-range clip has no alert');
    assert.match(document.querySelector('.sound-source-chosen').textContent, /Length 7\.5 s/);

    await render({ ...staged, voiceReferenceSeconds: null });
    assert.equal(
      document.querySelector('[role="alert"]'),
      null,
      'an unknown length is not blocked',
    );
    assert.doesNotMatch(document.querySelector('.sound-source-chosen').textContent, /Length/);

    // The helper text under the picker states the limits before a clip is chosen.
    await render({ voiceMode: 'clone', voiceReferenceId: '', voiceConsent: false });
    assert.match(
      document.querySelector('.sound-source-help').textContent,
      /3 to 30 seconds, up to 32 MiB/,
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
    URL.createObjectURL = urlFunctions.createObjectURL;
    URL.revokeObjectURL = urlFunctions.revokeObjectURL;
    delete globalThis.__forgeVoicePicker;
    dom.window.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('a failed voice submit shows each missing field inline and focuses the first one', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.voice-errors-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/voices',
  });
  const globals = Object.fromEntries(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const previousFetch = globalThis.fetch;
  let root;

  try {
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          entries: [
            { id: 'tts-base', installed: true },
            { id: 'tts-voicedesign', installed: true },
          ],
        }),
      }),
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    const sourcePath = path.join(repositoryRoot, 'src', 'VoiceModeControls.jsx');
    const source = (await readFile(sourcePath, 'utf8')).replace(
      "import AssetPicker from './AssetPicker';",
      'const AssetPicker = () => null;',
    );
    const navModule = pathToFileURL(path.join(repositoryRoot, 'src', 'useNav.js')).href;
    const modesModule = pathToFileURL(path.join(repositoryRoot, 'src', 'voice-modes.js')).href;
    const transformed = await transformWithEsbuild(
      source
        .replace("from './useNav'", `from '${navModule}'`)
        .replace("from './voice-modes.js'", `from '${modesModule}'`),
      sourcePath,
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'VoiceModeControls.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: VoiceModeControls } = await import(pathToFileURL(modulePath).href);

    root = createRoot(document.getElementById('root'));
    // A failed submit re-renders the same mounted controls with a higher submitAttempts count.
    const paint = async (draft, submitAttempts = 0) => {
      await act(async () => {
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/voices'] },
            React.createElement(VoiceModeControls, {
              project: null,
              projects: [{ id: 'project-1', name: 'Project' }],
              draft,
              update: () => {},
              submitAttempts,
            }),
          ),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    const emptyClone = {
      voiceMode: 'clone',
      voiceReferenceId: '',
      voiceReferenceText: '',
      voiceConsent: false,
    };
    await paint(emptyClone);
    assert.equal(
      document.querySelectorAll('.voice-field-error').length,
      0,
      'no errors before submit',
    );
    assert.equal(document.querySelector('#voiceConsent').getAttribute('aria-invalid'), null);

    await paint(emptyClone, 1);
    const clipButton = document.querySelector('#voiceReference-choose');
    assert.equal(clipButton.getAttribute('aria-invalid'), 'true');
    assert.equal(clipButton.getAttribute('aria-describedby'), 'voiceReference-error');
    const clipError = document.querySelector('#voiceReference-error');
    assert.equal(clipError.getAttribute('role'), 'alert');
    assert.match(
      clipError.textContent,
      /Choose a WAV, FLAC or MP3 reference clip from the project\./,
    );

    const transcript = document.querySelector('#voiceReferenceText');
    assert.equal(transcript.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(transcript.getAttribute('aria-describedby').split(' '), [
      'voiceReferenceText-help',
      'voiceReferenceText-error',
    ]);
    assert.match(
      document.querySelector('#voiceReferenceText-error').textContent,
      /Enter the exact words spoken in the reference clip, in 1–1000 characters\./,
    );

    const consent = document.querySelector('#voiceConsent');
    assert.equal(consent.getAttribute('aria-invalid'), 'true');
    assert.equal(consent.getAttribute('aria-describedby'), 'voiceConsent-error');
    assert.match(
      document.querySelector('#voiceConsent-error').textContent,
      /Confirm that you have the right to use this voice before cloning it\./,
    );
    assert.equal(document.activeElement, clipButton, 'focus moves to the first invalid field');

    await paint({ voiceMode: 'design', voiceDescription: '   ' }, 2);
    const description = document.querySelector('#voiceDescription');
    assert.equal(description.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(description.getAttribute('aria-describedby').split(' '), [
      'voiceDescription-help',
      'voiceDescription-error',
    ]);
    assert.match(
      document.querySelector('#voiceDescription-error').textContent,
      /Describe the voice in 1–500 characters\./,
    );
    assert.equal(document.activeElement, description, 'focus moves to the empty description');

    // Fixing the fields clears every error, even after a failed submit.
    await paint(
      {
        voiceMode: 'clone',
        voiceReferenceId: 'reference-1',
        voiceReferenceName: 'clip.wav',
        voiceReferenceText: 'Hello there',
        voiceConsent: true,
      },
      2,
    );
    assert.equal(document.querySelectorAll('.voice-field-error').length, 0);
    assert.equal(document.querySelector('[aria-invalid="true"]'), null);
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
    globalThis.fetch = previousFetch;
    dom.window.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the inline voice messages use the same wording as the server refusals', async () => {
  const serverSource = (
    await readFile(path.join(repositoryRoot, 'runtime', 'voice-modes.js'), 'utf8')
  )
    .replaceAll('${VOICE_DESCRIPTION_MAX}', '500')
    .replaceAll('${CLONE_TRANSCRIPT_MAX}', '1000');
  const { firstVoiceModeError, voiceModeFieldErrors } = await import(
    pathToFileURL(path.join(repositoryRoot, 'src', 'voice-modes.js')).href
  );
  const cloneErrors = voiceModeFieldErrors({
    voiceMode: 'clone',
    voiceReferenceId: '',
    voiceReferenceText: '',
    voiceConsent: false,
  });
  const designErrors = voiceModeFieldErrors({ voiceMode: 'design', voiceDescription: '' });
  const messages = [
    cloneErrors.reference,
    cloneErrors.transcript,
    cloneErrors.consent,
    designErrors.description,
  ];
  for (const message of messages) {
    assert.ok(serverSource.includes(message), `the server refuses with: ${message}`);
  }
  assert.equal(firstVoiceModeError(cloneErrors), cloneErrors.reference);
  assert.deepEqual(voiceModeFieldErrors({ voiceMode: 'preset' }), {
    reference: '',
    transcript: '',
    consent: '',
    description: '',
  });
});
