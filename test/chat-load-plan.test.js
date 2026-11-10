import test from 'node:test';
import assert from 'node:assert/strict';
import { planChatLoad } from '../runtime/chat-load-plan.js';

test('Qwen admission uses GPU memory rather than requiring a duplicate model-sized allocation in system RAM', async () => {
  let probes = 0;
  const plan = await planChatLoad({
    hardware: async () => ({ devices: [{ index: 0, name: 'NVIDIA GPU', freeMiB: 95 * 1024 }] }),
    services: async () => {
      probes++;
      return [];
    },
    contextSize: 4096,
  });
  assert.equal(plan.code, 'ready');
  // Qwen is admitted from GPU memory, so the admission check never queries other services.
  assert.equal(probes, 0);
});

test('Qwen still checks the selected GPU and reports offload candidates when it is full', async () => {
  const services = async () => [
    {
      id: 'video',
      name: 'Video',
      status: 'reachable',
      modelLoaded: true,
      managed: true,
      canUnload: true,
    },
  ];
  // A full GPU reports a managed, unloadable service as an offload candidate.
  const low = await planChatLoad({
    hardware: async () => ({ devices: [{ index: 0, freeMiB: 1024 }] }),
    services,
    contextSize: 4096,
  });
  assert.equal(low.code, 'insufficient_gpu_memory');
  assert.equal(low.candidates[0].id, 'video');
  // An empty device list is an unknown reading, not proof that the GPU is full.
  const unknown = await planChatLoad({
    hardware: async () => ({ devices: [] }),
    services,
    contextSize: 4096,
  });
  assert.equal(unknown.code, 'gpu_memory_unavailable');
});

test('96 GiB GPU admission accounts for other resident models once through free GPU memory', async () => {
  const GiB = 1024;
  const hardware = (usedMiB) => async () => ({
    devices: [
      { index: 0, name: 'NVIDIA Spark', totalMiB: 96 * GiB, usedMiB, freeMiB: 96 * GiB - usedMiB },
      { index: 1, name: 'NVIDIA NPU', totalMiB: null, usedMiB: null, freeMiB: null },
    ],
  });
  let probes = 0;
  const services = async () => {
    probes++;
    return [
      { id: 'images', name: 'Image model', managed: true, canUnload: true, modelLoaded: true },
    ];
  };
  const fits = await planChatLoad({ hardware: hardware(60 * GiB), services, contextSize: 4096 });
  assert.equal(fits.code, 'ready', '36 GiB free fits the estimated 21 GiB load');
  assert.equal(fits.device.totalMiB, 96 * GiB);
  assert.equal(probes, 0, 'resident models are already reflected in the free reading');
  const blocked = await planChatLoad({ hardware: hardware(78 * GiB), services, contextSize: 4096 });
  assert.equal(blocked.code, 'insufficient_gpu_memory');
  assert.equal(blocked.device.freeMiB, 18 * GiB);
  assert.equal(blocked.shortfallMiB, 3 * GiB);
  assert.equal(blocked.candidates[0].id, 'images');
  assert.equal(probes, 1);
});
