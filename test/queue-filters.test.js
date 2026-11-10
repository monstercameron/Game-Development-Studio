import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_QUEUE_FILTERS,
  clearableWaitingJobs,
  countByStatusFilter,
  filterQueueJobs,
  hasActiveQueueFilters,
  jobAgeSeconds,
  jobShortId,
  jobSizeAndSteps,
  normalizeQueueFilters,
  queueProjectOptions,
  queueTypeOptions,
} from '../src/queue-filters.js';

const projectNames = new Map([
  ['castle', 'Castle keep'],
  ['harbour', 'Harbour town'],
]);
const projectNameOf = (job) => projectNames.get(job.projectId) || 'Project';

const jobs = [
  {
    id: '11111111-aaaa',
    type: 'images',
    status: 'running',
    projectId: 'castle',
    request: { prompt: 'a red banner' },
  },
  {
    id: '22222222-bbbb',
    type: 'images',
    status: 'preparing',
    projectId: 'castle',
    request: { prompt: 'a red banner' },
  },
  {
    id: '33333333-cccc',
    type: 'images',
    status: 'queued',
    projectId: 'castle',
    request: { prompt: 'a blue gate' },
  },
  {
    id: '44444444-dddd',
    type: 'video',
    status: 'waiting_memory',
    projectId: 'harbour',
    request: { prompt: 'a ship at dusk' },
  },
  {
    id: '55555555-eeee',
    type: 'images',
    status: 'interrupted',
    projectId: 'harbour',
    request: { prompt: 'a lighthouse' },
    remoteId: 'remote-9',
  },
  {
    id: '66666666-ffff',
    type: 'sfx',
    status: 'failed',
    projectId: 'castle',
    request: { prompt: 'drum roll' },
  },
  {
    id: '77777777-0000',
    type: 'images',
    status: 'completed',
    projectId: 'harbour',
    request: { prompt: 'a quay' },
  },
  {
    id: '88888888-1111',
    type: 'images',
    status: 'cancelled',
    projectId: 'castle',
    request: { prompt: 'a moat' },
  },
  {
    id: '99999999-2222',
    type: 'images',
    status: 'queued',
    projectId: 'harbour',
    request: { prompt: 'a pier' },
    remoteId: 'remote-10',
  },
];

function idsOf(list) {
  return list.map((job) => job.id.slice(0, 8));
}

test('filters fall back to the default for anything not written by the page', () => {
  assert.deepEqual(normalizeQueueFilters(null), DEFAULT_QUEUE_FILTERS);
  assert.deepEqual(normalizeQueueFilters({ status: 'exploded', projectId: 7, type: '' }), {
    status: 'all',
    projectId: 'all',
    type: 'all',
    query: '',
  });
  const long = normalizeQueueFilters({ status: 'failed', query: 'x'.repeat(500) });
  assert.equal(long.status, 'failed');
  assert.equal(long.query.length, 200);
  assert.equal(hasActiveQueueFilters(DEFAULT_QUEUE_FILTERS), false);
  assert.equal(hasActiveQueueFilters({ ...DEFAULT_QUEUE_FILTERS, query: '  ' }), false);
  assert.equal(hasActiveQueueFilters({ ...DEFAULT_QUEUE_FILTERS, type: 'video' }), true);
});

test('each status filter covers its runtime statuses and nothing else', () => {
  const byStatus = (status) =>
    idsOf(filterQueueJobs(jobs, { ...DEFAULT_QUEUE_FILTERS, status }, projectNameOf));
  assert.deepEqual(byStatus('running'), ['11111111', '22222222']);
  assert.deepEqual(byStatus('waiting'), ['33333333', '44444444', '99999999']);
  assert.deepEqual(byStatus('attention'), ['55555555']);
  assert.deepEqual(byStatus('failed'), ['66666666']);
  assert.deepEqual(byStatus('completed'), ['77777777']);
  assert.deepEqual(byStatus('cancelled'), ['88888888']);
  assert.equal(byStatus('all').length, jobs.length);
});

test('project, type and search filters combine, and search reads the short id, prompt and project', () => {
  const castle = filterQueueJobs(
    jobs,
    { ...DEFAULT_QUEUE_FILTERS, projectId: 'castle' },
    projectNameOf,
  );
  assert.ok(castle.every((job) => job.projectId === 'castle'));
  const images = filterQueueJobs(
    jobs,
    { ...DEFAULT_QUEUE_FILTERS, projectId: 'castle', type: 'images' },
    projectNameOf,
  );
  assert.deepEqual(idsOf(images), ['11111111', '22222222', '33333333', '88888888']);
  assert.deepEqual(
    idsOf(filterQueueJobs(jobs, { ...DEFAULT_QUEUE_FILTERS, query: 'RED banner' }, projectNameOf)),
    ['11111111', '22222222'],
  );
  assert.deepEqual(
    idsOf(filterQueueJobs(jobs, { ...DEFAULT_QUEUE_FILTERS, query: '99999999' }, projectNameOf)),
    ['99999999'],
  );
  assert.deepEqual(
    idsOf(
      filterQueueJobs(jobs, { ...DEFAULT_QUEUE_FILTERS, query: 'harbour town' }, projectNameOf),
    ),
    ['44444444', '55555555', '77777777', '99999999'],
  );
});

test('status counts ignore the status filter but respect the others', () => {
  const counts = countByStatusFilter(
    jobs,
    { ...DEFAULT_QUEUE_FILTERS, status: 'failed', projectId: 'castle' },
    projectNameOf,
  );
  assert.equal(counts.all, 5);
  assert.equal(counts.running, 2);
  assert.equal(counts.waiting, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.completed, 0);
});

test('project and type options list only what is in the queue', () => {
  assert.deepEqual(queueProjectOptions(jobs, [{ id: 'castle', name: 'Castle keep' }]), [
    { id: 'castle', name: 'Castle keep' },
    { id: 'harbour', name: 'Unnamed project' },
  ]);
  assert.deepEqual(queueTypeOptions(jobs), ['images', 'sfx', 'video']);
});

test('clearing waiting renders only ever selects renders that have not started', () => {
  // Running, interrupted and renders with a remote job are never selected; the waiting ones are.
  assert.deepEqual(idsOf(clearableWaitingJobs(jobs)), ['33333333', '44444444']);
});

test('the view scope of clear covers only the filtered project, not the whole queue', () => {
  const viewScope = clearableWaitingJobs(
    filterQueueJobs(jobs, { ...DEFAULT_QUEUE_FILTERS, projectId: 'castle' }, projectNameOf),
  );
  assert.deepEqual(idsOf(viewScope), ['33333333']);
  assert.deepEqual(idsOf(clearableWaitingJobs(jobs)), ['33333333', '44444444']);
});

test('row helpers give a short id, a size and steps only when the request has them', () => {
  assert.equal(jobShortId(jobs[0]), '11111111');
  assert.equal(jobShortId({}), '');
  assert.equal(
    jobSizeAndSteps({ request: { width: 1024, height: 768, num_inference_steps: 30 } }),
    '1024×768 · 30 steps',
  );
  assert.equal(jobSizeAndSteps({ request: { steps: 8 } }), '8 steps');
  assert.equal(jobSizeAndSteps({ request: { width: 512 } }), '');
  assert.equal(jobSizeAndSteps({}), '');
});

test('age is measured from the creation time and is unknown for a bad time', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.equal(jobAgeSeconds('2026-11-09T11:58:30Z', now), 90);
  assert.equal(jobAgeSeconds('2026-11-09T13:00:00Z', now), 0);
  assert.equal(jobAgeSeconds('not a time', now), null);
});
