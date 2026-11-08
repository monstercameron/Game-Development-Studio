import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createViewerHarness } from './viewer-test-harness.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const byLabel = (container, label) => container.querySelector(`[aria-label="${label}"]`);
const renderMotion = (harness, MotionPreview, props = {}) =>
  act(async () => {
    harness.root.render(
      React.createElement(MotionPreview, { url: '/walk.bvh', name: 'walk.bvh', ...props }),
    );
  });

test('motion preview exposes labelled playback controls, a scrubber and clip choices', async (t) => {
  const harness = await createViewerHarness(t);
  harness.log.animated = true;
  const { default: MotionPreview } = await harness.load('MotionPreview.jsx');
  const changes = [];
  await renderMotion(harness, MotionPreview, {
    playing: true,
    onPlayingChange: (value) => changes.push(value),
    timeRef: { current: 1.5 },
  });
  await harness.settle();
  const { container, log } = harness;
  const [engine] = log.engines;

  assert.deepEqual(
    engine.calls.slice(0, 1),
    ['selectClip:0:true'],
    'playback resumes at the saved state',
  );
  assert.equal(engine.clip.time, 1.5);
  const bar = container.querySelector('[role="group"][aria-label="Animation playback"]');
  assert.ok(bar);
  const toggle = byLabel(bar, 'Pause animation');
  assert.ok(toggle, 'playing motion offers Pause');
  assert.equal(toggle.getAttribute('aria-keyshortcuts'), 'Space');
  assert.match(bar.querySelector('output').textContent, /0:01\.5 \/ 0:04\.0/);
  const scrub = byLabel(bar, 'Animation position');
  assert.equal(scrub.type, 'range');
  assert.equal(scrub.getAttribute('aria-valuetext'), '0:01.5 of 0:04.0');
  assert.equal(byLabel(bar, 'Animation clip').options.length, 2);
  assert.equal(byLabel(bar, 'Playback speed').value, '1');

  await harness.click(toggle);
  assert.deepEqual(changes, [false], 'the shared playing state is updated');
  assert.ok(byLabel(bar, 'Play animation'), 'the button now offers Play');
  const stage = container.querySelector('.vw-stage');
  await harness.key(stage, ' ');
  assert.deepEqual(changes, [false, true], 'Space toggles playback from the viewport');
  await harness.key(stage, 'o');
  assert.equal(byLabel(container, 'Auto-rotate').getAttribute('aria-pressed'), 'true');
});

test('motion preview does not start moving when reduced motion is requested', async (t) => {
  const harness = await createViewerHarness(t, {
    reducedMotion: true,
    storage: { 'forge.viewer.prefs.v1': JSON.stringify({ autoRotate: true }) },
  });
  harness.log.animated = true;
  const { default: MotionPreview } = await harness.load('MotionPreview.jsx');
  const changes = [];
  await renderMotion(harness, MotionPreview, {
    playing: true,
    onPlayingChange: (value) => changes.push(value),
  });
  await harness.settle();
  const [engine] = harness.log.engines;
  assert.equal(engine.options.reducedMotion, true);
  assert.equal(engine.options.prefs.autoRotate, false, 'a remembered auto-rotate is not applied');
  assert.deepEqual(engine.calls.slice(0, 1), ['selectClip:0:false']);
  assert.deepEqual(changes, [false]);
  assert.equal(byLabel(harness.container, 'Auto-rotate').getAttribute('aria-pressed'), 'false');
  assert.ok(byLabel(harness.container, 'Play animation'));
  await harness.click(byLabel(harness.container, 'Play animation'));
  assert.equal(engine.clip.playing, true, 'the user can still start motion deliberately');
});

test('motion loading and the viewer style sheet honour reduced motion and focus visibility', async () => {
  const stylesheet = await readFile(path.join(repositoryRoot, 'src', 'ux-viewer.css'), 'utf8');
  const engineSource = await readFile(path.join(repositoryRoot, 'src', 'viewer-engine.js'), 'utf8');
  const viewerSource = await readFile(path.join(repositoryRoot, 'src', 'ThreeViewer.jsx'), 'utf8');
  assert.match(stylesheet, /\.vw :focus-visible/);
  assert.match(stylesheet, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stylesheet, /@media \(forced-colors: active\)/);
  assert.match(viewerSource, /prefers-reduced-motion: reduce/);
  assert.match(engineSource, /reducedMotion/, 'camera transitions are skipped for reduced motion');
  assert.match(engineSource, /document\.hidden/, 'rendering pauses in background tabs');
});
