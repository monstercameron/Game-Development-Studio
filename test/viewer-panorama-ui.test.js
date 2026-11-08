import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createViewerHarness } from './viewer-test-harness.js';

const byLabel = (container, label) => container.querySelector(`[aria-label="${label}"]`);
const insideButton = (container) => byLabel(container, 'View from inside');
const note = (container) => container.querySelector('.vw-panorama-note');

const render = (harness, ModelPreview, props = {}) =>
  act(async () => {
    harness.root.render(
      React.createElement(ModelPreview, { url: '/world.glb', name: 'world.glb', ...props }),
    );
  });

test('ordinary meshes get no panorama control', async (t) => {
  const harness = await createViewerHarness(t);
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview);
  await harness.settle();

  assert.equal(harness.log.loads[0].panoramaHint, false);
  assert.equal(insideButton(harness.container), null);
  assert.equal(note(harness.container), null);
});

test('a WorldGen panorama opens inside by default with a labelled toggle and a note', async (t) => {
  const harness = await createViewerHarness(t);
  harness.log.panorama = true;
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview, { meta: { panorama: true } });
  await harness.settle();
  const { container, log } = harness;

  assert.equal(log.loads[0].panoramaHint, true, 'stored details reach the loader');
  const toolbar = container.querySelector('[role="group"][aria-label="3D viewer tools"]');
  const button = insideButton(toolbar);
  assert.ok(button, 'the View from inside toggle is in the toolbar');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-disabled'), null);
  assert.ok(button.getAttribute('data-tip'), 'the toggle has a tooltip');
  assert.match(note(container).textContent, /viewed from inside/);
  assert.match(
    container.querySelector('.vw-hint').textContent,
    /Drag to look around/,
    'the hint describes inside controls',
  );
});

test('the toggle switches between inside and outside and announces the change', async (t) => {
  const harness = await createViewerHarness(t);
  harness.log.panorama = true;
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview, { meta: { panorama: true } });
  await harness.settle();
  const { container, log } = harness;
  const [engine] = log.engines;

  await harness.click(insideButton(container));
  assert.equal(insideButton(container).getAttribute('aria-pressed'), 'false');
  assert.match(note(container).textContent, /viewed from outside/);
  assert.ok(engine.calls.includes('setPanoramaInside:false'));
  assert.match(
    container.querySelector('.vw-hint').textContent,
    /Drag to orbit/,
    'the hint returns to orbit controls outside',
  );

  await harness.click(insideButton(container));
  assert.equal(insideButton(container).getAttribute('aria-pressed'), 'true');
  assert.match(note(container).textContent, /viewed from inside/);
  assert.ok(engine.calls.includes('setPanoramaInside:true'));
  const live = container.querySelector('.sr-only[aria-live="polite"]');
  assert.match(live.textContent, /Viewing from inside the panorama/);
});

test('a shape-only detection is marked as an inference in the note', async (t) => {
  const harness = await createViewerHarness(t);
  harness.log.panorama = true;
  harness.log.panoramaSource = 'geometry';
  const { default: ModelPreview } = await harness.load('ModelPreview.jsx');
  await render(harness, ModelPreview, { meta: {} });
  await harness.settle();

  assert.equal(harness.log.loads[0].panoramaHint, false, 'no stored details name this file');
  assert.match(note(harness.container).textContent, /Detected from the mesh shape\.$/);
  assert.ok(insideButton(harness.container), 'the toggle is still offered');
});
