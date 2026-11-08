// Pure logic shared by the 3D viewer UI and engine: camera view
// presets, formatting, persisted preferences, keyboard shortcut mapping and error
// descriptions. Nothing here touches three.js, React or the DOM so it can be unit tested.

import { createLog } from './app-log.js';

const log = createLog('three-d');

// ---------------------------------------------------------------------------
// Camera views
// ---------------------------------------------------------------------------

// Left/right are relative to the Front view on screen: "right" puts the camera on +X,
// the side that appears on the right-hand edge of the Front view.
export const VIEW_PRESETS = [
  { id: 'front', label: 'Front', key: '1', direction: [0, 0, 1] },
  { id: 'back', label: 'Back', key: '2', direction: [0, 0, -1] },
  { id: 'left', label: 'Left', key: '3', direction: [-1, 0, 0] },
  { id: 'right', label: 'Right', key: '4', direction: [1, 0, 0] },
  { id: 'top', label: 'Top', key: '5', direction: [0, 1, 0] },
  { id: 'iso', label: 'Isometric', key: '6', direction: [0.75, 0.45, 1] },
];
export const DEFAULT_VIEW = 'iso';

const length = ([x, y, z]) => Math.hypot(x, y, z);
const scale = ([x, y, z], factor) => [x * factor, y * factor, z * factor];

export function viewPreset(id) {
  return VIEW_PRESETS.find((preset) => preset.id === id) || null;
}

// Gaussian splat scenes use a y-down convention. Rotating 180 degrees about X maps a
// normal y-up direction into that frame.
export function viewDirection(id, { flipY = false } = {}) {
  const preset = viewPreset(id) || viewPreset(DEFAULT_VIEW);
  const unit = scale(preset.direction, 1 / length(preset.direction));
  return flipY ? [unit[0], -unit[1], -unit[2]] : unit;
}

export function viewPosition(id, { target = [0, 0, 0], distance = 1, flipY = false } = {}) {
  const direction = viewDirection(id, { flipY });
  return [
    target[0] + direction[0] * distance,
    target[1] + direction[1] * distance,
    target[2] + direction[2] * distance,
  ];
}

// Distance at which a bounding sphere around `size` fits the narrower field of view.
export function fitDistance(size, fovDegrees = 38, aspect = 1, margin = 1.05) {
  const radius = Math.max(length(size) / 2, 1e-9);
  const vertical = (fovDegrees * Math.PI) / 360;
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(aspect, 0.05));
  return (radius / Math.sin(Math.min(vertical, horizontal))) * margin;
}

