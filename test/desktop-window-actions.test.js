import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowActions } from '../desktop/window-actions.js';

function fakeWindow() {
  const calls = [];
  const state = { visible: false, minimized: false, destroyed: false };
  const window = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    show: () => {
      calls.push('show');
      state.visible = true;
    },
    focus: () => calls.push('focus'),
    minimize: () => {
      calls.push('minimize');
      state.minimized = true;
    },
    restore: () => {
      calls.push('restore');
      state.minimized = false;
    },
    maximize: () => calls.push('maximize'),
  };
  return { window, state, calls };
}

test('tray commands control the desktop window, including a hidden or minimized window', () => {
  const { window, state, calls } = fakeWindow();
  const actions = createWindowActions(() => window);
  actions.ready();
  calls.length = 0;
  state.visible = false;
  actions.request('maximize');
  assert.deepEqual(calls, ['show', 'maximize', 'focus']);
  calls.length = 0;
  actions.request('minimize');
  assert.deepEqual(calls, ['minimize']);
  calls.length = 0;
  actions.request('open');
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  calls.length = 0;
  actions.request('unknown');
  assert.deepEqual(calls, []);
});

test('a tray action received before the desktop window is ready is not lost', () => {
  const { window, calls } = fakeWindow();
  let current = null;
  const actions = createWindowActions(() => current, 'open');
  actions.request('maximize');
  current = window;
  actions.ready();
  assert.deepEqual(calls, ['show', 'maximize', 'focus']);
});
