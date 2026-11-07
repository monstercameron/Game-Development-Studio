import test from 'node:test';
import assert from 'node:assert/strict';
import { pageQueueStatus } from '../src/nav-queue-status.js';

test('page indicators count global work, including hidden jobs and model variants', () => {
  const jobs = [
    { type: 'world', status: 'running' },
    { type: 'world', status: 'queued' },
    { type: 'trellis', status: 'waiting_engine' },
    { type: 'motion-bricks', status: 'interrupted' },
    { type: 'sfx', status: 'completed' },
  ];
  assert.deepEqual(pageQueueStatus('world', jobs), {
    state: 'running',
    short: 'Running +1',
    detail: '1 running, 1 waiting across projects.',
  });
  assert.equal(pageQueueStatus('3d', jobs).short, '1 queued');
  assert.equal(pageQueueStatus('motion', jobs).state, 'attention');
  assert.equal(pageQueueStatus('sfx', jobs).state, 'free');
  assert.equal(pageQueueStatus('sfx', jobs).short, 'No jobs');
  assert.match(
    pageQueueStatus('sfx', jobs).detail,
    /does not indicate whether the model is loaded or the GPU is available/,
  );
  assert.equal(pageQueueStatus('chat', jobs), null);
});

test('unknown queue state never presents a page as free', () => {
  assert.equal(pageQueueStatus('world', [], { loading: true }).state, 'unknown');
  assert.equal(
    pageQueueStatus('world', [], { error: 'offline' }).detail,
    'Queue unavailable; page status is unknown.',
  );
});