// Rotates an offset (camera minus target) around the world up axis (azimuth) and tilts
// it (polar), keeping its length and staying clear of the poles.
export function orbitVector(offset, azimuth = 0, polar = 0, { flipY = false } = {}) {
  const [x, y0, z0] = flipY ? [offset[0], -offset[1], -offset[2]] : offset;
  const radius = Math.hypot(x, y0, z0);
  if (radius < 1e-12) {
    return [...offset];
  }
  const theta = Math.atan2(x, z0) + azimuth;
  const phi = Math.min(
    Math.max(Math.acos(Math.min(Math.max(y0 / radius, -1), 1)) + polar, 0.01),
    Math.PI - 0.01,
  );
  const sinPhi = Math.sin(phi) * radius;
  const next = [sinPhi * Math.sin(theta), Math.cos(phi) * radius, sinPhi * Math.cos(theta)];
  return flipY ? [next[0], -next[1], -next[2]] : next;
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function stepIndex(index, total, offset) {
  const next = index + offset;
  return Number.isInteger(index) && next >= 0 && next < total ? next : null;
}

export function cycle(list, current, step = 1) {
  const index = list.indexOf(current);
  return list[(index + step + list.length * 2) % list.length];
}

// ---------------------------------------------------------------------------
// Lighting, background and quality presets
// ---------------------------------------------------------------------------

export const LIGHTING_PRESETS = [
  { id: 'studio', label: 'Studio' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'dark', label: 'Dark' },
];
export const BACKGROUND_PRESETS = [
  { id: 'dark', label: 'Dark', light: false },
  { id: 'light', label: 'Light', light: true },
  { id: 'checker', label: 'Checker', light: false },
  { id: 'transparent', label: 'Transparent', light: false },
];
export const QUALITY_PRESETS = [
  { id: 'fast', label: 'Fast', factor: 0.6, cap: 1 },
  { id: 'balanced', label: 'Balanced', factor: 1, cap: 1.5 },
  { id: 'sharp', label: 'Sharp', factor: 1, cap: 2.5 },
];

// Render-resolution multiplier for a quality preset on a display with the given pixel ratio.
export function qualityPixelRatio(id, devicePixelRatio = 1) {
  const preset = QUALITY_PRESETS.find((candidate) => candidate.id === id) || QUALITY_PRESETS[1];
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(0.5, Math.min(ratio * preset.factor, preset.cap));
}

// Grid spacing is rounded to 1, 2 or 5 times a power of ten so lines read as real units.
export function niceStep(target) {
  if (!(target > 0) || !Number.isFinite(target)) {
    return 1;
  }
  const power = 10 ** Math.floor(Math.log10(target));
  const fraction = target / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2];

// Colours composited behind a downloaded snapshot. Checker and transparent exports keep
// their alpha channel.
export const SNAPSHOT_BACKGROUNDS = { dark: '#1d0f1a', light: '#ece6ea' };

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const PREFS_KEY = 'forge.viewer.prefs.v1';
export const DEFAULT_PREFS = {
  autoRotate: false,
  autoRotateSpeed: 1,
  wireframe: false,
  grid: true,
  axes: false,
  bounds: false,
  ground: true,
  lighting: 'studio',
  background: 'dark',
  quality: 'balanced',
  pointSize: 1,
  splatScale: 1,
  splatPoints: false,
  playbackSpeed: 1,
  inspectorInline: false,
  inspectorWorkbench: true,
};

const BOOLEAN_PREFS = [
  'autoRotate',
  'wireframe',
  'grid',
  'axes',
  'bounds',
  'ground',
  'splatPoints',
  'inspectorInline',
  'inspectorWorkbench',
];
const RANGE_PREFS = {
  autoRotateSpeed: [0.25, 4],
  pointSize: [0.25, 6],
  splatScale: [0.25, 2],
};

export function sanitizePrefs(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const prefs = { ...DEFAULT_PREFS };
  for (const key of BOOLEAN_PREFS) {
    if (typeof source[key] === 'boolean') {
      prefs[key] = source[key];
    }
  }
  for (const [key, [minimum, maximum]] of Object.entries(RANGE_PREFS)) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) {
      prefs[key] = clamp(source[key], minimum, maximum);
    }
  }
  if (LIGHTING_PRESETS.some((preset) => preset.id === source.lighting)) {
    prefs.lighting = source.lighting;
  }
  if (BACKGROUND_PRESETS.some((preset) => preset.id === source.background)) {
    prefs.background = source.background;
  }
  if (QUALITY_PRESETS.some((preset) => preset.id === source.quality)) {
    prefs.quality = source.quality;
  }
  if (PLAYBACK_SPEEDS.includes(source.playbackSpeed)) {
    prefs.playbackSpeed = source.playbackSpeed;
  }
  return prefs;
}

let memoryPrefs = null;

export function loadPrefs(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (raw) {
      memoryPrefs = sanitizePrefs(JSON.parse(raw));
    }
    // log-coverage: ignore -- called from a useState initializer during render; no logging there
  } catch {
    // Storage can be blocked or corrupt; fall back to this session's memory copy.
  }
  return memoryPrefs ? { ...memoryPrefs } : { ...DEFAULT_PREFS };
}

export function savePrefs(prefs, storage = globalThis.localStorage) {
  memoryPrefs = sanitizePrefs(prefs);
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(memoryPrefs));
  } catch (error) {
    log.debug('viewer.prefs.write.failed', { errorClass: error?.name });
    // The preference still holds for this page session.
  }
  return { ...memoryPrefs };
}

export function resetPrefsMemory() {
  memoryPrefs = null;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 ** 3) {
    const megabytes = bytes / 1024 ** 2;
    return `${megabytes.toFixed(megabytes < 100 ? 1 : 0)} MB`;
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString('en-US')
    : '—';
}

export function formatCompact(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  if (abs >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (abs >= 1e6) {
    return `${(value / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`;
  }
  if (abs >= 1e4) {
    return `${(value / 1e3).toFixed(1)}K`;
  }
  return String(Math.round(value));
}

export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return String(Number(value.toFixed(digits)));
}

export function formatDimensions(size) {
  return Array.isArray(size) && size.length === 3 ? size.map(formatNumber).join(' × ') : '—';
}

