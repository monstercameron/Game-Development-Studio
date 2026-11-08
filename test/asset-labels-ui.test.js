import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer, transformWithEsbuild } from 'vite';
import { assetNoun, friendlyAssetLabel, promptSnippet } from '../src/asset-labels.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const generated = 'forge-4be74c56-1111-4222-8333-444455556666';

test('generated files get a label from the stored prompt and keep their real file name', () => {
  const asset = { id: `Images/${generated}.png`, name: `${generated}.png`, category: 'Images' };
  const withPrompt = friendlyAssetLabel(asset, {
    prompt: '  A weathered   wooden barrel with iron bands, stylised game prop  ',
  });
  assert.equal(withPrompt.label, 'A weathered wooden barrel with iron…');
  assert.equal(withPrompt.fileName, `${generated}.png`);
  assert.equal(withPrompt.secondary, `${generated}.png`);
  assert.equal(withPrompt.isGenerated, true);

  assert.equal(friendlyAssetLabel(asset, undefined).label, 'Image 4be74c56');
  assert.equal(friendlyAssetLabel(asset, { prompt: '   ' }).label, 'Image 4be74c56');
  assert.equal(friendlyAssetLabel(asset, { prompt: 'Short prompt' }).label, 'Short prompt');
});

test('files that a person named keep their own name, and the noun follows the folder', () => {
  const named = { id: 'Images/hero-portrait.png', name: 'hero-portrait.png', category: 'Images' };
  assert.deepEqual(friendlyAssetLabel(named, { prompt: 'ignored' }), {
    label: 'hero-portrait.png',
    fileName: 'hero-portrait.png',
    secondary: 'Images/hero-portrait.png',
    isGenerated: false,
  });
  assert.equal(assetNoun({ id: 'music/a.wav', category: 'Audio' }), 'Track');
  assert.equal(assetNoun({ id: 'sfx/a.wav', category: 'Audio' }), 'Sound');
  assert.equal(assetNoun({ id: 'voices/a.wav', category: 'Audio' }), 'Voice');
  assert.equal(assetNoun({ id: 'masks/a.png', category: 'Masks' }), 'Cutout');
  assert.equal(assetNoun({ id: '3d/a.glb', category: '3D' }), '3D model');
  assert.equal(promptSnippet(undefined), '');
});

async function withDom(callback) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const names = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const set = (name, value) =>
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  set('window', dom.window);
  set('document', dom.window.document);
  set('navigator', dom.window.navigator);
  set('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    await callback({ dom, set });
  } finally {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  }
}

test('the asset thumbnail shows a loading skeleton, then the picture, then a no-preview state', async () => {
  await withDom(async ({ dom, set }) => {
    let finishLookup;
    set(
      'fetch',
      () =>
        new Promise((resolve) => {
          finishLookup = () => resolve({ ok: true });
        }),
    );
    const vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    });
    let root;
    try {
      const { default: AssetThumbnail } = await vite.ssrLoadModule('/src/AssetThumbnail.jsx');
      const container = document.querySelector('#root');
      root = createRoot(container);
      await act(async () => {
        root.render(
          React.createElement(AssetThumbnail, {
            asset: {
              id: 'Images/a.png',
              category: 'Images',
              modified: '1',
              size: 2,
              name: 'a.png',
            },
            project: { id: 'project-one' },
          }),
        );
      });
      const placeholder = () => container.querySelector('.asset-thumbnail-placeholder');
      assert.equal(placeholder().getAttribute('data-state'), 'loading');
      assert.match(placeholder().textContent, /Preparing preview/);

      await act(async () => {
        finishLookup();
      });
      const image = container.querySelector('img');
      assert.ok(image, 'the picture replaces the placeholder once it is found');
      assert.equal(placeholder(), null);

      await act(async () => {
        image.dispatchEvent(new dom.window.Event('error'));
      });
      assert.equal(container.querySelector('img'), null);
      assert.equal(placeholder().getAttribute('data-state'), 'failed');
      assert.match(placeholder().textContent, /Preview unavailable/);
      assert.equal(placeholder().getAttribute('title'), 'Preview unavailable');
    } finally {
      if (root) {
        await act(async () => root.unmount());
      }
      await vite.close();
    }
  });
});

