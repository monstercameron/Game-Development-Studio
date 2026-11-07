import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('Run decision remains available when observed Mammoth readiness is unknown or stale', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    localStorage: globalThis.localStorage,
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const calls = [];
  let observedService = { status: 'reachable', modelLoaded: null, managed: false };
  let vite;
  let root;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) === '/api/runtime/services') {
        return { ok: true, json: async () => ({ services: [{ id: 'game', ...observedService }] }) };
      }
      return {
        ok: false,
        json: async () => ({ detail: 'Mammoth rejected the decision.' }),
      };
    };
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false },
    });
    const { default: GameDecision } = await vite.ssrLoadModule('/src/GameDecision.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);
    const draft = {
      prompt: 'A guard hears a noise.',
      second: 'What should happen?\n1. Investigate\n2. Call for help',
      options: ['Choice', 'Structured'],
    };

    for (const status of [
      { status: 'reachable', modelLoaded: null, managed: false },
      { status: 'reachable', modelLoaded: false, state: 'not loaded', managed: false },
    ]) {
      observedService = status;
      await act(async () => {
        root.render(
          React.createElement(GameDecision, {
            draft,
            key: status.modelLoaded === null ? 'unknown' : 'stale',
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const runButton = [...container.querySelectorAll('button')].find((button) =>
        button.textContent.includes('Run decision'),
      );
      assert.ok(runButton);
      assert.equal(runButton.disabled, false);
      assert.match(
        container.querySelector('.game-service-state strong')?.textContent || '',
        status.modelLoaded === null ? /status unknown/ : /model not loaded/,
      );
      await act(async () => runButton.click());
      assert.ok(calls.includes('/api/runtime/game/decide'));
      assert.match(container.querySelector('[role="alert"]')?.textContent || '', /rejected/);
      calls.length = 0;
    }
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.close();
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
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    if (previousGlobals.localStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previousGlobals.localStorage;
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
  }
});
