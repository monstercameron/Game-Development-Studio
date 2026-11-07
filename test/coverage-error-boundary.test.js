import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { JSDOM } from 'jsdom';
import { loadConfigFromFile, transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('page error boundary contains thrown values and lets a failed page retry', async () => {
  const fixtureDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.error-boundary-'));
  const sourcePath = path.join(repositoryRoot, 'src', 'PageErrorBoundary.jsx');
  const outputPath = path.join(fixtureDirectory, 'PageErrorBoundary.mjs');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const browserGlobals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousDescriptors = new Map(
    Object.keys(browserGlobals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const previousConsoleError = console.error;

  try {
    for (const [key, value] of Object.entries(browserGlobals)) {
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
    }

    const loadedConfig = await loadConfigFromFile(
      { command: 'serve', mode: 'test' },
      path.join(repositoryRoot, 'vite.config.js'),
      repositoryRoot,
      'silent',
    );
    assert.ok(loadedConfig, 'Vite should load the project configuration');

    const source = await readFile(sourcePath, 'utf8');
    const transformed = await transformWithEsbuild(source, sourcePath, loadedConfig.config.esbuild);
    await writeFile(outputPath, transformed.code, 'utf8');
    const { default: PageErrorBoundary } = await import(pathToFileURL(outputPath).href);
    const { createRoot } = await import('react-dom/client');

    console.error = () => {};
    const container = document.getElementById('root');
    const thrownValues = [
      { value: new Error('page failed'), detail: 'page failed' },
      { value: null, detail: 'A non-Error value was thrown.' },
      { value: undefined, detail: 'A non-Error value was thrown.' },
      { value: 'plain thrown string', detail: 'plain thrown string' },
      { value: 17, detail: '17' },
      { value: false, detail: 'false' },
      { value: Symbol('thrown symbol'), detail: 'Symbol(thrown symbol)' },
    ];

    for (const { value, detail } of thrownValues) {
      const root = createRoot(container);
      function FailingPage() {
        throw value;
      }

      await React.act(() => {
        root.render(
          React.createElement(
            PageErrorBoundary,
            { name: 'Test workspace' },
            React.createElement(FailingPage),
          ),
        );
      });

      assert.equal(
        container.querySelector('[role="alert"] h1')?.textContent,
        'Could not open Test workspace',
      );
      assert.ok(container.querySelector('pre')?.textContent.includes(detail));
      assert.ok(
        [...container.querySelectorAll('button')].some((button) =>
          button.textContent.includes('Try again'),
        ),
      );

      await React.act(() => root.unmount());
    }

    const root = createRoot(container);
    let shouldFail = true;
    function RecoverablePage() {
      if (shouldFail) {
        throw 'temporary failure';
      }
      return React.createElement('p', null, 'Workspace recovered');
    }

    await React.act(() => {
      root.render(
        React.createElement(PageErrorBoundary, null, React.createElement(RecoverablePage)),
      );
    });
    shouldFail = false;
    const retryButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Try again'),
    );
    assert.ok(retryButton, 'the fallback should offer a retry');
    await React.act(() => retryButton.click());
    assert.ok(
      [...container.querySelectorAll('p')].some(
        (paragraph) => paragraph.textContent === 'Workspace recovered',
      ),
    );
    await React.act(() => root.unmount());
  } finally {
    console.error = previousConsoleError;
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
    dom.window.close();
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
