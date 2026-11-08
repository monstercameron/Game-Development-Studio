import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('recent projects select a compact layout for one, two, or many cards', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.recent-projects-'));
  const sourcePath = path.join(repositoryRoot, 'src', 'Projects.jsx');
  const outputPath = path.join(temporaryDirectory, 'Projects.mjs');

  try {
    const source = await readFile(sourcePath, 'utf8');
    const componentStart = source.indexOf('function projectAssetIcon(');
    const componentEnd = source.indexOf('export function NewProjectDialog');
    assert.ok(componentStart >= 0 && componentEnd > componentStart);

    // Only the one component is extracted from src/Projects.jsx, so its icon imports and
    // thumbnail helpers are stubbed to let the extracted markup render without the app.
    const prelude = `
      const AssetThumbnail = () => null;
      const isVisualAsset = () => false;
      const iconStub = () => null;
      const ArrowRight = iconStub;
      const AudioLines = iconStub;
      const Box = iconStub;
      const Clapperboard = iconStub;
      const FileText = iconStub;
      const FolderOpen = iconStub;
      const Image = iconStub;
      const LoaderCircle = iconStub;
      const Plus = iconStub;
    `;
    const extractedSource = `${prelude}\n${source.slice(componentStart, componentEnd)}\n`;
    const transformed = await transformWithEsbuild(extractedSource, sourcePath, {
      loader: 'jsx',
      jsx: 'automatic',
    });
    await writeFile(outputPath, transformed.code, 'utf8');
    const projectsModule = await import(pathToFileURL(outputPath).href);

    const project = (index) => ({
      id: `project-${index}`,
      name: `Project ${index}`,
      updatedAt: '2026-11-07T12:00:00.000Z',
      assets: [{ id: `asset-${index}`, name: `Asset ${index}`, category: 'Text' }],
    });
    const render = (count) =>
      renderToStaticMarkup(
        React.createElement(projectsModule.RecentProjects, {
          projects: Array.from({ length: count }, (_, index) => project(index + 1)),
          loading: false,
          onNew: () => {},
          onOpen: () => {},
          onViewAll: () => {},
        }),
      );

    const cases = [
      [1, 'single'],
      [2, 'pair'],
      [4, 'collection'],
      [8, 'collection'],
    ];
    for (const [count, layout] of cases) {
      const markup = render(count);
      assert.match(markup, new RegExp(`project-grid--${layout}`));
      assert.match(markup, /Project 1/);
      assert.match(markup, /Updated 11\/7\/2026/);
      assert.match(markup, /Asset 1/);
    }
    assert.match(render(8), /data-project-count="6"/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
