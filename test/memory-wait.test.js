import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU_READING_MAX_AGE_MS, readGpuMemory } from '../runtime/gpu-memory.js';
import { planModelLoad } from '../runtime/model-load.js';
import { createImagePreparation } from '../runtime/image-preparation.js';
import { expiredMemoryWaitMessage, nextMemoryWait } from '../runtime/memory-wait.js';

// Memory in this file is MiB; one GiB is 1024 MiB.
const GiB = 1024;
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const isoAgo = (ms) => new Date(NOW - ms).toISOString();

test('the GPU reading is never negative, never above the total and never stale', () => {
  const fresh = readGpuMemory(
    { freeMiB: 20 * GiB, totalMiB: 96 * GiB },
    { measuredAt: isoAgo(2000), now: NOW },
  );
  assert.deepEqual(
    { ok: fresh.ok, freeMiB: fresh.freeMiB, ageMs: fresh.ageMs, isDerived: fresh.isDerived },
    { ok: true, freeMiB: 20 * GiB, ageMs: 2000, isDerived: false },
  );
  // Unified memory can report free as unavailable; total minus used is the same measurement.
  const derived = readGpuMemory({ freeMiB: null, totalMiB: 96 * GiB, usedMiB: 78 * GiB });
  assert.equal(derived.freeMiB, 18 * GiB);
  assert.equal(derived.isDerived, true);
  // More used than total, or free above the total, are clamped into range.
  assert.equal(readGpuMemory({ freeMiB: null, totalMiB: 10, usedMiB: 12 }).freeMiB, 0);
  assert.equal(readGpuMemory({ freeMiB: 100 * GiB, totalMiB: 96 * GiB }).freeMiB, 96 * GiB);
  // A negative or missing value is not a reading, and an old snapshot is not trusted.
  assert.equal(readGpuMemory({ freeMiB: -5 }).reason, 'missing');
  assert.equal(readGpuMemory({ freeMiB: null }).reason, 'missing');
  const stale = readGpuMemory(
    { freeMiB: 60 * GiB },
    { measuredAt: isoAgo(GPU_READING_MAX_AGE_MS + 1), now: NOW },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.match(stale.message, /seconds old/);
  // A snapshot without a timestamp has an unknown age and is accepted as before.
  assert.equal(readGpuMemory({ freeMiB: 1 }).ageMs, null);
});

test('admission plans use the one reading and report when it was measured', () => {
  const device = { index: 0, name: 'GPU', freeMiB: 20 * GiB, totalMiB: 96 * GiB };
  const measuredAt = isoAgo(1500);
  const waiting = planModelLoad({ devices: [device], measuredAt }, [], 21 * GiB, { now: NOW });
  assert.equal(waiting.code, 'insufficient_gpu_memory');
  assert.equal(waiting.device.freeMiB, 20 * GiB);
  assert.deepEqual(waiting.reading, { measuredAt, ageMs: 1500 });
  assert.ok(waiting.shortfallMiB > 0);
  const stale = planModelLoad({ devices: [device], measuredAt: isoAgo(120000) }, [], GiB, {
    now: NOW,
  });
  assert.equal(stale.code, 'gpu_memory_unavailable');
  assert.match(stale.message, /120 seconds old/);
  const missing = planModelLoad({ devices: [{ ...device, freeMiB: -1 }] }, [], GiB);
  assert.equal(missing.code, 'gpu_memory_unavailable');
});

test('a resident model needs only its working memory; a model to load needs the model too', async () => {
  const request = { width: 1664, height: 928 };
  const hardware = async () => ({
    devices: [{ index: 0, name: 'GPU', freeMiB: 25 * GiB, totalMiB: 96 * GiB }],
  });
  const prepare = createImagePreparation({ hardware, services: async () => [] });
  assert.equal(await prepare(request, true), null);
  const notLoaded = await prepare(request, false);
  assert.equal(notLoaded.status, 'waiting_memory');
  assert.equal(notLoaded.details.basis, 'model_plus_working_memory');
  assert.ok(notLoaded.details.requiredMiB > 48 * GiB);
  const short = createImagePreparation({
    hardware: async () => ({
      devices: [{ index: 0, name: 'GPU', freeMiB: 20 * GiB, totalMiB: 96 * GiB }],
    }),
    services: async () => [],
  });
  const resident = await short(request, true);
  assert.equal(resident.details.basis, 'working_memory_only');
  assert.equal(resident.details.releasableLoadedModel, true);
});

test('a memory wait keeps its start, counts checks and expires at the limit', () => {
  const details = {
    code: 'insufficient_gpu_memory',
    requiredMiB: 21 * GiB,
    shortfallMiB: GiB,
    device: { freeMiB: 20 * GiB, totalMiB: 96 * GiB },
    reading: { measuredAt: isoAgo(500), ageMs: 500 },
    estimate: 'Conservative uncalibrated estimate.',
  };
  const limitMs = 60000;
  const first = nextMemoryWait({ details, previous: null, now: NOW, intervalMs: 5000, limitMs });
  assert.equal(first.isExpired, false);
  assert.equal(first.record.checks, 1);
  assert.equal(first.record.since, new Date(NOW).toISOString());
  assert.equal(first.record.nextCheckAt, new Date(NOW + 5000).toISOString());
  assert.equal(first.record.expiresAt, new Date(NOW + limitMs).toISOString());
  assert.equal(first.record.estimate, 'conservative_estimate');
  assert.equal(first.record.readingAt, isoAgo(500));
  const second = nextMemoryWait({
    details: { ...details, device: { freeMiB: -3 } },
    previous: { ...first.record, lastAction: { outcome: 'unavailable' } },
    now: NOW + 5000,
    intervalMs: 5000,
    limitMs,
  });
  assert.equal(second.record.since, first.record.since);
  assert.equal(second.record.checks, 2);
  assert.equal(second.record.availableMiB, 0, 'a bad reading is never shown as negative memory');
  assert.deepEqual(second.record.lastAction, { outcome: 'unavailable' });
  const last = nextMemoryWait({
    details: { ...details, calibrated: true },
    previous: second.record,
    now: NOW + limitMs,
    intervalMs: 5000,
    limitMs,
  });
  assert.equal(last.isExpired, true);
  assert.equal(last.record.nextCheckAt, null);
  assert.equal(last.record.estimate, 'calibrated');
  assert.match(expiredMemoryWaitMessage(last.record), /after waiting 1 min for gpu memory/);
  // A queue that does not check on its own has no next check to promise.
  const manual = nextMemoryWait({ details, previous: null, now: NOW, intervalMs: null, limitMs });
  assert.equal(manual.record.nextCheckAt, null);
});

test('a system memory wait is reported in MiB too', () => {
  const { record } = nextMemoryWait({
    details: {
      code: 'insufficient_host_memory',
      freeBytes: 4 * 1024 ** 3,
      requiredBytes: 12 * 1024 ** 3,
      shortfallBytes: 8 * 1024 ** 3,
    },
    previous: null,
    now: NOW,
    intervalMs: 5000,
    limitMs: 60000,
  });
  assert.equal(record.memory, 'system');
  assert.deepEqual(
    [record.requiredMiB, record.availableMiB, record.shortfallMiB],
    [12 * GiB, 4 * GiB, 8 * GiB],
  );
});
