import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadConfigFromFile, transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('configured Vite renders JSX that does not import React', async () => {
  const fixtureDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.vite-jsx-'));
  const sourcePath = path.join(fixtureDirectory, 'component.jsx');
  const outputPath = path.join(fixtureDirectory, 'component.mjs');

  try {
    const source =
      'export default function Component() { return <main data-kind="automatic">Ready</main>; }';
    const loadedConfig = await loadConfigFromFile(
      { command: 'serve', mode: 'test' },
      path.join(repositoryRoot, 'vite.config.js'),
      repositoryRoot,
      'silent',
    );
    assert.ok(loadedConfig, 'Vite should load the project configuration');

    const transformed = await transformWithEsbuild(source, sourcePath, loadedConfig.config.esbuild);
    await writeFile(outputPath, transformed.code, 'utf8');

    const { default: Component } = await import(pathToFileURL(outputPath).href);
    assert.equal(
      renderToStaticMarkup(React.createElement(Component)),
      '<main data-kind="automatic">Ready</main>',
    );
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});
