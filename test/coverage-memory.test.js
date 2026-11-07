import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoMemoryManager } from '../runtime/auto-memory.js';
import { createTrellisLoader } from '../runtime/trellis-preparation.js';

const statusResponse = () => ({
  ok: true,
  json: async () => ({
    engine: 'forge-trellis2-512-experimental-v1',
    loaded: false,
    model_downloaded: true,
  }),
});

test('TRELLIS load admission blocks on system memory before probing GPU memory', async () => {
  let hardwareProbes = 0,
    loadRequests = 0,
    serviceProbes = 0;
  const loader = createTrellisLoader({
    baseUrl: 'http://worker.invalid',
    fetcher: async (_url, options) => {
      if (options.method === 'POST') {
        loadRequests++;
        return { ok: true };
      }
      return statusResponse();
    },
    freeMemory: () => 7 * 1024 ** 3,
    hardware: async () => {
      hardwareProbes++;
      return { devices: [{ index: 0, freeMiB: 48 * 1024 }] };
    },
    services: async () => {
      serviceProbes++;
      return [];
    },
  });

  const result = await loader();

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'insufficient_host_memory');
  assert.equal(result.body.requiredBytes, 8 * 1024 ** 3);
  assert.equal(hardwareProbes, 0);
  assert.equal(serviceProbes, 1);
  assert.equal(loadRequests, 0);
});

test('TRELLIS load admission reports GPU shortage when system memory is available', async () => {
  let loadRequests = 0;
  const loader = createTrellisLoader({
    baseUrl: 'http://worker.invalid',
    fetcher: async (_url, options) => {
      if (options.method === 'POST') {
        loadRequests++;
        return { ok: true };
      }
      return statusResponse();
    },
    freeMemory: () => 12 * 1024 ** 3,
    hardware: async () => ({ devices: [{ index: 0, freeMiB: 5 * 1024 }] }),
    services: async () => [
      {
        id: 'tts',
        name: 'Speech',
        status: 'reachable',
        modelLoaded: true,
        managed: true,
        canUnload: true,
      },
    ],
  });

  const result = await loader();

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'insufficient_gpu_memory');
  assert.equal(result.body.candidates[0].id, 'tts');
  assert.equal(loadRequests, 0);
});

test('auto-memory cancellation after reservation releases it without announcing or stopping', async () => {
  let active = true,
    announced = 0,
    stopped = 0;
  const reserved = [],
    released = [];
  const manager = createAutoMemoryManager({
    services: async () => [
      {
        id: 'tts',
        status: 'reachable',
        managed: true,
        canUnload: true,
        busy: false,
        modelLoaded: true,
      },
    ],
    offload: async () => {
      stopped++;
      return { stopped: true };
    },
  });

  const result = await manager({
    target: 'music',
    isCurrent: () => active,
    announce: () => {
      announced++;
      return true;
    },
    reserve: (id) => {
      reserved.push(id);
      active = false;
    },
    release: (id) => released.push(id),
  });

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(reserved, ['tts']);
  assert.deepEqual(released, ['tts']);
  assert.equal(announced, 0);
  assert.equal(stopped, 0);
});
