import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKGROUND_PRESETS,
  DEFAULT_PREFS,
  LIGHTING_PRESETS,
  PREFS_KEY,
  SHORTCUTS,
  VIEW_PRESETS,
  ViewerError,
  assetFormat,
  byteLimitFor,
  clamp,
  cycle,
  describeViewerError,
  fitDistance,
  formatBytes,
  formatCompact,
  formatCount,
  formatDimensions,
  formatNumber,
  formatTime,
  loadPrefs,
  niceStep,
  orbitVector,
  qualityPixelRatio,
  resetPrefsMemory,
  resolveShortcut,
  sanitizePrefs,
  savePrefs,
  snapshotFilename,
  stepIndex,
  viewDirection,
  viewPosition,
} from '../src/viewer-core.js';

const near = (actual, expected, epsilon = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} is not within ${epsilon} of ${expected}`,
  );
const length = (vector) => Math.hypot(...vector);

test('view presets are unit directions with matching 1-6 keys', () => {
  assert.deepEqual(
    VIEW_PRESETS.map((preset) => preset.id),
    ['front', 'back', 'left', 'right', 'top', 'iso'],
  );
  assert.deepEqual(
    VIEW_PRESETS.map((preset) => preset.key),
    ['1', '2', '3', '4', '5', '6'],
  );
  for (const preset of VIEW_PRESETS) {
    near(length(viewDirection(preset.id)), 1);
  }
  assert.deepEqual(viewDirection('front'), [0, 0, 1]);
  assert.deepEqual(viewDirection('back'), [0, 0, -1]);
  assert.deepEqual(viewDirection('left'), [-1, 0, 0]);
  assert.deepEqual(viewDirection('right'), [1, 0, 0]);
  assert.deepEqual(viewDirection('top'), [0, 1, 0]);
  const iso = viewDirection('iso');
  assert.ok(iso[0] > 0 && iso[1] > 0 && iso[2] > 0, 'iso looks from front, right and above');
  assert.deepEqual(viewDirection('nonsense'), iso, 'unknown ids fall back to the default view');
});

test('opposite views mirror each other and splat scenes use the y-down frame', () => {
  for (const [a, b] of [
    ['front', 'back'],
    ['left', 'right'],
  ]) {
    const first = viewDirection(a),
      second = viewDirection(b);
    first.forEach((component, index) => near(component, -second[index]));
  }
  const flipped = viewDirection('top', { flipY: true });
  near(flipped[1], -1);
  const front = viewDirection('front', { flipY: true });
  assert.deepEqual(front.map(Math.abs), [0, 0, 1]);
  assert.equal(Math.sign(front[2]), -1, 'a y-down scene is viewed from the -z side');
});

test('view positions sit at the requested distance from the target', () => {
  const position = viewPosition('right', { target: [1, 2, 3], distance: 10 });
  assert.deepEqual(position, [11, 2, 3]);
  const iso = viewPosition('iso', { target: [0, 0, 0], distance: 5 });
  near(length(iso), 5);
});

test('fit distance grows with the model and shrinks with a wider field of view', () => {
  const unit = fitDistance([1, 1, 1], 38, 1);
  const big = fitDistance([10, 10, 10], 38, 1);
  near(big / unit, 10, 1e-9);
  assert.ok(fitDistance([1, 1, 1], 60, 1) < unit);
  assert.ok(fitDistance([1, 1, 1], 38, 0.5) > unit, 'a narrow viewport needs more distance');
  assert.ok(Number.isFinite(fitDistance([0, 0, 0], 38, 1)));
});

test('orbiting preserves distance and never reaches the poles', () => {
  const start = [3, 4, 5];
  const moved = orbitVector(start, 0.7, 0.2);
  near(length(moved), length(start), 1e-9);
  const spun = orbitVector([0, 0, 2], Math.PI / 2, 0);
  near(spun[0], 2, 1e-9);
  near(spun[2], 0, 1e-9);
  const toTop = orbitVector([0, 1, 1], 0, -10);
  assert.ok(
    toTop[1] > 0 && Math.hypot(toTop[0], toTop[2]) > 0,
    'polar angle is clamped off the pole',
  );
  const toBottom = orbitVector([0, 1, 1], 0, 10);
  assert.ok(toBottom[1] < 0 && Math.hypot(toBottom[0], toBottom[2]) > 0);
  assert.deepEqual(orbitVector([0, 0, 0], 1, 1), [0, 0, 0]);
  const flipped = orbitVector([0, -1, -1], 0, 0.3, { flipY: true });
  near(length(flipped), Math.SQRT2, 1e-9);
  assert.ok(flipped[1] < 0, 'y-down scenes keep their camera on the negative-y side');
});

test('niceStep rounds grid spacing to 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceStep(0.8), 1);
  assert.equal(niceStep(1.4), 2);
  assert.equal(niceStep(3), 5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(16.2), 20);
  assert.equal(niceStep(0.03), 0.05);
  assert.equal(niceStep(0), 1);
  assert.equal(niceStep(Number.NaN), 1);
});

test('quality presets scale the pixel ratio within sensible bounds', () => {
  assert.equal(qualityPixelRatio('balanced', 2), 1.5);
  assert.equal(qualityPixelRatio('sharp', 2), 2);
  assert.equal(qualityPixelRatio('sharp', 4), 2.5);
  assert.equal(qualityPixelRatio('fast', 2), 1);
  assert.equal(qualityPixelRatio('fast', 1), 0.6);
  assert.equal(qualityPixelRatio('missing', 1), 1);
  assert.equal(qualityPixelRatio('balanced', 0), 1);
});

test('byte, count, dimension and time formatting', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1212164), '1.2 MB');
  assert.equal(formatBytes(150 * 1024 ** 2), '150 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.00 GB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatCount(67296), '67,296');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCompact(950), '950');
  assert.equal(formatCompact(12_345), '12.3K');
  assert.equal(formatCompact(1_234_567), '1.23M');
  assert.equal(formatCompact(35_000_000), '35.0M');
  assert.equal(formatNumber(1.987), '1.99');
  assert.equal(formatNumber(162), '162');
  assert.equal(formatNumber(52.23), '52.2');
  assert.equal(formatNumber(0.218), '0.218');
  assert.equal(formatDimensions([1.99, 1.98, 0.218]), '1.99 × 1.98 × 0.218');
  assert.equal(formatDimensions(null), '—');
  assert.equal(formatTime(0), '0:00.0');
  assert.equal(formatTime(75.46), '1:15.4');
  assert.equal(formatTime(-3), '0:00.0');
});

test('asset formats and snapshot file names', () => {
  assert.deepEqual(
    { ...assetFormat('Model.GLB', 'mesh') },
    {
      extension: 'glb',
      label: 'GLB',
      description: 'glTF binary',
      kind: 'mesh',
      kindLabel: 'Mesh',
    },
  );
  assert.equal(assetFormat('scene.ply', 'splat').kindLabel, 'Gaussian splat');
  assert.equal(assetFormat('walk.bvh', 'skeleton').kindLabel, 'Animated skeleton');
  assert.equal(assetFormat('odd.xyz').label, 'XYZ');
  assert.equal(assetFormat('noextension').label, '3D');
  assert.equal(snapshotFilename('My Model (v2).glb', 'top'), 'My-Model-v2-top.png');
  assert.equal(snapshotFilename('', 'iso'), 'model-iso.png');
  assert.equal(snapshotFilename('a/b\\c.ply'), 'a-b-c-view.png');
  assert.equal(byteLimitFor('x.glb'), 64 * 1024 ** 2);
  assert.equal(byteLimitFor('x.ply'), 256 * 1024 ** 2);
  assert.equal(byteLimitFor('x.bvh'), 10 * 1024 ** 2);
});

test('stepping and cycling helpers stay in range', () => {
  assert.equal(stepIndex(1, 3, -1), 0);
  assert.equal(stepIndex(0, 3, -1), null);
  assert.equal(stepIndex(2, 3, 1), null);
  assert.equal(stepIndex(1, 3, 1), 2);
  assert.equal(cycle(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(cycle(['a', 'b', 'c'], 'a', -1), 'c');
  assert.equal(cycle(['a', 'b', 'c'], 'missing'), 'a');
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
});

test('preferences are sanitized: unknown keys, wrong types and out-of-range values are dropped', () => {
  assert.deepEqual(sanitizePrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(sanitizePrefs([1, 2]), DEFAULT_PREFS);
  const prefs = sanitizePrefs({
    grid: false,
    wireframe: 'yes',
    lighting: 'dark',
    background: 'neon',
    quality: 'sharp',
    autoRotateSpeed: 99,
    pointSize: -3,
    splatScale: Number.NaN,
    playbackSpeed: 1.5,
    extra: 1,
  });
  assert.equal(prefs.grid, false);
  assert.equal(prefs.wireframe, DEFAULT_PREFS.wireframe);
  assert.equal(prefs.lighting, 'dark');
  assert.equal(prefs.background, DEFAULT_PREFS.background);
  assert.equal(prefs.quality, 'sharp');
  assert.equal(prefs.autoRotateSpeed, 4);
  assert.equal(prefs.pointSize, 0.25);
  assert.equal(prefs.splatScale, DEFAULT_PREFS.splatScale);
  assert.equal(prefs.playbackSpeed, 1.5);
  assert.equal('extra' in prefs, false);
  assert.ok(LIGHTING_PRESETS.some((preset) => preset.id === DEFAULT_PREFS.lighting));
  assert.ok(BACKGROUND_PRESETS.some((preset) => preset.id === DEFAULT_PREFS.background));
});

test('preferences persist through storage and survive storage failures', () => {
  resetPrefsMemory();
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS);
  savePrefs({ ...DEFAULT_PREFS, wireframe: true, lighting: 'neutral' }, storage);
  assert.equal(JSON.parse(store.get(PREFS_KEY)).wireframe, true);
  resetPrefsMemory();
  const restored = loadPrefs(storage);
  assert.equal(restored.wireframe, true);
  assert.equal(restored.lighting, 'neutral');

  resetPrefsMemory();
  store.set(PREFS_KEY, '{not json');
  assert.deepEqual(loadPrefs(storage), DEFAULT_PREFS, 'corrupt storage falls back to defaults');

  resetPrefsMemory();
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  assert.deepEqual(loadPrefs(blocked), DEFAULT_PREFS);
  savePrefs({ ...DEFAULT_PREFS, grid: false }, blocked);
  assert.equal(loadPrefs(blocked).grid, false, 'the session keeps the value when storage throws');
  resetPrefsMemory();
});

const press = (key, extra = {}, target = {}) =>
  resolveShortcut(
    { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...extra },
    target,
  );

test('keyboard shortcuts map to viewer commands', () => {
  assert.deepEqual(press('ArrowLeft'), { type: 'step', offset: -1 });
  assert.deepEqual(press('ArrowRight'), { type: 'step', offset: 1 });
  assert.deepEqual(press('ArrowUp'), { type: 'zoom', direction: 1 });
  assert.deepEqual(press('ArrowDown'), { type: 'zoom', direction: -1 });
  assert.deepEqual(press('+', { shiftKey: true }), { type: 'zoom', direction: 1 });
  assert.deepEqual(press('-'), { type: 'zoom', direction: -1 });
  assert.deepEqual(press('ArrowLeft', { shiftKey: true }), { type: 'orbit', azimuth: 1, polar: 0 });
  assert.deepEqual(press('ArrowUp', { shiftKey: true }), { type: 'orbit', azimuth: 0, polar: 1 });
  assert.deepEqual(press('ArrowDown', { shiftKey: true }), {
    type: 'orbit',
    azimuth: 0,
    polar: -1,
  });
  assert.deepEqual(press('ArrowLeft', { ctrlKey: true }), { type: 'pan', dx: -1, dy: 0 });
  assert.deepEqual(press('ArrowUp', { ctrlKey: true }), { type: 'pan', dx: 0, dy: 1 });
  assert.deepEqual(press('r'), { type: 'reset' });
  assert.deepEqual(press('R'), { type: 'reset' });
  assert.deepEqual(press('f'), { type: 'frame' });
  assert.deepEqual(press('1'), { type: 'view', view: 'front' });
  assert.deepEqual(press('5'), { type: 'view', view: 'top' });
  assert.deepEqual(press('6'), { type: 'view', view: 'iso' });
  for (const [key, pref] of [
    ['o', 'autoRotate'],
    ['w', 'wireframe'],
    ['g', 'grid'],
    ['x', 'axes'],
    ['b', 'bounds'],
    ['s', 'ground'],
  ]) {
    assert.deepEqual(press(key), { type: 'toggle', pref });
  }
  assert.deepEqual(press('l'), { type: 'cycle', pref: 'lighting' });
  assert.deepEqual(press('c'), { type: 'cycle', pref: 'background' });
  assert.deepEqual(press('p'), { type: 'snapshot' });
  assert.deepEqual(press('i'), { type: 'inspector' });
  assert.deepEqual(press('m'), { type: 'maximize' });
  assert.deepEqual(press(' '), { type: 'playPause' });
  assert.deepEqual(press('?', { shiftKey: true }), { type: 'help' });
});

test('shortcuts leave browser and native control keys alone', () => {
  assert.equal(press('r', { ctrlKey: true }), null, 'Ctrl+R is the browser reload');
  assert.equal(press('c', { ctrlKey: true }), null);
  assert.equal(press('f', { metaKey: true }), null);
  assert.equal(press('ArrowLeft', { altKey: true }), null, 'Alt+Left is browser back');
  assert.equal(
    press('r', {}, { editable: true }),
    null,
    'typing in a field never triggers shortcuts',
  );
  assert.equal(
    press('ArrowLeft', {}, { native: true }),
    null,
    'sliders and selects keep their arrows',
  );
  assert.equal(press('ArrowLeft', { ctrlKey: true }, { native: true }), null);
  assert.equal(press(' ', {}, { button: true }), null, 'Space activates a focused button');
  assert.equal(press(' ', {}, { native: true }), null);
  assert.equal(press('g', { shiftKey: true }), null, 'Shift+letter is not a shortcut');
  assert.equal(press('Tab'), null);
  assert.equal(press('Escape'), null);
  assert.equal(press('7'), null);
  assert.equal(press(''), null);
});

test('every documented shortcut has a key, a label and a group', () => {
  assert.ok(SHORTCUTS.length >= 15);
  for (const shortcut of SHORTCUTS) {
    assert.ok(shortcut.keys.length > 0 && shortcut.label && shortcut.group);
  }
});

test('errors become actionable messages', () => {
  const tooLarge = describeViewerError(
    new ViewerError('TOO_LARGE', 'x', { bytes: 120 * 1024 ** 2, limit: 64 * 1024 ** 2 }),
    { name: 'big.glb' },
  );
  assert.equal(tooLarge.retryable, false);
  assert.match(tooLarge.message, /120 MB/);
  assert.match(tooLarge.message, /64\.0 MB/);
  assert.match(tooLarge.hint, /Download/);

  const webgl = describeViewerError(new ViewerError('NO_WEBGL', 'WebGL is unavailable.'));
  assert.equal(webgl.retryable, true);
  assert.match(webgl.hint, /hardware acceleration/);
  assert.equal(
    describeViewerError(new Error('THREE.WebGLRenderer: Context Lost.')).code,
    'NO_WEBGL',
  );

  const external = describeViewerError(new Error('External model resources are not supported.'));
  assert.equal(external.code, 'EXTERNAL_RESOURCES');
  assert.match(external.hint, /\.glb/);

  const empty = describeViewerError(
    new ViewerError('EMPTY', 'This 3D file has no visible geometry.'),
  );
  assert.equal(empty.title, 'Nothing to show');
  assert.equal(empty.retryable, false);

  const missing = describeViewerError(
    new ViewerError('HTTP', 'This file no longer exists in the project.'),
  );
  assert.equal(missing.retryable, true);
  assert.match(missing.message, /no longer exists/);
  assert.equal(describeViewerError(new TypeError('Failed to fetch')).code, 'NETWORK');

  const unsupported = describeViewerError(
    new ViewerError('UNSUPPORTED', '.stl files cannot be previewed here.'),
  );
  assert.match(unsupported.hint, /GLB/);

  const parse = describeViewerError(new Error('Unexpected token'), { name: 'broken.glb' });
  assert.equal(parse.code, 'PARSE');
  assert.equal(parse.retryable, true);
  assert.ok(parse.title && parse.message && parse.hint);
  assert.ok(describeViewerError(undefined).message);
});
