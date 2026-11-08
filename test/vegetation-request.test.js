import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkControlValue,
  cleanVegetationResult,
  clampSuggestedParams,
  effectiveValues,
  normalizeVegetationRequest,
  vegetationRequestFromSettings,
  vegetationSettings,
  vegetationTitle,
} from '../runtime/vegetation-request.js';

const species = {
  key: 'oak',
  name: 'Oak',
  controls: [
    {
      id: 'height',
      name: 'Height',
      group: 'shape',
      type: 'number',
      min: 4,
      max: 26,
      step: 0.5,
      default: 13,
    },
    {
      id: 'levels',
      name: 'Levels',
      group: 'shape',
      type: 'integer',
      min: 2,
      max: 4,
      step: 1,
      default: 3,
    },
    {
      id: 'crown',
      name: 'Crown',
      group: 'shape',
      type: 'choice',
      default: 1,
      options: [
        { label: 'Conical', value: 0 },
        { label: 'Spherical', value: 1 },
      ],
    },
    { id: 'showLeaves', name: 'Show leaves', group: 'leaves', type: 'boolean', default: true },
    {
      id: 'paramOverrides.downAngle.1',
      name: 'Down angle',
      group: 'advanced',
      type: 'integer',
      min: 0,
      max: 135,
      step: 1,
      default: 68,
    },
  ],
};
const schema = { seed: { min: 1, max: 9999, default: 1 }, species: [species] };

test('numbers are range checked, and clamped and snapped to the step only on request', () => {
  const [height, levels] = species.controls;
  assert.deepEqual(checkControlValue(height, 12.25), { value: 12.25 });
  assert.match(checkControlValue(height, 99).error, /from 4 to 26/);
  assert.match(checkControlValue(height, Number.NaN).error, /number/);
  assert.match(checkControlValue(height, '12').error, /number/);
  assert.match(checkControlValue(levels, 2.5).error, /whole number/);
  assert.deepEqual(checkControlValue(height, 99, { clamp: true }), { value: 26 });
  assert.deepEqual(checkControlValue(height, '12.3', { clamp: true }), { value: 12.5 });
  assert.deepEqual(checkControlValue(levels, 3.4, { clamp: true }), { value: 3 });
  assert.deepEqual(checkControlValue(levels, -50, { clamp: true }), { value: 2 });
  assert.match(checkControlValue(levels, Infinity, { clamp: true }).error, /number/);
});

test('choices accept the exact value, and labels only when clamping', () => {
  const crown = species.controls[2];
  assert.deepEqual(checkControlValue(crown, 0), { value: 0 });
  assert.ok(checkControlValue(crown, 5).error);
  assert.ok(checkControlValue(crown, 'Conical').error);
  assert.deepEqual(checkControlValue(crown, 'conical', { clamp: true }), { value: 0 });
});

test('hostile suggestions are dropped or clamped and reported', () => {
  const hostile = JSON.parse(
    '{"height": 1e308, "levels": "four", "crown": {"x": 1}, "showLeaves": "true", ' +
      '"__proto__": {"polluted": true}, "constructor": 1, "toString": 2, "evil": 5, ' +
      '"paramOverrides.downAngle.1": -4000}',
  );
  const clamped = clampSuggestedParams(hostile, species);
  assert.deepEqual(clamped.params, { height: 26, 'paramOverrides.downAngle.1': 0 });
  assert.ok(clamped.ignored.includes('evil'));
  assert.ok(clamped.ignored.includes('__proto__'));
  assert.ok(clamped.ignored.includes('constructor'));
  assert.ok(clamped.ignored.includes('Levels'));
  assert.ok(clamped.ignored.includes('Show leaves'));
  assert.deepEqual(clamped.adjusted.sort(), ['Down angle', 'Height']);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(clampSuggestedParams('text', species), {
    params: {},
    ignored: [],
    adjusted: [],
  });
  assert.deepEqual(clampSuggestedParams([1, 2], species).params, {});
  const flood = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`x${index}`, index]));
  assert.ok(clampSuggestedParams(flood, species).ignored.length <= 201);
});