// The library keeps these components inside Gallery.jsx, so the test cuts them out of the source.
async function loadGalleryParts(temporaryDirectory) {
  const sourcePath = path.join(repositoryRoot, 'src', 'Gallery.jsx');
  const source = await readFile(sourcePath, 'utf8');
  const start = source.indexOf('function NativeImageThumb');
  const end = source.indexOf('function AssetPreview(');
  assert.ok(start >= 0 && end > start);
  const prelude = `
    import React, { useEffect, useState } from 'react';
    const Image = () => null;
  `;
  const transformed = await transformWithEsbuild(
    `${prelude}\n${source.slice(start, end)}\nexport { NativeImageThumb };`,
    sourcePath,
    { loader: 'jsx', jsx: 'automatic' },
  );
  const modulePath = path.join(temporaryDirectory, 'GalleryThumb.mjs');
  await writeFile(modulePath, transformed.code, 'utf8');
  return import(pathToFileURL(modulePath).href);
}

test('library image cards show a skeleton until the picture loads and a message if it fails', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.labels-ui-'));
  try {
    await withDom(async ({ dom }) => {
      const { NativeImageThumb } = await loadGalleryParts(temporaryDirectory);
      const container = document.querySelector('#root');
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(React.createElement(NativeImageThumb, { asset: { file: '/a.png' } }));
        });
        assert.ok(container.querySelector('.asset-skeleton'), 'a skeleton marks the empty box');
        const image = container.querySelector('img');
        await act(async () => {
          image.dispatchEvent(new dom.window.Event('load'));
        });
        assert.equal(container.querySelector('.asset-skeleton'), null);

        await act(async () => {
          root.render(React.createElement(NativeImageThumb, { asset: { file: '/b.png' } }));
        });
        assert.ok(container.querySelector('.asset-skeleton'), 'a new file starts loading again');
        await act(async () => {
          container.querySelector('img').dispatchEvent(new dom.window.Event('error'));
        });
        assert.equal(container.querySelector('img'), null);
        assert.equal(
          container.querySelector('[role="img"]').getAttribute('aria-label'),
          'Preview unavailable',
        );
      } finally {
        await act(async () => root.unmount());
      }
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('the skeleton animation is switched off for people who prefer reduced motion', async () => {
  const css = await readFile(path.join(repositoryRoot, 'src', 'asset-thumbnail.css'), 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.asset-skeleton/);
  assert.match(reduced, /animation:\s*none/);
});

test('Recent creations captions a generated file with its prompt and keeps the file name', async () => {
  await withDom(async ({ set }) => {
    const assetPath = `images/${generated}.png`;
    const requests = [];
    set('fetch', async (input) => {
      const url = String(input);
      requests.push(url);
      const body = url.includes('/assets/details-index')
        ? { assets: { [assetPath]: { prompt: 'A castle on a hill at dusk, oil painting' } } }
        : url === '/api/runtime/jobs'
          ? { jobs: [] }
          : { metadata: null };
      return { ok: true, json: async () => body };
    });
    const vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      ssr: { noExternal: ['react-router'] },
      server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    });
    let root;
    try {
      const { MemoryRouter } = await vite.ssrLoadModule('react-router');
      const { default: PreviewArea } = await vite.ssrLoadModule('/src/PreviewArea.jsx');
      const container = document.querySelector('#root');
      root = createRoot(container);
      const project = {
        id: 'project-one',
        name: 'Castle',
        updatedAt: '2026-11-08',
        assets: [
          {
            id: assetPath,
            name: `${generated}.png`,
            url: '/asset.png',
            category: 'Images',
            modified: '1',
            size: 2,
          },
        ],
      };
      await act(async () => {
        root.render(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(PreviewArea, {
              section: 'images',
              project,
              onRefresh: async () => {},
              onOpenLibrary: () => {},
            }),
          ),
        );
      });
      const caption = container.querySelector('.iteration-caption');
      assert.equal(caption.querySelector('strong').textContent, 'A castle on a hill at…');
      assert.equal(caption.querySelector('strong').getAttribute('title'), `${generated}.png`);
      assert.equal(caption.querySelector('span').textContent, `${generated}.png`);
      assert.ok(
        caption.querySelector('a[aria-label="Download A castle on a hill at…"]'),
        'the download link is named after the label and still downloads the real file',
      );
      assert.equal(caption.querySelector('a').getAttribute('download'), `${generated}.png`);
      assert.ok(container.querySelector('.asset-skeleton'), 'the large picture shows a skeleton');
      await act(async () => {
        container.querySelector('.iteration-media img').dispatchEvent(new window.Event('error'));
      });
      assert.match(container.querySelector('.iteration-image-error').textContent, /unavailable/);
      assert.ok(requests.some((url) => url.includes('/assets/details-index')));
    } finally {
      if (root) {
        await act(async () => root.unmount());
      }
      await vite.close();
    }
  });
});

