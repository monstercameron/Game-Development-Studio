import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('Hunyuan controls describe supported ranges, units, defaults, and invalid values', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.hunyuan-controls-'));
  const sourcePath = path.join(repositoryRoot, 'src', 'HunyuanControls.jsx');
  const outputPath = path.join(temporaryDirectory, 'HunyuanControls.mjs');

  try {
    const source = (await readFile(sourcePath, 'utf8'))
      .replace("import './hunyuan-controls.css';", '')
      .replace(
        "from './hunyuan-settings.js'",
        `from '${pathToFileURL(path.join(repositoryRoot, 'src', 'hunyuan-settings.js')).href}'`,
      );
    const transformed = await transformWithEsbuild(source, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    await writeFile(outputPath, transformed.code, 'utf8');
    const { default: HunyuanControls } = await import(pathToFileURL(outputPath).href);
    const render = (draft) =>
      renderToStaticMarkup(React.createElement(HunyuanControls, { draft, onChange: () => {} }));

    const valid = render({});
    assert.match(valid, /Octree resolution/);
    assert.match(valid, /128 samples per axis/);
    assert.match(valid, /tested/);
    assert.match(valid, /experimental/);
    assert.match(valid, /Denoising steps/);
    assert.match(valid, /default is 30/);
    assert.match(valid, /id="hunyuan-resolution-help"/);
    assert.match(valid, /aria-describedby="hunyuan-steps-help"/);
    assert.doesNotMatch(valid, /aria-invalid="true"/);

    assert.match(valid, /Paint texture \(experimental\)/);
    assert.doesNotMatch(valid, /Texture map size/);
    const painted = render({ texture: true, textureSize: 1024 });
    assert.match(painted, /checked=""/);
    assert.match(painted, /Texture map size/);
    assert.match(painted, /<option value="1024" selected="">/);

    const invalid = render({ shapeSteps: '2.5', resolution: 192 });
    assert.match(invalid, /aria-invalid="true"/);
    assert.match(invalid, /whole number from 1 to 100/);
    assert.match(invalid, /Choose 128, 256, or 384 samples per axis/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