test('a suggestion equal to the default is not stored', () => {
  assert.deepEqual(clampSuggestedParams({ height: 13, levels: 3 }, species).params, {});
});

test('requests are normalized and compared by value', () => {
  const normalized = normalizeVegetationRequest(
    { species: 'oak', params: { levels: 4, height: 13 } },
    schema,
  );
  assert.deepEqual(normalized, {
    species: 'oak',
    seed: 1,
    budget: 'medium',
    params: { levels: 4 },
  });
  assert.throws(() => normalizeVegetationRequest(null, schema), /must be an object/);
  assert.throws(
    () => normalizeVegetationRequest({ species: 'oak', params: [] }, schema),
    /object of control/,
  );
  assert.throws(() => normalizeVegetationRequest({ species: 'oak', seed: '5' }, schema), /Seed/);
  assert.throws(() => normalizeVegetationRequest({ species: 'oak', seed: 10000 }, schema), /Seed/);
});

test('settings round-trip through flat scalar metadata for Reuse', () => {
  const request = {
    species: 'oak',
    seed: 77,
    budget: 'low',
    params: { height: 20, 'paramOverrides.downAngle.1': 50 },
  };
  const settings = vegetationSettings(request, {
    triangles: 9450,
    speciesName: 'Oak',
    heightMeters: 18.2,
  });
  assert.equal(settings.p_height, 20);
  assert.equal(settings.p_paramOverrides__downAngle__1, 50);
  assert.equal(settings.triangles, 9450);
  assert.equal(settings.height_m, 18.2);
  assert.ok(Object.keys(settings).every((key) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)));
  assert.deepEqual(vegetationRequestFromSettings(settings, 77), request);
  assert.equal(vegetationTitle(request, { speciesName: 'White Oak' }), 'White Oak · seed 77');
  assert.deepEqual([...effectiveValues(species, { height: 20 }).entries()].slice(0, 2), [
    ['height', 20],
    ['levels', 3],
  ]);
});

test('stored results keep only known bounded fields', () => {
  assert.equal(cleanVegetationResult({ triangles: 'many' }), null);
  assert.equal(cleanVegetationResult('x'), null);
  const cleaned = cleanVegetationResult({
    triangles: 100,
    speciesName: 'x'.repeat(500),
    secret: 'no',
    levelTriangles: [100, 50, -1, 1.5, 3, 4, 5, 6, 7],
    peakRssMiB: Number.POSITIVE_INFINITY,
  });
  assert.equal(cleaned.speciesName.length, 80);
  assert.equal(cleaned.secret, undefined);
  assert.equal(cleaned.peakRssMiB, undefined);
  assert.deepEqual(cleaned.levelTriangles, [100, 50, 3, 4, 5, 6]);
});

test('recorded settings are shown with names and reused as the same design', async () => {
  const { describeSettings, reusePlan } = await import('../src/generation-details.js');
  const request = {
    species: 'whiteOak',
    seed: 77,
    budget: 'low',
    params: { height: 20, 'paramOverrides.downAngle.1': 50 },
  };
  const meta = {
    type: 'vegetation',
    job: { type: 'vegetation' },
    seed: 77,
    settings: vegetationSettings(request, {
      triangles: 9450,
      glbBytes: 1048576,
      seedthreeCommit: 'cf2eaad39d9b7355ed086aca2a95fb785e539242',
    }),
  };
  const rows = Object.fromEntries(describeSettings(meta).map((row) => [row.label, row.value]));
  assert.equal(rows.Species, 'White oak');
  assert.equal(rows['Triangle budget'], 'Low');
  assert.equal(rows.Triangles, '9,450');
  assert.equal(rows['File size'], '1.00 MiB');
  assert.equal(rows['SeedThree commit'], 'cf2eaad39d');
  assert.equal(rows.Height, '20');
  assert.equal(rows['Down angle L1'], '50');
  assert.deepEqual(reusePlan(meta).vegetation, request);
});
