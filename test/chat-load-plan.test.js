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
  const low = await planChatLoad({
    hardware: async () => ({ devices: [{ index: 0, freeMiB: 1024 }] }),
    services,
    contextSize: 4096,
  });
  assert.equal(low.code, 'insufficient_gpu_memory');
  assert.equal(low.candidates[0].id, 'video');
  const unknown = await planChatLoad({
    hardware: async () => ({ devices: [] }),
    services,
    contextSize: 4096,
  });
  assert.equal(unknown.code, 'gpu_memory_unavailable');
});
