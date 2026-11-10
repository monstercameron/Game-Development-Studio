// Queue state is global across projects; it does not imply GPU availability.
// Maps each studio page to the queue job types it shows in its sidebar indicator.
const PAGE_JOB_TYPES = {
  images: ['images'],
  '3d': ['3d', 'trellis'],
  world: ['world'],
  vegetation: ['vegetation'],
  motion: ['motion', 'motion-bricks'],
  video: ['video'],
  music: ['music'],
  sfx: ['sfx'],
  voices: ['voices', 'drama3'],
  segmentation: ['segmentation'],
};
const ATTENTION_STATUSES = new Set(['needs_attention', 'interrupted', 'waiting_memory']);
const RUNNING_STATUSES = new Set(['preparing', 'submitting', 'running', 'finalizing']);
const WAITING_STATUSES = new Set(['queued', 'waiting_engine']);

/**
 * Summarizes the queue for one studio page, counting only jobs whose type belongs to that page.
 *
 * Returns null for a page that is not a key of PAGE_JOB_TYPES. A failed or still-loading queue read returns
 * state 'unknown' rather than 'free', so a stale or missing read is never shown as idle.
 * Jobs in ATTENTION_STATUSES take precedence over running and waiting jobs in the summary.
 *
 * @param {string} page Studio page id, a key of PAGE_JOB_TYPES.
 * @param {Array<{ type: string, status: string }>} jobs Queue jobs from all projects.
 * @param {{ loading?: boolean, error?: string }} [options] Queue read state.
 * @returns {{ state: string, short: string, detail: string } | null}
 */
export function pageQueueStatus(page, jobs, { loading = false, error = '' } = {}) {
  const jobTypes = PAGE_JOB_TYPES[page];
  if (!jobTypes) {
    return null;
  }
  if (error) {
    return {
      state: 'unknown',
      short: 'Unknown',
      detail: 'Queue unavailable; page status is unknown.',
    };
  }
  if (loading) {
    return { state: 'unknown', short: 'Checking', detail: 'Checking the render queue.' };
  }
  const related = jobs.filter((job) => jobTypes.includes(job.type));
  const counts = { running: 0, waiting: 0, attention: 0 };
  for (const job of related) {
    if (ATTENTION_STATUSES.has(job.status)) {
      counts.attention++;
    } else if (RUNNING_STATUSES.has(job.status)) {
      counts.running++;
    } else if (WAITING_STATUSES.has(job.status)) {
      counts.waiting++;
    }
  }
  const total = counts.running + counts.waiting + counts.attention;
  if (!total) {
    return {
      state: 'free',
      short: 'No jobs',
      detail:
        'No active or waiting renders for this page across projects. This does not indicate whether the model is loaded or the GPU is available.',
    };
  }
  const detail =
    [
      counts.running && `${counts.running} running`,
      counts.waiting && `${counts.waiting} waiting`,
      counts.attention && `${counts.attention} needing attention`,
    ]
      .filter(Boolean)
      .join(', ') + ' across projects.';
  if (counts.attention) {
    return { state: 'attention', short: 'Review', detail };
  }
  if (counts.running) {
    return {
      state: 'running',
      short: counts.waiting ? `Running +${counts.waiting}` : 'Running',
      detail,
    };
  }
  return { state: 'waiting', short: `${counts.waiting} queued`, detail };
}
