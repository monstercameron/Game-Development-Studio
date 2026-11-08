import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('3D assets offer the other mesh formats and list the extra files an OBJ writes', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let vite;
  let root;
  const requests = [];
  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({
          name: 'forge-1-converted.obj',
          path: '3d/forge-1-converted.obj',
          backend: 'trimesh 4.4.7',
          url: '/api/projects/example/asset?path=3d%2Fforge-1-converted.obj',
          extraFiles: [
            { name: 'forge-1-converted.mtl', role: 'material', path: '3d/forge-1-converted.mtl' },
            {
              name: 'forge-1-converted-texture-0.png',
              role: 'texture',
              path: '3d/forge-1-converted-texture-0.png',
            },
          ],
          notes: ['OBJ keeps the base-colour texture; metallic and roughness maps are dropped.'],
        }),
      };
    };
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false },
    });
    const { default: AssetConverter, canConvert } =
      await vite.ssrLoadModule('/src/AssetConverter.jsx');
    assert.equal(canConvert({ id: '3d/a.glb', category: '3D' }), true);
    assert.equal(canConvert({ id: '3d/a.PLY', category: '3D' }), true);
    assert.equal(canConvert({ id: '3d/clip.bvh', category: '3D' }), false);
    assert.equal(canConvert({ id: '3d/a.fbx', category: '3D' }), false);
    assert.equal(canConvert({ id: 'images/a.png', category: 'Images' }), true);

    const container = document.querySelector('#root');
    root = createRoot(container);
    const options = () =>
      [...container.querySelector('select').options].map((option) => option.value);
    await act(async () => {
      root.render(
        React.createElement(AssetConverter, {
          asset: { id: '3d/forge-1.glb', category: '3D' },
          project: { id: 'example' },
        }),
      );
    });
    // Every format except the file's own, with the likely one chosen first.
    assert.deepEqual(options(), ['gltf', 'obj', 'ply', 'stl']);
    assert.equal(container.querySelector('select').value, 'obj');
    assert.match(container.textContent, /\.mtl file and the colour texture as a PNG/);
    assert.match(container.textContent, /Point clouds and Gaussian splats cannot be converted/);
    assert.equal(container.querySelector('input[type="range"]'), null);
    assert.equal(container.querySelector('input[type="color"]'), null);

    await act(async () => {
      container
        .querySelector('form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(requests[0].url, '/api/projects/example/assets/convert');
    assert.equal(requests[0].body.path, '3d/forge-1.glb');
    assert.equal(requests[0].body.format, 'obj');
    const status = container.querySelector('[role="status"]').textContent;
    assert.match(status, /Saved forge-1-converted\.obj/);
    assert.match(
      status,
      /Also saved beside it: forge-1-converted\.mtl, forge-1-converted-texture-0\.png/,
    );
    assert.match(status, /metallic and roughness maps are dropped/);

    for (const [id, expected, first] of [
      ['3d/a.gltf', ['glb', 'obj', 'ply', 'stl'], 'glb'],
      ['3d/a.stl', ['glb', 'gltf', 'obj', 'ply'], 'glb'],
    ]) {
      await act(async () => {
        root.render(
          React.createElement(AssetConverter, {
            asset: { id, category: '3D' },
            project: { id: 'example' },
          }),
        );
      });
      assert.deepEqual(options(), expected);
      assert.equal(container.querySelector('select').value, first);
    }
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    await vite?.close();
    dom.window.close();
    globalThis.window = previousGlobals.window;
    globalThis.document = previousGlobals.document;
    globalThis.fetch = previousGlobals.fetch;
    if (previousGlobals.navigator) {
      Object.defineProperty(globalThis, 'navigator', previousGlobals.navigator);
    } else {
      delete globalThis.navigator;
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
  }
});
