import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createViewerHarness } from './viewer-test-harness.js';

async function mountViewer(t, props) {
  const harness = await createViewerHarness(t);
  // jsdom has no layout; the dialog's modal detection and focus trap need non-empty boxes.
  harness.dom.window.HTMLElement.prototype.getClientRects = function getClientRects() {
    return this.isConnected ? [{ width: 100, height: 40 }] : [];
  };
  harness.dom.window.HTMLElement.prototype.getBoundingClientRect =
    function getBoundingClientRect() {
      return this.isConnected
        ? { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 }
        : { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
    };
  const { default: InteractiveAssetViewer } = await harness.load('InteractiveAssetViewer.jsx');
  harness.show = async (nextProps = props) => {
    await act(async () => {
      harness.root.render(
        React.createElement(InteractiveAssetViewer, { url: '/b.glb', name: 'b.glb', ...nextProps }),
      );
    });
    await harness.waitFor(() => harness.container.querySelector('.vw-stage'), 'the viewer stage');
    await harness.settle();
  };
  await harness.show(props);
  return harness;
}

test('the inline viewer steps through 3D assets and shows its position', async (t) => {
  const steps = [];
  const harness = await mountViewer(t, {
    navigation: { index: 1, total: 3, onStep: (offset) => steps.push(offset) },
    size: 2048,
  });
  const { container } = harness;
  const nav = container.querySelector('[role="group"][aria-label="3D asset navigation"]');
  assert.ok(nav);
  assert.equal(nav.querySelector('.vw-nav-count').textContent, '2 / 3');
  const previous = nav.querySelector('[aria-label="Previous 3D asset"]');
  const next = nav.querySelector('[aria-label="Next 3D asset"]');
  assert.equal(previous.getAttribute('aria-keyshortcuts'), 'ArrowLeft');
  assert.match(next.getAttribute('data-tip'), /Next 3D asset/);
  await harness.click(next);
  await harness.click(previous);
  assert.deepEqual(steps, [1, -1]);

  const stage = container.querySelector('.vw-stage');
  await harness.key(stage, 'ArrowRight');
  assert.deepEqual(steps, [1, -1, 1], 'arrow keys inside the viewer navigate too');
});

test('navigation stops at the ends of the list and is hidden for a single asset', async (t) => {
  const steps = [];
  const harness = await mountViewer(t, {
    navigation: { index: 0, total: 2, onStep: (offset) => steps.push(offset) },
  });
  const previous = harness.container.querySelector('[aria-label="Previous 3D asset"]');
  assert.equal(previous.getAttribute('aria-disabled'), 'true');
  await harness.click(previous);
  assert.deepEqual(steps, [], 'the first asset has no previous one');

  await harness.show({ navigation: { index: 0, total: 1, onStep() {} } });
  assert.equal(harness.container.querySelector('.vw-nav'), null);
});

test('the large viewer keeps navigating, controlling the model and trapping arrows', async (t) => {
  const steps = [];
  const harness = await mountViewer(t, {
    navigation: { index: 1, total: 3, onStep: (offset) => steps.push(offset) },
  });
  await harness.click(harness.container.querySelector('.inspection-expand'));
  await harness.waitFor(
    () => harness.dom.window.document.querySelector('.inspection-dialog .vw-stage'),
    'the large viewer',
  );
  await harness.settle();
  const dialog = harness.dom.window.document.querySelector('.inspection-dialog');
  assert.ok(dialog);
  assert.ok(dialog.querySelector('.vw[data-mode="workbench"]'), 'the dialog hosts the workbench');
  assert.ok(dialog.querySelector('.vw-inspector'), 'the inspector is docked and open by default');
  assert.equal(dialog.querySelector('.inspection-header .vw-nav-count').textContent, '2 / 3');

  const leaked = [];
  harness.dom.window.addEventListener('keydown', (event) => leaked.push(event.key));
  const close = dialog.querySelector('.inspection-close');
  close.focus();
  await harness.key(close, 'ArrowRight');
  assert.deepEqual(steps, [1], 'arrow keys on the Close button switch asset');
  assert.deepEqual(leaked, [], 'the library behind the dialog never sees the arrow');

  await harness.key(close, 'g');
  const grid = dialog.querySelector('[aria-label="Grid"]');
  assert.equal(
    grid.getAttribute('aria-pressed'),
    'false',
    'shortcuts work from anywhere in the dialog',
  );
  const [engine] = harness.log.engines.slice(-1);
  assert.equal(engine.applied.at(-1).grid, false);

  await harness.key(dialog.querySelector('.vw-stage'), 'ArrowLeft', { shiftKey: true });
  assert.ok(engine.calls.includes('orbit:1,0'));
  assert.deepEqual(steps, [1], 'Shift+arrow orbits instead of switching asset');
});
