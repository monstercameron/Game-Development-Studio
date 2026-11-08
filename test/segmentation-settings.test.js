import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEGMENTATION_EXPORTS,
  confidenceProblem,
  matchChoice,
  matchSummary,
  maxInstancesProblem,
  segmentationExportLabel,
  segmentationOutputId,
  segmentationSettings,
} from '../src/segmentation-settings.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';

test('confidence accepts the whole 0 to 1 range and a blank default', () => {
  for (const value of [undefined, null, '', ' ', 0, 1, '0', '0.5', '1', 0.05]) {
    assert.equal(confidenceProblem(value), '', String(value));
  }
});

test('confidence rejects values outside the range or that are not numbers', () => {
  for (const value of [-0.1, 1.01, '2', 'abc', 'NaN', Infinity]) {
    assert.match(confidenceProblem(value), /0 to 1/, String(value));
  }
});

test('export labels map to the queue output ids and back', () => {
  assert.deepEqual(
    SEGMENTATION_EXPORTS.map(([label]) => segmentationOutputId(label)),
    ['transparent', 'mask', 'outline', 'cropped'],
  );
  for (const [label, id] of SEGMENTATION_EXPORTS) {
    assert.equal(segmentationExportLabel(id), label);
  }
  // A draft saved with a label that no longer exists falls back to the cutout.
  assert.equal(segmentationOutputId('Something else'), 'transparent');
  assert.equal(segmentationOutputId(undefined), 'transparent');
  assert.equal(segmentationExportLabel('unknown'), 'Transparent PNG');
});

test('the match limit is only checked for the best-scoring choice', () => {
  for (const choice of [undefined, 'all', 'best', 'largest', 'bogus']) {
    assert.equal(maxInstancesProblem(choice, 'abc'), '', String(choice));
  }
  for (const value of ['1', 3, '50']) {
    assert.equal(maxInstancesProblem('top', value), '', String(value));
  }
  for (const value of [undefined, '', ' ', '0', '51', '2.5', 'abc', -1]) {
    assert.match(maxInstancesProblem('top', value), /whole number from 1 to 50/, String(value));
  }
  assert.equal(matchChoice('largest'), 'largest');
  assert.equal(matchChoice('bogus'), 'all');
  assert.equal(matchChoice(undefined), 'all');
});

test('a draft becomes queue fields, leaving defaults out', () => {
  assert.deepEqual(segmentationSettings({ options: ['Text prompt', 'Mask PNG'] }), {
    output: 'mask',
    confidence: 0.5,
  });
  assert.deepEqual(segmentationSettings({ confidence: '0.3', matches: 'best' }), {
    output: 'transparent',
    confidence: 0.3,
    select: 'best',
  });
  assert.deepEqual(
    segmentationSettings({
      options: ['Text prompt', 'Cropped cutout PNG'],
      matches: 'top',
      maxInstances: '4',
    }),
    { output: 'cropped', confidence: 0.5, select: 'top', max_instances: 4 },
  );
  // A limit left over from an earlier choice is ignored for the other choices.
  assert.deepEqual(segmentationSettings({ matches: 'largest', maxInstances: 'abc' }), {
    output: 'transparent',
    confidence: 0.5,
    select: 'largest',
  });
  assert.throws(() => segmentationSettings({ confidence: '2' }), /Confidence must be/);
  assert.throws(
    () => segmentationSettings({ matches: 'top', maxInstances: '0' }),
    /Matches to keep: Enter a whole number from 1 to 50/,
  );
  assert.throws(() => segmentationSettings({ matches: 'top' }), /whole number from 1 to 50/);
});

test('the queue shows what SAM found, only when it reported it', () => {
  const job = (result, type = 'segmentation') => ({ type, details: result ? { result } : null });
  assert.equal(matchSummary(job(null)), '');
  assert.equal(matchSummary(job({ found: 2 }, 'images')), '');
  assert.equal(matchSummary({ type: 'segmentation' }), '');
  assert.equal(
    matchSummary(job({ found: 1, used: 1, scores: [0.9], usedScores: [0.9] })),
    'Found 1 match, all used. Scores of the kept matches: 0.90.',
  );
  assert.equal(
    matchSummary(job({ found: 4, used: 2, scores: [0.9, 0.8, 0.5, 0.4], usedScores: [0.9, 0.8] })),
    'Found 4 matches, 2 used. Scores of the kept matches: 0.90, 0.80.',
  );
  assert.equal(
    matchSummary(job({ found: 9, used: 8, scores: [], usedScores: [1, 0.9, 0.8, 0.7, 0.6, 0.5] })),
    'Found 9 matches, 8 used. Scores of the kept matches: 1.00, 0.90, 0.80, 0.70, 0.60, ….',
  );
  assert.equal(matchSummary(job({ found: 0, used: 0 })), 'Found 0 matches, all used.');
});

test('generation details name the new settings and reuse them on the page', () => {
  const meta = {
    job: { type: 'segmentation' },
    prompt: { text: 'the dragon' },
    settings: {
      output: 'cropped',
      confidence: 0.4,
      select: 'top',
      max_instances: 2,
      matches_found: 5,
      matches_used: 2,
      match_scores: '0.91, 0.80',
    },
  };
  const rows = Object.fromEntries(describeSettings(meta).map((row) => [row.label, row.value]));
  assert.equal(rows.Output, 'Cropped cutout PNG');
  assert.equal(rows['Which matches'], 'The best-scoring matches, up to a limit');
  assert.equal(rows['Most matches kept'], '2');
  assert.equal(rows['Matches found'], '5');
  assert.equal(rows['Matches used'], '2');
  assert.equal(rows['Scores of kept matches'], '0.91, 0.80');

  const plan = reusePlan(meta);
  assert.equal(plan.draft.options[1], 'Cropped cutout PNG');
  assert.equal(plan.draft.matches, 'top');
  assert.equal(plan.draft.maxInstances, '2');
  // Assets made before match selection existed reuse as "all matches" with no limit.
  const older = reusePlan({ ...meta, settings: { output: 'mask', confidence: 0.5 } });
  assert.equal(older.draft.options[1], 'Mask PNG');
  assert.equal(older.draft.matches, 'all');
  assert.equal(older.draft.maxInstances, '');
});
