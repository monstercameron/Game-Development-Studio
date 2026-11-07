import test from 'node:test';
import assert from 'node:assert/strict';
import { hostMemoryConflict, planModelLoad } from '../runtime/model-load.js';

test('system memory conflicts show safely managed, busy and external candidates', () => {
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
  assert.equal(result.shortfallBytes, 9 * 1024 ** 3);
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
