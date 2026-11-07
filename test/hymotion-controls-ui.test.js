import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('HY-Motion controls expose model limits, defaults, and accessible validation', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  let vite;
  let root;
  const changes = [];

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vite = await createServer({
      configFile: false,
      root: repositoryRoot,
      esbuild: { jsx: 'automatic' },
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null, hmr: false },
    });
    const { default: HyMotionControls } = await vite.ssrLoadModule('/src/HyMotionControls.jsx');
    const container = document.querySelector('#root');
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(HyMotionControls, {
          draft: {},
          onChange: (values) => changes.push(values),
        }),
      );
    });

    assert.equal(container.querySelector('h3')?.textContent, 'Generation settings');
    assert.match(container.textContent, /skeletal BVH clip at 30 fps/);
    assert.match(container.textContent, /rigging and retargeting are separate/);

    const duration = container.querySelector('#hy-motion-duration');
    const steps = container.querySelector('#hy-motion-steps');
    const guidance = container.querySelector('#hy-motion-guidance');
    assert.deepEqual(
      [duration.value, duration.min, duration.max, duration.step],
      ['3', '1', '12', '0.5'],
    );
    assert.deepEqual([steps.value, steps.min, steps.max, steps.step], ['50', '1', '100', '1']);
    assert.deepEqual(
      [guidance.value, guidance.min, guidance.max, guidance.step],
      ['5', '0', '20', '0.5'],
    );
    for (const input of [duration, steps, guidance]) {
      const label = container.querySelector(`label[for="${input.id}"]`);
      assert.ok(label, `${input.id} has an associated visible label`);
      assert.ok(document.getElementById(input.getAttribute('aria-describedby')));
    }

    await act(async () => {
      root.render(
        React.createElement(HyMotionControls, {
          draft: { motionDuration: '13' },
          onChange: (values) => changes.push(values),
        }),
      );
    });
    const invalidDuration = container.querySelector('#hy-motion-duration');
    assert.equal(invalidDuration.getAttribute('aria-invalid'), 'true');
    assert.match(
      document.getElementById('hy-motion-duration-error').textContent,
      /from 1 to 12 seconds/,
    );
    assert.match(invalidDuration.getAttribute('aria-describedby'), /hy-motion-duration-error/);

    await act(async () => {
      root.render(
        React.createElement(HyMotionControls, {
          draft: { motionDuration: '', motionSteps: '2.5', motionGuidance: '0' },
          onChange: (values) => changes.push(values),
        }),
      );
    });
    assert.equal(container.querySelector('#hy-motion-duration').getAttribute('aria-invalid'), null);
    assert.equal(container.querySelector('#hy-motion-steps').getAttribute('aria-invalid'), 'true');
    assert.equal(container.querySelector('#hy-motion-guidance').getAttribute('aria-invalid'), null);
    assert.match(container.textContent, /whole number from 1 to 100/);
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
    if (previousGlobals.actEnvironment === undefined) {
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    } else {
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousGlobals.actEnvironment;
    }
  }
});
