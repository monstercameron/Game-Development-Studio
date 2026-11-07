import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('motion preview exposes playback state, labeled controls, and reduced-motion behavior', async () => {
  const component = await readFile(path.join(repositoryRoot, 'src', 'MotionPreview.jsx'), 'utf8');
  const stylesheet = await readFile(path.join(repositoryRoot, 'src', 'motion-preview.css'), 'utf8');

  assert.match(component, /prefers-reduced-motion: reduce/);
  assert.match(component, /motionPreferenceChanged/);
  assert.match(component, /userStartedMotionRef\.current/);
  assert.match(component, /role="group" aria-label="Motion preview controls"/);
  assert.match(component, /aria-label=\{playing \? 'Pause motion' : 'Play motion'\}/);
  assert.match(component, /aria-live="polite"[\s\S]*?Playing[\s\S]*?Paused/);
  assert.match(component, /aria-label="Reset motion view"/);
  assert.match(component, /scroll or pinch to zoom/);

  assert.match(stylesheet, /\.motion-preview \.model-preview-tools button:focus-visible/);
  assert.match(stylesheet, /@media \(max-width: 620px\)/);
  assert.match(stylesheet, /\.motion-preview \.model-preview-canvas\s*\{\s*bottom: 112px;/);
});
