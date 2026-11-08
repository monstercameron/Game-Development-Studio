import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createViewerHarness } from './viewer-test-harness.js';

const byLabel = (container, label) => container.querySelector(`[aria-label="${label}"]`);
const render = (harness, ModelPreview, props = {}) =>
  act(async () => {
    harness.root.render(
      React.createElement(ModelPreview, { url: '/asset.glb', name: 'asset.glb', ...props }),
    );
  });

test('3D preview offers a labelled, keyboard-operable toolbar with persistent toggles', async (t) => {
  const harness = await createViewerHarness(t);
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview);
  await harness.settle();
  const { container, log } = harness;

  assert.equal(log.loads.length, 1);
  assert.equal(log.engines.length, 1);
  assert.equal(container.querySelector('[role="alert"]'), null);
  const toolbar = container.querySelector('[role="group"][aria-label="3D viewer tools"]');
  assert.ok(toolbar, 'the toolbar is a labelled group');
  for (const label of [
    'Reset view',
    'Frame model',
    'Auto-rotate',
    'Wireframe',
    'Grid',
    'Axes',
    'Bounding box',
    'Ground shadow',
    'Download PNG snapshot',
    'Inspector',
  ]) {
    const button = byLabel(toolbar, label);
    assert.ok(button, `${label} button`);
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('type'), 'button');
    assert.ok(button.getAttribute('data-tip'), `${label} has a tooltip`);
  }
  for (const label of ['Camera view', 'Lighting preset', 'Background']) {
    assert.equal(byLabel(toolbar, label)?.tagName, 'SELECT', label);
  }
  assert.equal(byLabel(toolbar, 'Grid').getAttribute('aria-pressed'), 'true');
  assert.equal(byLabel(toolbar, 'Wireframe').getAttribute('aria-pressed'), 'false');
  assert.equal(byLabel(toolbar, 'Wireframe').getAttribute('aria-keyshortcuts'), 'W');

  const stage = container.querySelector('.vw-stage');
  assert.equal(stage.getAttribute('tabindex'), '0');
  assert.match(
    container.ownerDocument.getElementById(stage.getAttribute('aria-describedby')).textContent,
    /plus and minus to zoom/,
  );

  const [engine] = log.engines;
  await harness.click(byLabel(toolbar, 'Wireframe'));
  assert.equal(byLabel(toolbar, 'Wireframe').getAttribute('aria-pressed'), 'true');
  assert.equal(engine.applied.at(-1).wireframe, true, 'the engine receives the new preference');
  assert.equal(JSON.parse(localStorage.getItem('forge.viewer.prefs.v1')).wireframe, true);

  await harness.key(stage, 'g');
  assert.equal(byLabel(toolbar, 'Grid').getAttribute('aria-pressed'), 'false');
  assert.equal(engine.applied.at(-1).grid, false);

  await harness.key(stage, '5');
  await harness.key(stage, 'ArrowLeft', { shiftKey: true });
  await harness.key(stage, 'ArrowRight', { ctrlKey: true });
  await harness.key(stage, '+', { shiftKey: true });
  await harness.key(stage, 'r');
  await harness.key(stage, 'f');
  await harness.key(stage, 'p');
  assert.deepEqual(engine.calls.slice(0, 7), [
    'view:top',
    'orbit:1,0',
    'pan:1,0',
    'zoom:0.8',
    'reset',
    'frame',
    'snapshot',
  ]);
  assert.match(container.querySelector('[role="status"][aria-live="polite"]').textContent, /./);

  await harness.key(stage, 'l');
  assert.equal(byLabel(toolbar, 'Lighting preset').value, 'neutral');
  await harness.key(stage, 'c');
  assert.equal(container.querySelector('.vw').getAttribute('data-background'), 'light');
});

test('the inspector lists asset details and the shortcut reference', async (t) => {
  const harness = await createViewerHarness(t);
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview, { meta: { size: 1212164 } });
  await harness.settle();
  const { container } = harness;
  assert.equal(container.querySelector('.vw-inspector'), null, 'the inline viewer starts compact');
  await harness.key(container.querySelector('.vw-stage'), 'i');
  const inspector = container.querySelector('aside[aria-label="Inspector"]');
  assert.ok(inspector);
  assert.match(inspector.textContent, /GLB · glTF binary/);
  assert.match(inspector.textContent, /1\.2 MB/);
  assert.match(inspector.textContent, /Triangles/);
  assert.match(inspector.textContent, /1 × 2 × 3/);
  assert.equal(inspector.querySelector('input[aria-label="Auto-rotate speed"]').type, 'range');
  assert.ok(inspector.querySelector('details.vw-shortcuts kbd'));
  await harness.key(container.querySelector('.vw-stage'), '?');
  assert.equal(inspector.querySelector('details.vw-shortcuts').open, true);
});

