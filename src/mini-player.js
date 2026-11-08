// Module-level store for the persistent mini player. It is shaped for
// useSyncExternalStore: getSnapshot() returns a stable object that only changes
// identity when something observable changes.
//
// The media element owns the live playback position. Whoever hands playback to
// (or back from) the mini player passes the current time and playing state, so
// the store only ever holds the hand-off values.

export const MINI_PLAYER_STORAGE_KEYS = {
  minimized: 'forge.miniPlayer.minimized',
  position: 'forge.miniPlayer.position',
  repeat: 'forge.miniPlayer.repeat',
};

// Repeat modes: never = play through and stop, once = play through then repeat exactly one
// more time, loop = repeat forever. The logic below is pure so it can be tested without a DOM.
export const REPEAT_MODES = ['never', 'once', 'loop'];
const REPEAT_NAMES = { never: 'Never', once: 'Once', loop: 'Loop' };
const ONCE_REPEATS = 1;
const RESTART_WINDOW_SECONDS = 0.25;

export function normalizeRepeatMode(mode) {
  return REPEAT_MODES.includes(mode) ? mode : 'never';
}
export function nextRepeatMode(mode) {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(normalizeRepeatMode(mode)) + 1) % REPEAT_MODES.length];
}
export function repeatName(mode) {
  return REPEAT_NAMES[normalizeRepeatMode(mode)];
}
export function repeatLabel(mode) {
  return `Repeat: ${repeatName(mode)}. Activate to change.`;
}
export function createRepeatState(mode = 'never') {
  const normalized = normalizeRepeatMode(mode);
  return { mode: normalized, remaining: normalized === 'once' ? ONCE_REPEATS : 0 };
}
// Decision for a media `ended` event. replay=true means seek to 0 and play again. When playback
// stops, the once-counter is re-armed so the next manual play repeats once again.
export function repeatOnEnded(state) {
  if (state.mode === 'loop') {
    return { replay: true, state };
  }
  if (state.mode === 'once' && state.remaining > 0) {
    return { replay: true, state: { ...state, remaining: state.remaining - 1 } };
  }
  return { replay: false, state: createRepeatState(state.mode) };
}
// Seeking back to the start by hand (not by a repeat) re-arms the once-counter.
export function repeatOnSeek(state, time) {
  return time <= RESTART_WINDOW_SECONDS ? createRepeatState(state.mode) : state;
}

const RETURN_WINDOW_MS = 15000;
const kinds = new Set(['audio', 'video']);
const listeners = new Set();
let sequence = 0;
let state = {
  item: null,
  minimized: readMinimized(),
  repeat: readRepeat(),
  pendingReturn: null,
};

function storage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
function readMinimized() {
  try {
    return storage()?.getItem(MINI_PLAYER_STORAGE_KEYS.minimized) === '1';
  } catch {
    return false;
  }
}
function readRepeat() {
  try {
    return normalizeRepeatMode(storage()?.getItem(MINI_PLAYER_STORAGE_KEYS.repeat));
  } catch {
    return 'never';
  }
}
function persistMinimized(value) {
  try {
    storage()?.setItem(MINI_PLAYER_STORAGE_KEYS.minimized, value ? '1' : '0');
  } catch {
    // Storage can be unavailable (private windows); the state still works in memory.
  }
}
function set(next) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) {
    listener();
  }
}
function finiteTime(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getSnapshot() {
  return state;
}
export function getServerSnapshot() {
  return { item: null, minimized: false, repeat: 'never', pendingReturn: null };
}

// Opening replaces whatever was playing: there is only ever one mini player.
export function open({ kind, url, name, time = 0, playing = false, origin = null } = {}) {
  if (!kinds.has(kind) || typeof url !== 'string' || !url) {
    return null;
  }
  const item = {
    id: ++sequence,
    kind,
    url,
    name: String(name || url.split('/').pop() || 'Untitled'),
    time: finiteTime(time),
    playing: Boolean(playing),
    origin: origin || null,
  };
  set({ item, pendingReturn: null });
  return item;
}

// Stops playback. Closing never resumes the inline preview.
export function close() {
  if (state.item) {
    set({ item: null });
  }
}

// "Back to full preview": removes the mini player and remembers where playback
// was so the inline element can continue from there. Returns the page it came from.
export function requestExpand({ time, playing } = {}) {
  const item = state.item;
  if (!item) {
    return null;
  }
  set({
    item: null,
    pendingReturn: {
      token: ++sequence,
      at: Date.now(),
      url: item.url,
      time: finiteTime(time ?? item.time),
      playing: Boolean(playing),
    },
  });
  return item.origin;
}

// Called by an inline element showing `url`. Returns the playback to resume once.
export function consumeReturn(url) {
  const pending = state.pendingReturn;
  if (!pending || pending.url !== url) {
    return null;
  }
  if (Date.now() - pending.at > RETURN_WINDOW_MS) {
    // The user never came back to this preview; do not start playback out of nowhere later.
    set({ pendingReturn: null });
    return null;
  }
  set({ pendingReturn: null });
  return pending;
}

export function setMinimized(value) {
  const minimized = Boolean(value);
  persistMinimized(minimized);
  if (minimized !== state.minimized) {
    set({ minimized });
  }
}

// The repeat mode is global, so it carries over untouched when playback moves between an
// inline preview and the mini player (and survives reloads).
export function setRepeat(mode) {
  const repeat = normalizeRepeatMode(mode);
  try {
    storage()?.setItem(MINI_PLAYER_STORAGE_KEYS.repeat, repeat);
  } catch {
    // The mode still applies for this page view.
  }
  if (repeat !== state.repeat) {
    set({ repeat });
  }
}
export function cycleRepeat() {
  setRepeat(nextRepeatMode(state.repeat));
}

// Test hook: restores the pristine store.
export function resetMiniPlayer() {
  state = { item: null, minimized: false, repeat: 'never', pendingReturn: null };
  for (const listener of [...listeners]) {
    listener();
  }
}

export function loadPosition() {
  try {
    const value = JSON.parse(storage()?.getItem(MINI_PLAYER_STORAGE_KEYS.position) || 'null');
    return Number.isFinite(value?.right) && Number.isFinite(value?.bottom) ? value : null;
  } catch {
    return null;
  }
}
export function savePosition(position) {
  try {
    storage()?.setItem(MINI_PLAYER_STORAGE_KEYS.position, JSON.stringify(position));
  } catch {
    // Remembering the position is a convenience only.
  }
}

// Keeps a dock of `size` fully inside the viewport. Offsets are distances from the
// bottom-right corner, so they survive window resizes without jumping.
export function clampPosition({ right, bottom }, size, viewport, margin = 8) {
  const maxRight = Math.max(margin, viewport.width - size.width - margin);
  const maxBottom = Math.max(margin, viewport.height - size.height - margin);
  return {
    right: Math.min(Math.max(margin, Math.round(right)), maxRight),
    bottom: Math.min(Math.max(margin, Math.round(bottom)), maxBottom),
  };
}

export function formatTime(seconds) {
  const total = Math.floor(finiteTime(seconds));
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, '0');
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(minutes % 60).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}
