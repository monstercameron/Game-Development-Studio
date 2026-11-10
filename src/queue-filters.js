// Filters and row details for the render queue list. Pure helpers, so the filter, the counts and
// the scope of "Clear waiting renders" can be tested without the page.
import { jobTitle } from './queue-groups.js';

// Every runtime status belongs to exactly one filter. "all" matches every status.
export const STATUS_FILTERS = [
  { id: 'all', label: 'All', statuses: null },
  {
    id: 'running',
    label: 'Running',
    statuses: ['running', 'finalizing', 'preparing', 'submitting'],
  },
  { id: 'waiting', label: 'Waiting', statuses: ['queued', 'waiting_engine', 'waiting_memory'] },
  { id: 'attention', label: 'Needs attention', statuses: ['needs_attention', 'interrupted'] },
  { id: 'failed', label: 'Failed', statuses: ['failed'] },
  { id: 'completed', label: 'Completed', statuses: ['completed'] },
  { id: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

// Renders that have not started and have no remote job, so the runtime may cancel them safely.
export const WAITING_STATUSES = ['queued', 'waiting_engine', 'waiting_memory'];

const MAX_QUERY_LENGTH = 200;

export const DEFAULT_QUEUE_FILTERS = Object.freeze({
  status: 'all',
  projectId: 'all',
  type: 'all',
  query: '',
});

// Accepts only the shapes the page writes. Anything else (a stale or edited value) falls back to
// the default for that field, so a bad saved choice never hides the whole queue.
export function normalizeQueueFilters(value) {
  const source = value && typeof value === 'object' ? value : {};
  const status = STATUS_FILTERS.some((filter) => filter.id === source.status)
    ? source.status
    : DEFAULT_QUEUE_FILTERS.status;
  const projectId =
    typeof source.projectId === 'string' && source.projectId ? source.projectId : 'all';
  const type = typeof source.type === 'string' && source.type ? source.type : 'all';
  const query = typeof source.query === 'string' ? source.query.slice(0, MAX_QUERY_LENGTH) : '';
  return { status, projectId, type, query };
}

export function hasActiveQueueFilters(filters) {
  return (
    filters.status !== 'all' ||
    filters.projectId !== 'all' ||
    filters.type !== 'all' ||
    filters.query.trim() !== ''
  );
}

// Short id shown in each row and in button labels. The full id stays in the row's data attribute.
export function jobShortId(job) {
  return String(job?.id || '').slice(0, 8);
}

// The text a person searches: the short id, the prompt or title, and the project name.
function searchableText(job, projectName) {
  return [jobShortId(job), job.id, jobTitle(job), projectName].join('\n').toLowerCase();
}

/**
 * Rows that match every filter. `projectNameOf` maps a job to its project's display name.
 * The status filter is applied last so that counts can exclude it (see countByStatusFilter).
 */
export function filterQueueJobs(jobs, filters, projectNameOf = () => '') {
  const normalized = normalizeQueueFilters(filters);
  const query = normalized.query.trim().toLowerCase();
  const status = STATUS_FILTERS.find((filter) => filter.id === normalized.status);
  return jobs.filter((job) => {
    if (normalized.projectId !== 'all' && job.projectId !== normalized.projectId) {
      return false;
    }
    if (normalized.type !== 'all' && job.type !== normalized.type) {
      return false;
    }
    if (query && !searchableText(job, projectNameOf(job)).includes(query)) {
      return false;
    }
    return !status?.statuses || status.statuses.includes(job.status);
  });
}

/**
 * How many rows each status chip would show, with every other filter applied. A chip therefore
 * tells the person what selecting it would reveal in the current project, type and search.
 */
export function countByStatusFilter(jobs, filters, projectNameOf = () => '') {
  const withoutStatus = { ...normalizeQueueFilters(filters), status: 'all' };
  const matching = filterQueueJobs(jobs, withoutStatus, projectNameOf);
  return Object.fromEntries(
    STATUS_FILTERS.map((filter) => [
      filter.id,
      filter.statuses
        ? matching.filter((job) => filter.statuses.includes(job.status)).length
        : matching.length,
    ]),
  );
}

// Projects and types that appear in the queue, so the selects list only what can match.
export function queueProjectOptions(jobs, projects = []) {
  const ids = [...new Set(jobs.map((job) => job.projectId).filter(Boolean))];
  return ids.map((id) => ({
    id,
    name: projects.find((project) => project.id === id)?.name || 'Unnamed project',
  }));
}

export function queueTypeOptions(jobs) {
  return [...new Set(jobs.map((job) => job.type).filter(Boolean))].sort();
}

/**
 * Waiting renders the runtime may cancel from the page, in the order they appear. The runtime
 * applies the same rule again when it cancels, so a render that starts meanwhile is left alone.
 */
export function clearableWaitingJobs(jobs) {
  return jobs.filter((job) => WAITING_STATUSES.includes(job.status) && !job.remoteId);
}

// "2 min" or "3 h" from an ISO time; `now` is passed in so the result is deterministic in tests.
export function jobAgeSeconds(createdAt, now) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    return null;
  }
  return Math.max(0, Math.round((now - created) / 1000));
}

// A render's request size and step count when it has them (images, video, 3D and audio differ).
export function jobSizeAndSteps(job) {
  const request = job?.request || {};
  const parts = [];
  if (Number.isInteger(request.width) && Number.isInteger(request.height)) {
    parts.push(`${request.width}×${request.height}`);
  }
  const steps = request.num_inference_steps ?? request.steps;
  if (Number.isInteger(steps)) {
    parts.push(`${steps} steps`);
  }
  return parts.join(' · ');
}