test('the library preview heading uses the friendly name and lists the real file name', async () => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.labels-ui-'));
  try {
    await withDom(async () => {
      const sourcePath = path.join(repositoryRoot, 'src', 'Gallery.jsx');
      const source = await readFile(sourcePath, 'utf8');
      const start = source.indexOf('const categories =');
      const end = source.indexOf('export default function Gallery');
      assert.ok(start >= 0 && end > start);
      const stubs = [
        'TextAssetPreview',
        'InteractiveAssetViewer',
        'AssetThumbnail',
        'AssetConverter',
        'MusicDerive',
        'ProjectTrash',
        'RuntimeQueue',
        'GenerationDetails',
      ]
        .map((name) => `const ${name} = () => null;`)
        .join('\n');
      const icons = [
        'ArrowDownToLine',
        'AudioLines',
        'Box',
        'ChevronDown',
        'ChevronLeft',
        'ChevronRight',
        'Clapperboard',
        'Copy',
        'FileOutput',
        'FileText',
        'FolderOpen',
        'Image',
        'LayoutGrid',
        'List',
        'Pencil',
        'Plus',
        'Search',
        'Star',
        'Trash2',
        'X',
      ]
        .map((name) => `const ${name} = () => null;`)
        .join('\n');
      const prelude = `
        import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
        const useSearchParams = () => [new URLSearchParams(), () => {}];
        const updateSearch = () => {};
        const useRouteToggle = () => [false, () => {}];
        const routeDetails = () => ({});
        const useDialogFocus = () => useRef(null);
        const isVisualAsset = () => false;
        const canConvert = () => false;
        ${stubs}
        ${icons}
      `;
      const transformed = await transformWithEsbuild(
        `${prelude}\n${source.slice(start, end)}\nexport { AssetPreview };`,
        sourcePath,
        { loader: 'jsx', jsx: 'automatic' },
      );
      const modulePath = path.join(temporaryDirectory, 'GalleryPreview.mjs');
      await writeFile(modulePath, transformed.code, 'utf8');
      const { AssetPreview } = await import(pathToFileURL(modulePath).href);
      const container = document.querySelector('#root');
      const root = createRoot(container);
      const asset = {
        id: `Images/${generated}.png`,
        title: `${generated}.png`,
        file: `/api/projects/project-one/assets/${generated}.png`,
        category: 'Images',
        sample: false,
        size: 2048,
        modified: '2026-11-07T12:00:00Z',
      };
      const render = (displayName) =>
        act(async () => {
          root.render(
            React.createElement(AssetPreview, {
              asset,
              displayName,
              position: 0,
              total: 1,
              onClose: () => {},
              onStep: () => {},
              project: { id: 'project-one', folder: 'C:/Forge/Project', name: 'Castle' },
              onMutate: async () => ({}),
              onConverted: () => {},
            }),
          );
        });
      try {
        await render('A castle on a hill');
        const dialog = container.querySelector('[role="dialog"]');
        assert.equal(dialog.querySelector('h2').textContent, 'A castle on a hill');
        assert.equal(dialog.getAttribute('aria-label'), 'Preview A castle on a hill');
        assert.equal(dialog.querySelector('.gallery-file-name code').textContent, asset.title);
        assert.equal(
          dialog.querySelector('a[download]').getAttribute('download'),
          asset.title,
          'the download keeps the stored file name',
        );

        await render('');
        const plain = container.querySelector('[role="dialog"]');
        assert.equal(plain.querySelector('h2').textContent, asset.title);
        assert.equal(plain.querySelector('.gallery-file-name'), null);
      } finally {
        await act(async () => root.unmount());
      }
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