test('shortcuts hand arrow keys to asset navigation and leave them alone without it', async (t) => {
  const harness = await createViewerHarness(t);
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  const steps = [];
  await render(harness, ModelPreview, {
    chrome: { mode: 'inline', nav: { index: 1, total: 3, onStep: (offset) => steps.push(offset) } },
  });
  await harness.settle();
  const stage = harness.container.querySelector('.vw-stage');
  await harness.key(stage, 'ArrowLeft');
  await harness.key(stage, 'ArrowRight');
  assert.deepEqual(steps, [-1, 1]);
  assert.equal(harness.log.engines[0].calls.length, 0, 'plain arrows never move the camera');

  const bubbled = [];
  harness.container.addEventListener('keydown', (event) => bubbled.push(event.key));
  await render(harness, ModelPreview, { chrome: { mode: 'inline' } });
  await harness.settle();
  await harness.key(harness.container.querySelector('.vw-stage'), 'ArrowLeft');
  assert.deepEqual(bubbled, ['ArrowLeft'], 'without siblings the key stays available to the page');
});

test('WebGL setup failures are announced with a retry and a download link', async (t) => {
  const harness = await createViewerHarness(t);
  harness.log.engineFails = true;
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview);
  await harness.settle();
  const { container, log } = harness;

  const alert = container.querySelector('[role="alert"]');
  assert.match(alert.textContent, /3D graphics are unavailable/);
  assert.match(alert.textContent, /hardware acceleration/);
  assert.equal(log.loads.length, 0, 'no file is downloaded when WebGL cannot start');
  assert.equal(alert.querySelector('a[download]').getAttribute('href'), '/asset.glb');
  assert.equal(byLabel(container, 'Reset view').getAttribute('aria-disabled'), 'true');

  log.engineFails = false;
  await harness.click(
    [...alert.querySelectorAll('button')].find((b) => /Try again/.test(b.textContent)),
  );
  await harness.settle();
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(log.engines.length, 1);
  assert.equal(byLabel(container, 'Reset view').getAttribute('aria-disabled'), null);
});

test('load failures explain what to do and release the engine', async (t) => {
  const harness = await createViewerHarness(t);
  const { ViewerError } = await harness.load('viewer-core.js');
  harness.log.sourceError = new ViewerError('EMPTY', 'This 3D file has no visible geometry.');
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview);
  await harness.settle();
  const alert = harness.container.querySelector('[role="alert"]');
  assert.match(alert.textContent, /Nothing to show/);
  assert.match(alert.textContent, /no visible geometry/);
  assert.equal(
    [...alert.querySelectorAll('button')].some((b) => /Try again/.test(b.textContent)),
    false,
    'an empty file cannot be fixed by retrying',
  );
  assert.equal(harness.log.engines[0].disposed, true, 'the failed engine frees its GPU context');
});

test('switching assets and unmounting dispose every engine', async (t) => {
  const harness = await createViewerHarness(t);
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview);
  await harness.settle();
  await render(harness, ModelPreview, { url: '/second.glb', name: 'second.glb' });
  await harness.settle();
  const { log } = harness;
  assert.equal(log.engines.length, 2);
  assert.equal(log.engines[0].disposed, true, 'the previous asset is disposed');
  assert.equal(log.engines[1].disposed, false);
  assert.deepEqual(
    log.loads.map((load) => load.name),
    ['asset.glb', 'second.glb'],
  );
  await act(async () => harness.root.render(null));
  assert.equal(log.engines[1].disposed, true, 'closing the viewer disposes the last engine');
});

test('unsupported formats show an actionable message instead of a viewer', async (t) => {
  const harness = await createViewerHarness(t);
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview, { url: '/model.dae', name: 'model.dae' });
  assert.match(harness.container.textContent, /Preview unavailable/);
  assert.match(harness.container.textContent, /GLB, self-contained glTF, FBX, PLY, OBJ and STL/);
  assert.equal(harness.container.querySelector('.vw'), null);
  assert.equal(harness.log.engines.length, 0);
});
