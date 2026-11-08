import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('credential save remains actionable when the follow-up status refresh fails', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.credential-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const originalGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let statusRequests = 0;
  let React;
  let act;
  let createRoot;
  let root;

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    ({ default: React, act } = await import('react'));
    ({ createRoot } = await import('react-dom/client'));
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/credentials/status');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['X-Forge-Request'], 'credentials');
      statusRequests++;
      if (statusRequests === 1) {
        return {
          ok: true,
          json: async () => ({
            credentials: [
              { provider: 'openai', saved: false },
              { provider: 'huggingface', saved: false },
            ],
          }),
        };
      }
      throw Error('synthetic status refresh failure');
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url === '/api/credentials/save') {
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-Forge-Request'], 'credentials');
        assert.deepEqual(JSON.parse(options.body), {
          provider: 'openai',
          secret: 'not-a-real-secret-fixture',
        });
        return { ok: true, json: async () => ({ saved: true }) };
      }
      return originalFetch(url, options);
    };

    const sourcePath = path.join(repositoryRoot, 'src', 'CredentialSettings.jsx');
    const source = await readFile(sourcePath, 'utf8');
    const transformed = await transformWithEsbuild(
      source.replace("import './credential-settings.css';", ''),
      path.join(temporaryDirectory, 'CredentialSettings.jsx'),
      { loader: 'jsx', jsx: 'automatic' },
    );
    const modulePath = path.join(temporaryDirectory, 'CredentialSettings.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    const { default: CredentialSettings } = await import(pathToFileURL(modulePath).href);

    const container = document.getElementById('root');
    root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(CredentialSettings));
    });
    assert.equal(statusRequests, 1);

    const input = container.querySelector('#credential-openai');
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value',
      ).set;
      valueSetter.call(input, 'not-a-real-secret-fixture');
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(input.value, 'not-a-real-secret-fixture');

    assert.equal(container.querySelector('button[type="submit"]').disabled, false);
    await act(async () => {
      container.querySelector('button[type="submit"]').click();
    });

    assert.equal(statusRequests, 2);
    assert.equal(input.value, '', 'saved secret should be cleared from the input');
    assert.equal(
      container.querySelector('.credential-heading span').textContent,
      'Saved',
      'successful mutation should retain the saved status after refresh failure',
    );
    assert.equal(container.querySelector('button[type="submit"]').textContent, 'Replace key');
    assert.equal(container.querySelector('button.ghost-button')?.textContent, 'Remove key');
    // Each key row names its provider, so the two "Save key" buttons are distinguishable.
    assert.equal(
      container.querySelector('button[type="submit"]').getAttribute('aria-label'),
      'Replace key for OpenAI',
    );
    assert.equal(
      container.querySelector('button.ghost-button').getAttribute('aria-label'),
      'Remove key for OpenAI',
    );
    assert.equal(container.querySelector('[role="status"]')?.textContent, 'OpenAI key saved.');
    assert.equal(
      container.querySelector('[role="alert"]')?.textContent,
      'Key saved, but its status could not be refreshed.',
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
    for (const key of ['fetch']) {
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
