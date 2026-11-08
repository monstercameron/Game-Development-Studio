import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  clampPosition,
  close,
  consumeReturn,
  createRepeatState,
  cycleRepeat,
  formatTime,
  getSnapshot,
  nextRepeatMode,
  normalizeRepeatMode,
  open,
  repeatLabel,
  repeatOnEnded,
  repeatOnSeek,
  requestExpand,
  resetMiniPlayer,
  setMinimized,
  setRepeat,
  subscribe,
} from '../src/mini-player.js';

beforeEach(() => resetMiniPlayer());

test('open hands playback to the mini player with time and playing state', () => {
  const item = open({
    kind: 'audio',
    url: '/a.wav',
    name: 'A',
    time: 12.5,
    playing: true,
    origin: '/assets?project=p',
  });
  assert.deepEqual(
    { ...getSnapshot().item, id: undefined },
    {
      id: undefined,
      kind: 'audio',
      url: '/a.wav',
      name: 'A',
      time: 12.5,
      playing: true,
      origin: '/assets?project=p',
    },
  );
  assert.equal(getSnapshot().item, item);
});

test('open rejects invalid input and normalizes bad times', () => {
  assert.equal(open({ kind: 'image', url: '/a.png' }), null);
  assert.equal(open({ kind: 'audio', url: '' }), null);
  assert.equal(getSnapshot().item, null);
  const item = open({ kind: 'video', url: '/dir/clip.webm', time: NaN });
  assert.equal(item.time, 0);
  assert.equal(item.playing, false);
  assert.equal(item.name, 'clip.webm');
});

test('only one mini player exists: opening replaces the current one', () => {
  const first = open({ kind: 'audio', url: '/a.wav', name: 'A' });
  const second = open({ kind: 'video', url: '/b.webm', name: 'B' });
  assert.notEqual(first.id, second.id);
  assert.equal(getSnapshot().item.url, '/b.webm');
});

test('close removes the player and never queues an inline resume', () => {
  open({ kind: 'audio', url: '/a.wav', time: 4, playing: true });
  close();
  assert.equal(getSnapshot().item, null);
  assert.equal(getSnapshot().pendingReturn, null);
  assert.equal(consumeReturn('/a.wav'), null);
});

test('requestExpand returns the origin and hands the position back exactly once', () => {
  open({ kind: 'audio', url: '/a.wav', time: 1, playing: false, origin: '/music?project=p' });
  const origin = requestExpand({ time: 33.2, playing: true });
  assert.equal(origin, '/music?project=p');
  assert.equal(getSnapshot().item, null);
  assert.equal(consumeReturn('/other.wav'), null);
  const resume = consumeReturn('/a.wav');
  assert.equal(resume.time, 33.2);
  assert.equal(resume.playing, true);
  assert.equal(consumeReturn('/a.wav'), null);
  assert.equal(requestExpand({ time: 1 }), null);
});

test('opening another item discards a stale resume request', () => {
  open({ kind: 'audio', url: '/a.wav' });
  requestExpand({ time: 5, playing: true });
  open({ kind: 'audio', url: '/b.wav' });
  assert.equal(getSnapshot().pendingReturn, null);
});

test('subscribers are notified and snapshots change identity only on change', () => {
  let calls = 0;
  const stop = subscribe(() => calls++);
  const before = getSnapshot();
  close();
  assert.equal(getSnapshot(), before, 'closing nothing is not a change');
  open({ kind: 'audio', url: '/a.wav' });
  setMinimized(true);
  setMinimized(true);
  assert.equal(getSnapshot().minimized, true);
  assert.equal(calls, 2);
  stop();
  close();
  assert.equal(calls, 2);
});

test('minimized preference survives when storage throws', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  try {
    setMinimized(true);
    assert.equal(getSnapshot().minimized, true);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('clampPosition keeps the dock inside the viewport', () => {
  const size = { width: 340, height: 240 };
  const view = { width: 1000, height: 700 };
  assert.deepEqual(clampPosition({ right: -50, bottom: -5 }, size, view), { right: 8, bottom: 8 });
  assert.deepEqual(clampPosition({ right: 5000, bottom: 5000 }, size, view), {
    right: 652,
    bottom: 452,
  });
  assert.deepEqual(clampPosition({ right: 100.4, bottom: 90.6 }, size, view), {
    right: 100,
    bottom: 91,
  });
});

test('formatTime renders minutes and hours', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(Infinity), '0:00');
});

function playThrough(mode, endings) {
  let state = createRepeatState(mode);
  const replays = [];
  for (let index = 0; index < endings; index++) {
    const decision = repeatOnEnded(state);
    state = decision.state;
    replays.push(decision.replay);
  }
  return { replays, state };
}

test('repeat modes cycle never -> once -> loop -> never and normalize junk', () => {
  assert.equal(nextRepeatMode('never'), 'once');
  assert.equal(nextRepeatMode('once'), 'loop');
  assert.equal(nextRepeatMode('loop'), 'never');
  assert.equal(nextRepeatMode('bogus'), 'once');
  assert.equal(normalizeRepeatMode(undefined), 'never');
  assert.equal(repeatLabel('once'), 'Repeat: Once. Activate to change.');
});

test('Never stops at the first end; Once repeats exactly one time; Loop never stops', () => {
  assert.deepEqual(playThrough('never', 3).replays, [false, false, false]);
  // Once: end 1 replays, end 2 stops, then the counter re-arms for the next manual play.
  assert.deepEqual(playThrough('once', 4).replays, [true, false, true, false]);
  assert.deepEqual(playThrough('loop', 50).replays, Array(50).fill(true));
});

test('the once-counter resets on manual seek to start, and only then', () => {
  let state = createRepeatState('once');
  state = repeatOnEnded(state).state;
  assert.equal(state.remaining, 0);
  assert.equal(repeatOnSeek(state, 12), state, 'seeking elsewhere keeps the count');
  state = repeatOnSeek(state, 0);
  assert.equal(state.remaining, 1);
  assert.equal(repeatOnEnded(state).replay, true);
});

test('a mode change or new source starts a fresh counter', () => {
  const used = repeatOnEnded(createRepeatState('once')).state;
  assert.equal(used.remaining, 0);
  assert.equal(createRepeatState('once').remaining, 1);
  assert.equal(createRepeatState('loop').remaining, 0);
  assert.equal(createRepeatState('nonsense').mode, 'never');
});

test('the repeat mode is global, cycles, persists and survives hand-off', () => {
  const stored = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, value),
    },
  });
  try {
    assert.equal(getSnapshot().repeat, 'never');
    cycleRepeat();
    assert.equal(getSnapshot().repeat, 'once');
    assert.equal(stored.get('forge.miniPlayer.repeat'), 'once');
    open({ kind: 'audio', url: '/a.wav' });
    assert.equal(getSnapshot().repeat, 'once', 'opening the mini player keeps the mode');
    requestExpand({ time: 1 });
    assert.equal(getSnapshot().repeat, 'once', 'handing back keeps the mode');
    setRepeat('loop');
    setRepeat('garbage');
    assert.equal(getSnapshot().repeat, 'never');
    assert.equal(stored.get('forge.miniPlayer.repeat'), 'never');
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'localStorage', descriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});
