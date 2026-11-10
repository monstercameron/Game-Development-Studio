import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hostMemoryConflict,
  hostMemoryShort,
  planModelLoad,
  setHostMemoryPolicySource,
} from '../runtime/model-load.js';

test('system memory conflicts show safely managed, busy and external candidates', () => {
  // Fixture roles: idle is managed and safe to unload; busy is managed but mid-job, so it
  // cannot be unloaded; external is unmanaged, so it is listed without unload rights; target
  // is the model being loaded; offline holds no memory and must be skipped.
  const services = [
    {
      id: 'idle',
      name: 'Idle',
      status: 'reachable',
      modelLoaded: true,
      managed: true,
      canUnload: true,
    },
    {
      id: 'busy',
      name: 'Busy',
      status: 'reachable',
      modelLoaded: true,
      managed: true,
      canUnload: true,
      busy: true,
    },
    {
      id: 'external',
      name: 'External',
      status: 'reachable',
      modelLoaded: null,
      managed: false,
      canUnload: true,
      url: 'http://127.0.0.1:8791',
    },
    { id: 'target', name: 'Target', modelLoaded: true, managed: true, canUnload: true },
    { id: 'offline', name: 'Offline', status: 'unavailable', modelLoaded: false },
  ];
  const result = hostMemoryConflict(3 * 1024 ** 3, 12 * 1024 ** 3, services, ['target']);
  assert.equal(result.requiredBytes, 2 * 1024 ** 3);
  assert.equal(result.estimatedBytes, 12 * 1024 ** 3);
  assert.equal(result.shortfallBytes, 0);
  assert.equal(result.hostPolicy, 'soft');
  assert.deepEqual(
    result.candidates.map((s) => s.id),
    ['idle', 'busy', 'external'],
  );
  assert.deepEqual(
    result.candidates.map((s) => s.canUnload),
    [true, false, false],
  );
  assert.equal(result.candidates[2].url, 'http://127.0.0.1:8791');
  assert.equal(hostMemoryConflict(NaN, 12, []).shortfallBytes, null);
  const gpu = planModelLoad({ devices: [{ index: 0, freeMiB: 1 }] }, services, 1024);
  assert.equal(gpu.code, 'insufficient_gpu_memory');
  assert.equal(gpu.candidates.find((s) => s.id === 'external').canUnload, false);
});

test('host shortfalls report the configured soft floor or strict budget, not GPU capacity', (t) => {
  const GiB = 1024 ** 3;
  t.after(() => setHostMemoryPolicySource());
  setHostMemoryPolicySource(() => 'soft');
  assert.equal(hostMemoryShort(7 * GiB, 21 * GiB), false);
  const soft = hostMemoryConflict(GiB, 21 * GiB, []);
  assert.equal(soft.requiredBytes, 2 * GiB);
  assert.equal(soft.estimatedBytes, 21 * GiB);
  assert.equal(soft.shortfallBytes, GiB);
  setHostMemoryPolicySource(() => 'strict');
  assert.equal(hostMemoryShort(7 * GiB, 21 * GiB), true);
  const strict = hostMemoryConflict(7 * GiB, 21 * GiB, []);
  assert.equal(strict.requiredBytes, 21 * GiB);
  assert.equal(strict.shortfallBytes, 14 * GiB);
  assert.equal(strict.hostPolicy, 'strict');
});
