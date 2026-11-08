// SAM 3.1 segmentation options shared by the queue, the MCP tools and the studio page.
// The worker (sam31_worker.py / sam31_backend.py) checks the same values again.

export const SEGMENTATION_OUTPUTS = ['transparent', 'mask', 'outline', 'cropped'];
// all: every match combined (the original behaviour). best: the highest-scoring match.
// largest: the match covering the most pixels. top: the N highest-scoring matches.
export const SEGMENTATION_SELECTIONS = ['all', 'best', 'largest', 'top'];
export const SEGMENTATION_MAX_INSTANCES = 50;
// Features the worker lists in /api/status once it understands the options above.
export const SAM31_OPTION_FEATURE = 'match-selection';

// Same cap as MAX_REPORTED_MATCHES in sam31_backend.py. The host applies it again so a stored
// job cannot grow with a larger worker report.
const MAX_REPORTED_MATCHES = 20;

/**
 * Validates which matches to keep and returns the request fields to store.
 * Older requests have no `select` field, so the default (all) stores nothing.
 * @param {{ select?: unknown, max_instances?: unknown }} input
 * @returns {{ select?: string, max_instances?: number }}
 */
export function normalizeSelection({ select, max_instances: maxInstances } = {}) {
  const choice = select === undefined || select === null ? 'all' : select;
  if (!SEGMENTATION_SELECTIONS.includes(choice)) {
    throw Error(`select must be one of: ${SEGMENTATION_SELECTIONS.join(', ')}.`);
  }
  const hasLimit = maxInstances !== undefined && maxInstances !== null;
  if (choice !== 'top') {
    if (hasLimit) {
      throw Error('max_instances only applies when select is top.');
    }
    return choice === 'all' ? {} : { select: choice };
  }
  if (
    !Number.isSafeInteger(maxInstances) ||
    maxInstances < 1 ||
    maxInstances > SEGMENTATION_MAX_INSTANCES
  ) {
    throw Error(`max_instances must be a whole number from 1 to ${SEGMENTATION_MAX_INSTANCES}.`);
  }
  return { select: 'top', max_instances: maxInstances };
}

/** True when a request needs a worker that understands match selection or the newer outputs. */
export function usesSegmentationOptions(request) {
  return (
    (request?.select !== undefined && request.select !== 'all') ||
    ['outline', 'cropped'].includes(request?.output)
  );
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const cleanScores = (values) =>
  (Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .slice(0, MAX_REPORTED_MATCHES)
    .map((value) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000);

/**
 * Keeps only the plain numbers of a match report so it is safe to store with the job.
 * @returns {{ found: number, used: number, scores: number[], usedScores: number[] } | null}
 */
export function cleanMatchReport(report) {
  if (!report || typeof report !== 'object' || !isCount(report.found) || !isCount(report.used)) {
    return null;
  }
  return {
    found: report.found,
    used: report.used,
    scores: cleanScores(report.scores),
    usedScores: cleanScores(report.usedScores),
  };
}

/**
 * Builds the report from the `metadata` the SAM worker attaches to a finished job. Jobs that
 * the worker recovered after a restart have no metadata, so this returns null for them.
 * @param {unknown} metadata The worker's metadata object, or anything else.
 * @returns {ReturnType<typeof cleanMatchReport>} A cleaned report, or null when it is unusable.
 */
export function reportFromWorkerMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.matches)) {
    return null;
  }
  const matches = metadata.matches.filter((match) => match && typeof match === 'object');
  return cleanMatchReport({
    found: metadata.instances,
    used: metadata.used,
    scores: matches.map((match) => match.score),
    usedScores: matches.filter((match) => match.selected === true).map((match) => match.score),
  });
}
