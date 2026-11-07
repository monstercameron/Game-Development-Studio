import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function mountPreview(t, rendererFails = false) {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.model-preview-ui-'));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {};
  const names = [
    'window',
    'document',
    'navigator',
    'getComputedStyle',
    'fetch',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  for (const name of names) {
    previousGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(globalThis, 'getComputedStyle', {
    configurable: true,
    value: dom.window.getComputedStyle.bind(dom.window),
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => ({
      ok: true,
      headers: { get: () => '4' },
      arrayBuffer: async () => new ArrayBuffer(4),
    }),
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });

  const sourcePath = path.join(repositoryRoot, 'src', 'ModelPreview.jsx');
  const source = await readFile(sourcePath, 'utf8');
  const component = source.replace(/^import .*;\r?\n/gm, '');
  const prelude = `
    import React, { useEffect, useId, useRef, useState } from 'react';
    const Box = () => null;
    const RotateCcw = () => null;
    const RotateCw = () => null;
    const ZoomIn = () => null;
    const ZoomOut = () => null;
    const vector = () => ({
      x: 0, y: 0, z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
      clone() { return Object.assign(vector(), this); },
      sub() { return this; },
      add() { return this; },
      applyAxisAngle() { return this; },
      length() { return 1; },
      setLength() { return this; },
    });
    const THREE = {
      WebGLRenderer: class {
        constructor() {
          if (${rendererFails}) throw Error('WebGL is unavailable.');
          this.domElement = document.createElement('canvas');
        }
        setPixelRatio() {}
        setSize() {}
        render() {}
        dispose() {}
        forceContextLoss() {}
      },
      Scene: class { add() {} },
      PerspectiveCamera: class {
        constructor() { this.position = vector(); this.fov = 38; }
        updateProjectionMatrix() {}
      },
      HemisphereLight: class {},
      DirectionalLight: class { constructor() { this.position = vector(); } },
      Box3: class {
        setFromObject() { return this; }
        isEmpty() { return false; }
        getCenter(target) { return target.set(0, 0, 0); }
        getSize(target) { return target.set(1, 1, 1); }
      },
      Vector3: class {
        constructor() { Object.assign(this, vector()); }
      },
      LoadingManager: class { setURLModifier() {} },
      MathUtils: {
        degToRad(value) { return value * Math.PI / 180; },
        clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); },
      },
      SRGBColorSpace: 'srgb',
      ACESFilmicToneMapping: 1,
    };
    class OrbitControls {
      constructor() { this.target = vector(); this.minDistance = 0; this.maxDistance = 1; }
      addEventListener() {}
      update() {}
      saveState() {}
      reset() {}
      dispose() {}
    }
    class GLTFLoader {
      async parseAsync() {
        return { scene: { position: vector(), traverse() {} } };
      }
    }
    class FBXLoader {}
    const parsePlyPreview = () => null;
  `;
  const transformed = await transformWithEsbuild(`${prelude}\n${component}`, sourcePath, {
    loader: 'jsx',
    jsx: 'automatic',
  });
  const modulePath = path.join(temporaryDirectory, 'ModelPreview.mjs');
  await writeFile(modulePath, transformed.code, 'utf8');
  const { default: ModelPreview } = await import(pathToFileURL(modulePath).href);
  const container = dom.window.document.querySelector('#root');
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of Object.entries(previousGlobals)) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  });
  return { container, root, ModelPreview };
}

test('3D preview exposes keyboard controls and clear operating instructions', async (t) => {
  const { container, root, ModelPreview } = await mountPreview(t);
  await act(async () => {
    root.render(React.createElement(ModelPreview, { url: '/asset.glb', name: 'asset.glb' }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  assert.equal(container.querySelector('[role="status"]')?.textContent, undefined);
  const canvas = container.querySelector('[role="img"]');
  const hint = container.querySelector('.model-preview-hint');
  assert.ok(canvas.getAttribute('aria-describedby'));
  assert.ok(hint.textContent.includes('Use the controls for keyboard operation.'));
  const controls = container.querySelector('[role="group"][aria-label="3D preview controls"]');
  assert.ok(controls);
  assert.ok(controls.querySelector('button[aria-label="Reset 3D preview"]'));
  assert.equal(controls.querySelectorAll('button').length, 5);
});

test('WebGL setup failures are announced as errors', async (t) => {
  const { container, root, ModelPreview } = await mountPreview(t, true);
  await act(async () => {
    root.render(React.createElement(ModelPreview, { url: '/asset.glb', name: 'asset.glb' }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  assert.equal(container.querySelector('[role="alert"]')?.textContent, 'WebGL is unavailable.');
  assert.equal(container.querySelector('.model-preview-tools'), null);
});
