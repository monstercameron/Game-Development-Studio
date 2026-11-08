import {
  SEGMENTATION_MAX_INSTANCES,
  SEGMENTATION_SELECTIONS,
  normalizeSelection,
} from '../runtime/sam31-options.js';

// Segmentation page settings that the browser can check before anything is queued. The queue
// validates the same range again (runtime/jobs.js).
export const SEGMENTATION_CONFIDENCE_DEFAULT = 0.5;
export { SEGMENTATION_MAX_INSTANCES };
export const SEGMENTATION_MAX_INSTANCES_DEFAULT = 3;

// Page label first, queue id second. The labels are also the keys of the Export select values
// stored in a draft, so changing one needs a matching change in src/tooltips/pages/segmentation.js.
export const SEGMENTATION_EXPORTS = [
  ['Transparent PNG', 'transparent'],
  ['Mask PNG', 'mask'],
  ['Outline overlay PNG', 'outline'],
  ['Cropped cutout PNG', 'cropped'],
];
export const SEGMENTATION_MATCH_CHOICES = [
  ['All matches combined', 'all'],
  ['Only the best-scoring match', 'best'],
  ['Only the largest match', 'largest'],
  ['The best-scoring matches, up to a limit', 'top'],
];

// Queue id for an Export label; anything unknown means the default transparent cutout.
export function segmentationOutputId(label) {
  return SEGMENTATION_EXPORTS.find(([text]) => text === label)?.[1] || 'transparent';
}
// Export label for a queue id (used when settings are reused from a saved asset).
export function segmentationExportLabel(id) {
  return SEGMENTATION_EXPORTS.find(([, value]) => value === id)?.[0] || SEGMENTATION_EXPORTS[0][0];
}
// A draft saved before match selection existed has no choice, which means all matches.
export function matchChoice(value) {
  return SEGMENTATION_SELECTIONS.includes(value) ? value : 'all';
}

// A blank field means the default. Returns an empty string when the value is usable.
export function confidenceProblem(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return '';
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    return 'Confidence must be a number from 0 to 1.';
  }
  return '';
}

// The limit only matters for "best-scoring matches"; it must be a whole number from 1 to 50.
export function maxInstancesProblem(choice, value) {
  if (matchChoice(choice) !== 'top') {
    return '';
  }
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (
    text === '' ||
    !Number.isInteger(number) ||
    number < 1 ||
    number > SEGMENTATION_MAX_INSTANCES
  ) {
    return `Enter a whole number from 1 to ${SEGMENTATION_MAX_INSTANCES}.`;
  }
  return '';
}

/**
 * The queue request fields a segmentation draft produces, apart from the prompt and reference.
 * Throws an Error with a message fit for the page when a value is not usable.
 */
export function segmentationSettings(draft) {
  const problem = confidenceProblem(draft.confidence);
  if (problem) {
    throw Error('Confidence must be between 0 and 1.');
  }
  const choice = matchChoice(draft.matches);
  const limitProblem = maxInstancesProblem(choice, draft.maxInstances);
  if (limitProblem) {
    throw Error(`Matches to keep: ${limitProblem}`);
  }
  const blank = draft.confidence === '' || draft.confidence === undefined;
  return {
    output: segmentationOutputId(draft.options?.[1]),
    confidence: blank ? SEGMENTATION_CONFIDENCE_DEFAULT : Number(draft.confidence),
    ...normalizeSelection({
      select: choice,
      max_instances: choice === 'top' ? Number(draft.maxInstances) : undefined,
    }),
  };
}

// One line about a finished segmentation for the queue, or '' when the worker reported nothing
// (older jobs, and jobs the worker recovered after a restart).
export function matchSummary(job) {
  const result = job?.details?.result;
  if (job?.type !== 'segmentation' || !result || !Number.isInteger(result.found)) {
    return '';
  }
  const plural = (count) => `${count} ${count === 1 ? 'match' : 'matches'}`;
  const kept = Array.isArray(result.usedScores) ? result.usedScores : [];
  const shown = kept.slice(0, 5).map((score) => score.toFixed(2));
  const more = kept.length > shown.length ? ', …' : '';
  const used = result.used === result.found ? 'all used' : `${result.used} used`;
  return shown.length
    ? `Found ${plural(result.found)}, ${used}. Scores of the kept matches: ${shown.join(', ')}${more}.`
    : `Found ${plural(result.found)}, ${used}.`;
}
