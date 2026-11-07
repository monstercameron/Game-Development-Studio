import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateFromNearbyHistory, forecastQueue, formatDuration } from '../src/queue-timing.js';

const known = (seconds, confidence = 'limited') => ({
  available: true,
  typicalSeconds: seconds,
  confidence,
});

const completed = (type, request, seconds, id = 'sample') => ({
  id,
  type,
  status: 'completed',
  request,
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString(),
});

test('duration formatting rounds up and changes units at readable boundaries', () => {
  assert.equal(formatDuration(0), '1s');
  assert.equal(formatDuration(0.01), '1s');
  assert.equal(formatDuration(59.1), '1m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(3661), '1h 1m');
  assert.equal(formatDuration(-1), 'Unknown');
  assert.equal(formatDuration(Number.NaN), 'Unknown');
});

test('nearby history uses the middle valid sample and ignores unusable records', () => {
  const history = [
    completed('sfx', { duration: 4, steps: 4 }, 80, 'long'),
    completed('sfx', { duration: 4, steps: 4 }, 20, 'short'),
    completed('sfx', { duration: 4, steps: 4 }, 40, 'middle'),
    { ...completed('sfx', { duration: 4, steps: 4 }, 5), status: 'failed' },
    { ...completed('sfx', { duration: 4, steps: 4 }, 5), type: 'music' },
    { ...completed('sfx', { duration: 4, steps: 4 }, 5), finishedAt: 'not a date' },
    { ...completed('sfx', { duration: 4, steps: 4 }, 0), id: 'zero-duration' },
  ];

  const estimate = estimateFromNearbyHistory('sfx', { duration: 4, steps: 4 }, history);
  assert.equal(estimate.typicalSeconds, 40);
  assert.equal(estimate.sampleCount, 3);
  assert.equal(estimate.confidence, 'rough');
  assert.equal(estimateFromNearbyHistory('unsupported', {}, history), null);
});

test('nearby samples retain compatibility for motion guidance and Trellis texture settings', () => {
  const motion = completed('motion', { duration: 5, steps: 4, guidance: 1 }, 20);
  assert.equal(
    estimateFromNearbyHistory('motion', { duration: 5, steps: 4, guidance: 2 }, [motion]),
    null,
  );

  const trellis = completed('trellis', { steps: 8, texture_size: 1024 }, 30);
  assert.equal(
    estimateFromNearbyHistory('trellis', { steps: 8, texture_size: 2048 }, [trellis]),
    null,
  );
  assert.equal(
    estimateFromNearbyHistory('trellis', { steps: 8, texture_size: 1024 }, [trellis])
      .typicalSeconds,
    30,
  );
});

test('queue forecast reads worker ETA forms and ignores malformed ETA values', () => {
  const job = { id: 'active', status: 'running' };
  const forecast = (stage) => forecastQueue([{ ...job, stage }], {}, 0).seconds;

  assert.equal(forecast('ETA 1:02:03'), 3723);
  assert.equal(forecast('ETA 02:03'), 123);
  assert.equal(forecast('ETA 1:75'), null);
  assert.equal(forecast('ETA 2:04:90'), null);
  assert.equal(forecast('ETA soon'), null);
});

test('forecast excludes terminal jobs and reports known work despite unknown queue timing', () => {
  const jobs = [
    { id: 'finished', status: 'completed' },
    { id: 'preparing', status: 'preparing' },
    { id: 'queued', status: 'queued' },
  ];
  const forecast = forecastQueue(jobs, { preparing: known(12), queued: known(8, 'rough') });

  assert.equal(forecast.count, 2);
  assert.equal(forecast.seconds, null);
  assert.equal(forecast.knownWorkSeconds, 20);
  assert.equal(forecast.knownWorkCount, 2);
  assert.equal(forecast.hasRough, true);
  assert.equal(forecast.perJob.queued.waitSeconds, null);
  assert.equal(forecast.perJob.finished, undefined);
});

test('forecast stops assigning waits after its estimate limit', () => {
  const jobs = [
    { id: 'first', status: 'queued' },
    { id: 'second', status: 'queued' },
  ];
  const forecast = forecastQueue(jobs, { first: known(5), second: known(7) }, 0, 1);

  assert.equal(forecast.seconds, null);
  assert.equal(forecast.perJob.first.waitSeconds, 0);
  assert.equal(forecast.perJob.second.waitSeconds, null);
  assert.match(forecast.reason, /Too many jobs/);
});
