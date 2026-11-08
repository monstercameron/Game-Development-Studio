import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

class FakeSocket {
  static instance;

  constructor(url) {
    this.url = String(url);
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.listeners = new Map();
    FakeSocket.instance = this;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send() {}

  close() {
    this.readyState = 3;
  }

  message(event) {
    for (const listener of this.listeners.get('message') || []) {
      listener({ data: JSON.stringify(event) });
    }
  }
}

function createAudioContext() {
  return class {
    sampleRate = 16000;
    destination = {};
    audioWorklet = { addModule: async () => {} };

    async resume() {}

    async close() {}

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createGain() {
      return { gain: {}, connect() {}, disconnect() {} };
    }
  };
}

function createMediaStream() {
  const track = { addEventListener() {}, stop() {} };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('Timed out waiting for the speech UI state.');
}

test('speech UI accepts 100,000 final characters and reports a later overflow', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.speech-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const originalGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    WebSocket: globalThis.WebSocket,
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let root;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.WebSocket = FakeSocket;
    globalThis.AudioWorkletNode = class {
      port = {
        onmessage: null,
        postMessage: (message) => {
          if (message === 'flush') {
            this.port.onmessage?.({ data: { type: 'flushed' } });
          }
        },
      };

      connect() {}

      disconnect() {}
    };
    dom.window.AudioWorkletNode = globalThis.AudioWorkletNode;
    dom.window.AudioContext = createAudioContext();
    globalThis.AudioContext = dom.window.AudioContext;
    Object.defineProperty(dom.window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => createMediaStream() },
    });
    globalThis.fetch = async (url) => {
      assert.equal(url, '/api/runtime/services');
      return {
        ok: true,
        json: async () => ({
          services: [{ id: 'asr', status: 'reachable', modelLoaded: true }],
        }),
      };
    };

    const sourcePath = path.join(repositoryRoot, 'src', 'SpeechTranscriber.jsx');
    const source = (await readFile(sourcePath, 'utf8'))
      .replace("from './save-project-text'", "from './speech-ui-stubs.mjs'")
      .replace("from './AssetPicker'", "from './speech-ui-stubs.mjs'")
      .replace("from './asset-picker.js'", "from './speech-ui-stubs.mjs'")
      .replace("from './useNav'", "from './speech-ui-stubs.mjs'")
      .replace("from './MemoryDialog'", "from './speech-ui-stubs.mjs'")
      .replace("from './queue-timing.js'", "from './speech-ui-stubs.mjs'")
      .replace("from './asr-stream.js'", "from '../../src/asr-stream.js'")
      .replace("import './speech-transcriber.css';", '');
    await writeFile(
      path.join(temporaryDirectory, 'speech-ui-stubs.mjs'),
      [
        'export async function saveProjectText() { return { path: "" }; }',
        'export const AUDIO_EXTENSIONS = [];',
        'export function updateSearch() {}',
        'export function formatDuration() { return "0s"; }',
        'export default function Stub() { return null; }',
      ].join('\n'),
      'utf8',
    );
    const transformed = await transformWithEsbuild(source, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    const modulePath = path.join(temporaryDirectory, 'SpeechTranscriber.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: SpeechTranscriber } = await import(pathToFileURL(modulePath).href);

    const container = document.getElementById('root');
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(SpeechTranscriber, { onUseText() {} }),
        ),
      );
    });

    const controls = container.querySelector('[role="group"][aria-label="Transcription controls"]');
    assert.ok(controls);
    assert.equal(container.querySelector('details.speech-estimate')?.open, false);
    assert.equal(controls.querySelector('[role="status"]'), null);
    assert.equal(
      container.querySelector('.speech-status')?.textContent,
      'Microphone off. Your browser asks for access when you start.',
    );

    const startButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Start microphone'),
    );
    assert.ok(startButton);
    await act(async () => {
      startButton.click();
      await waitFor(() => FakeSocket.instance);
      FakeSocket.instance.message({ type: 'session.created' });
      FakeSocket.instance.message({ type: 'session.updated' });
    });
    await waitFor(() =>
      container.querySelector('.speech-status')?.textContent.startsWith('Recording.'),
    );
    assert.equal(container.querySelector('.speech-output[aria-live]'), null);

    await act(async () => {
      FakeSocket.instance.message({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'a'.repeat(100000),
      });
    });
    assert.equal(container.querySelector('.speech-output > span')?.textContent.length, 100000);
    assert.equal(container.querySelector('[role="alert"]'), null);

    await act(async () => {
      FakeSocket.instance.message({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'b',
      });
    });
    assert.match(
      container.querySelector('[role="alert"]')?.textContent || '',
      /Transcript is too long/,
    );
    assert.equal(container.querySelector('.speech-output > span')?.textContent.length, 100000);

    const retryButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Start microphone'),
    );
    const previousSocket = FakeSocket.instance;
    await act(async () => {
      retryButton.click();
      await waitFor(() => FakeSocket.instance !== previousSocket);
      FakeSocket.instance.message({ type: 'session.created' });
      FakeSocket.instance.message({ type: 'session.updated' });
    });
    await waitFor(() =>
      container.querySelector('.speech-status')?.textContent.startsWith('Recording.'),
    );
    await act(async () => {
      FakeSocket.instance.message({
        type: 'conversation.item.input_audio_transcription.delta',
        delta: 'partial words',
      });
    });
    assert.equal(container.querySelector('.speech-partial')?.textContent, 'partial words');
    assert.equal(
      container.querySelector('.speech-status')?.textContent,
      'Recording. Speak, then choose Stop & finish.',
    );
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent.includes('Stop & finish'))
        .click();
      FakeSocket.instance.message({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'final words',
      });
    });
    await waitFor(
      () => container.querySelector('.speech-status')?.textContent === 'Transcription complete.',
    );
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    dom.window.close();
    if (originalGlobals.window === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalGlobals.window;
    }
    if (originalGlobals.document === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalGlobals.document;
    }
    if (originalGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', originalGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    for (const key of ['AudioContext', 'AudioWorkletNode', 'WebSocket', 'fetch']) {
      if (originalGlobals[key] === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = originalGlobals[key];
      }
    }
    if (originalGlobals.actEnvironment === undefined) {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalThis.IS_REACT_ACT_ENVIRONMENT = originalGlobals.actEnvironment;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
