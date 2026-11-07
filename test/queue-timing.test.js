import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateFromNearbyHistory, forecastQueue, formatDuration } from '../src/queue-timing.js';

const known = (seconds) => ({ available: true, typicalSeconds: seconds, confidence: 'limited' });
test('estimates a sequential queue from remaining running time and queued renders', () => {
  const jobs = [
    { id: 'running', status: 'running', startedAt: '2026-01-01T00:00:00Z' },
    { id: 'next', status: 'queued' },
    { id: 'later', status: 'queued' },
  ];
  const forecast = forecastQueue(
    jobs,
    { running: known(60), next: known(30), later: known(20) },
    Date.parse('2026-01-01T00:00:10Z'),
  );
  assert.equal(forecast.seconds, 100);
  assert.equal(forecast.perJob.next.waitSeconds, 50);
  assert.equal(forecast.perJob.later.waitSeconds, 80);
  assert.equal(formatDuration(forecast.seconds), '1m 40s');
});
test('does not promise a completion time when preparation or attention blocks the queue', () => {
  for (const status of [
    'preparing',
    'waiting_engine',
    'waiting_memory',
    'needs_attention',
    'interrupted',
  ]) {
    const forecast = forecastQueue(
      [
        { id: 'a', status },
        { id: 'b', status: 'queued' },
      ],
      { a: known(20), b: known(30) },
    );
    assert.equal(forecast.seconds, null, status);
    assert.equal(forecast.perJob.b.waitSeconds, null, status);
    if (status !== 'interrupted') {
      assert.equal(forecast.knownWorkSeconds, 50, status);
    }
    assert.equal(
      forecast.blocked,
      ['waiting_memory', 'needs_attention', 'interrupted'].includes(status),
      status,
    );
  }
});
test('uses a worker ETA but does not turn an overdue historical estimate into zero', () => {
  const job = {
    id: 'a',
    status: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    stage: 'Rendering video · step 4/8 · ETA 01:16',
  };
  assert.equal(
    forecastQueue([job], { a: known(30) }, Date.parse('2026-01-01T00:01:00Z')).seconds,
    76,
  );
  assert.equal(
    forecastQueue(
      [{ ...job, stage: 'Generating' }],
      { a: known(30) },
      Date.parse('2026-01-01T00:01:00Z'),
    ).seconds,
    null,
  );
  assert.equal(forecastQueue([], {}).seconds, 0);
});
test('nearby estimates are labeled rough and reject very different work or reference counts', () => {
  const jobs = [
    {
      type: 'sfx',
      status: 'completed',
      request: { duration: 5, steps: 4 },
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:10Z',
    },
  ];
  assert.deepEqual(estimateFromNearbyHistory('sfx', { duration: 5, steps: 8 }, jobs), {
    available: true,
    typicalSeconds: 20,
    sampleCount: 1,
    confidence: 'rough',
    note: 'Roughly scaled from completed renders with different but similar settings.',
  });
  assert.equal(estimateFromNearbyHistory('sfx', { duration: 20, steps: 8 }, jobs), null);
  assert.equal(estimateFromNearbyHistory('trellis', { steps: 8 }, jobs), null);
  const image = {
    type: 'images',
    status: 'completed',
    request: { width: 512, height: 512, num_inference_steps: 10, references: [] },
    startedAt: jobs[0].startedAt,
    finishedAt: jobs[0].finishedAt,
  };
  assert.equal(
    estimateFromNearbyHistory('images', { ...image.request, references: ['ref.png'] }, [image]),
    null,
  );
  assert.equal(
    estimateFromNearbyHistory('images', { ...image.request, true_cfg_scale: 3 }, [image]),
    null,
  );
  const music = {
    type: 'music',
    status: 'completed',
    request: { duration_seconds: 15, ode_steps: 16, cot: 'full', cfg_scale: null },
    startedAt: jobs[0].startedAt,
    finishedAt: jobs[0].finishedAt,
  };
  assert.equal(estimateFromNearbyHistory('music', { ...music.request, cot: 'off' }, [music]), null);
});