export function formatTime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return '0:00.0';
  }
  const whole = Math.floor(seconds);
  const tenths = Math.floor((seconds - whole) * 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${tenths}`;
}

const FORMATS = {
  glb: { label: 'GLB', description: 'glTF binary' },
  gltf: { label: 'glTF', description: 'glTF JSON' },
  fbx: { label: 'FBX', description: 'Autodesk FBX' },
  ply: { label: 'PLY', description: 'Polygon file' },
  obj: { label: 'OBJ', description: 'Wavefront OBJ (geometry only in the viewer)' },
  stl: { label: 'STL', description: 'STL triangle mesh' },
  bvh: { label: 'BVH', description: 'Biovision motion' },
};
const KIND_LABELS = {
  mesh: 'Mesh',
  points: 'Point cloud',
  splat: 'Gaussian splat',
  skeleton: 'Animated skeleton',
};

export function fileExtension(name) {
  return /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1].toLowerCase() || '';
}

export function assetFormat(name, kind) {
  const extension = fileExtension(name);
  const format = FORMATS[extension] || {
    label: extension ? extension.toUpperCase() : '3D',
    description: 'Unknown format',
  };
  return {
    extension,
    label: format.label,
    description: format.description,
    kind: kind || null,
    kindLabel: KIND_LABELS[kind] || null,
  };
}

export function snapshotFilename(name, view = 'view') {
  const base =
    String(name || 'model')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'model';
  return `${base}-${String(view).replace(/[^a-z0-9-]+/gi, '') || 'view'}.png`;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

// One table drives both the key handler and the help list shown in the inspector.
export const SHORTCUTS = [
  { keys: ['←', '→'], label: 'Previous / next 3D asset', group: 'Navigate' },
  { keys: ['Shift', '+ arrows'], label: 'Orbit the camera', group: 'Camera' },
  { keys: ['Ctrl', '+ arrows'], label: 'Pan the camera', group: 'Camera' },
  { keys: ['↑', '↓', '+', '−'], label: 'Zoom in / out', group: 'Camera' },
  { keys: ['R'], label: 'Reset view', group: 'Camera' },
  { keys: ['F'], label: 'Frame model', group: 'Camera' },
  { keys: ['1', '–', '6'], label: 'Front, back, left, right, top, isometric', group: 'Camera' },
  { keys: ['O'], label: 'Toggle auto-rotate', group: 'Display' },
  { keys: ['W'], label: 'Toggle wireframe', group: 'Display' },
  { keys: ['G'], label: 'Toggle grid', group: 'Display' },
  { keys: ['X'], label: 'Toggle axes', group: 'Display' },
  { keys: ['B'], label: 'Toggle bounding box', group: 'Display' },
  { keys: ['S'], label: 'Toggle ground shadow', group: 'Display' },
  { keys: ['L'], label: 'Next lighting preset', group: 'Display' },
  { keys: ['C'], label: 'Next background', group: 'Display' },
  { keys: ['Space'], label: 'Play or pause animation', group: 'Playback' },
  { keys: ['P'], label: 'Download PNG snapshot', group: 'Tools' },
  { keys: ['I'], label: 'Show or hide inspector', group: 'Tools' },
  { keys: ['M'], label: 'Maximize or restore viewer', group: 'Tools' },
  { keys: ['?'], label: 'Show shortcuts', group: 'Tools' },
];

const TOGGLE_KEYS = {
  o: 'autoRotate',
  w: 'wireframe',
  g: 'grid',
  x: 'axes',
  b: 'bounds',
  s: 'ground',
};
const ARROW_KEYS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'];

// Maps a keyboard event to a viewer command, or null when the key is not ours.
// `target` describes the focused element so native controls keep their own keys.
export function resolveShortcut(event, target = {}) {
  const key = String(event.key || '').toLowerCase();
  if (event.altKey || event.metaKey || !key) {
    return null;
  }
  if (target.editable) {
    return null;
  }
  if (event.ctrlKey) {
    const arrow = ARROW_KEYS.indexOf(key);
    return arrow >= 0 && !target.native
      ? { type: 'pan', dx: [-1, 1, 0, 0][arrow], dy: [0, 0, 1, -1][arrow] }
      : null;
  }
  if (ARROW_KEYS.includes(key)) {
    if (target.native) {
      return null;
    }
    if (event.shiftKey) {
      return key === 'arrowleft'
        ? { type: 'orbit', azimuth: 1, polar: 0 }
        : key === 'arrowright'
          ? { type: 'orbit', azimuth: -1, polar: 0 }
          : { type: 'orbit', azimuth: 0, polar: key === 'arrowup' ? 1 : -1 };
    }
    return key === 'arrowleft'
      ? { type: 'step', offset: -1 }
      : key === 'arrowright'
        ? { type: 'step', offset: 1 }
        : { type: 'zoom', direction: key === 'arrowup' ? 1 : -1 };
  }
  if (key === ' ' || key === 'spacebar') {
    return target.native || target.button ? null : { type: 'playPause' };
  }
  if (key === '+' || key === '=') {
    return { type: 'zoom', direction: 1 };
  }
  if (key === '-' || key === '_') {
    return { type: 'zoom', direction: -1 };
  }
  if (key === '?' || (key === '/' && event.shiftKey)) {
    return { type: 'help' };
  }
  if (event.shiftKey) {
    return null;
  }
  const preset = VIEW_PRESETS.find((candidate) => candidate.key === key);
  if (preset) {
    return { type: 'view', view: preset.id };
  }
  if (TOGGLE_KEYS[key]) {
    return { type: 'toggle', pref: TOGGLE_KEYS[key] };
  }
  const simple = {
    r: { type: 'reset' },
    f: { type: 'frame' },
    l: { type: 'cycle', pref: 'lighting' },
    c: { type: 'cycle', pref: 'background' },
    p: { type: 'snapshot' },
    i: { type: 'inspector' },
    m: { type: 'maximize' },
  }[key];
  return simple || null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ViewerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ViewerError';
    this.code = code;
    this.details = details;
  }
}

export const MAX_ASSET_BYTES = {
  model: 64 * 1024 ** 2,
  ply: 256 * 1024 ** 2,
  motion: 10 * 1024 ** 2,
};

export function byteLimitFor(name) {
  const extension = fileExtension(name);
  return extension === 'ply'
    ? MAX_ASSET_BYTES.ply
    : extension === 'bvh'
      ? MAX_ASSET_BYTES.motion
      : MAX_ASSET_BYTES.model;
}

// Turns any failure into a title, an explanation and the next thing the user can do.
export function describeViewerError(error, { name = 'this file' } = {}) {
  const code = error?.code;
  const message = String(error?.message || '');
  const extension = fileExtension(name);
  if (code === 'TOO_LARGE') {
    const { bytes, limit } = error.details || {};
    return {
      code,
      title: 'File too large to preview',
      message: `${name}${bytes ? ` is ${formatBytes(bytes)}` : ' is too large'}; the in-app preview handles up to ${formatBytes(limit)}.`,
      hint: 'Download it to open in a 3D editor, or export a lighter version.',
      retryable: false,
    };
  }
  if (code === 'NO_WEBGL' || /webgl|context lost|graphics context/i.test(message)) {
    return {
      code: 'NO_WEBGL',
      title: '3D graphics are unavailable',
      message: 'The browser could not start a WebGL context for this preview.',
      hint: 'Turn on hardware acceleration, close other GPU-heavy tabs, then try again.',
      retryable: true,
    };
  }
  if (code === 'EXTERNAL_RESOURCES' || /external model resources/i.test(message)) {
    return {
      code: 'EXTERNAL_RESOURCES',
      title: 'This model uses external files',
      message:
        'It references textures or buffers stored outside the file, which cannot be loaded here.',
      hint: 'Export a self-contained .glb (or embed the resources) and add that instead.',
      retryable: false,
    };
  }
  if (code === 'EMPTY') {
    return {
      code,
      title: 'Nothing to show',
      message: message || 'This file loaded but contains no visible geometry.',
      hint: 'Check that the export includes meshes, points or a skeleton.',
      retryable: false,
    };
  }
  if (
    code === 'HTTP' ||
    code === 'NETWORK' ||
    (error?.name === 'TypeError' && /fetch|network/i.test(message))
  ) {
    return {
      code: code || 'NETWORK',
      title: 'Could not read the file',
      message:
        message && code === 'HTTP' ? message : 'The file could not be downloaded from the studio.',
      hint: 'It may have been moved or deleted. Check your connection and try again.',
      retryable: true,
    };
  }
  if (code === 'UNSUPPORTED') {
    return {
      code,
      title: 'Format not supported',
      message: message || `.${extension || 'this'} files cannot be previewed here.`,
      hint: 'GLB, glTF, FBX, PLY and BVH files can be previewed. Download the file to open it elsewhere.',
      retryable: false,
    };
  }
  return {
    code: code || 'PARSE',
    title: 'Could not open this 3D file',
    message: message || 'The file may be damaged or in an unexpected format.',
    hint: 'Try downloading it and opening it in a 3D editor to check it.',
    retryable: true,
  };
}
