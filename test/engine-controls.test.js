import assert from 'node:assert/strict';
import test from 'node:test';
import {
  engineFacts,
  engineIdForJobType,
  gpuCoversRequirement,
  gpuMemoryText,
  stopServiceBlockReason,
  waitingJobsForEngine,
} from '../src/engine-controls.js';

test('a render type maps to the engine id the runtime uses for it', () => {
  assert.equal(engineIdForJobType('voices'), 'tts');
  assert.equal(engineIdForJobType('3d'), '3d-hunyuan');
  assert.equal(engineIdForJobType('trellis'), '3d-trellis');
  assert.equal(engineIdForJobType('motion'), 'motion-hy');
  assert.equal(engineIdForJobType('images'), 'images');
  // Vegetation runs on this computer with no model service, so it has no engine to stop.
  assert.equal(engineIdForJobType('vegetation'), null);
});

test('waiting jobs for an engine are the waiting ones of that engine only', () => {
  const queue = [
    { id: 'a', type: 'images', status: 'queued' },
    { id: 'b', type: 'images', status: 'running' },
    { id: 'c', type: 'voices', status: 'queued' },
    { id: 'd', type: 'images', status: 'waiting_memory' },
    { id: 'e', type: 'images', status: 'needs_attention' },
  ];
  assert.deepEqual(
    waitingJobsForEngine(queue, 'images').map((job) => job.id),
    ['a', 'd'],
  );
  assert.deepEqual(
    waitingJobsForEngine(queue, 'tts').map((job) => job.id),
    ['c'],
  );
});

test('Stop service is available only when the runtime reports the service can be unloaded', () => {
  assert.equal(stopServiceBlockReason({ id: 'images', canUnload: true }), null);
  assert.equal(stopServiceBlockReason(null), 'The service state is not known yet.');
  assert.match(
    stopServiceBlockReason({ id: 'images', status: 'unavailable', canUnload: false }),
    /not running/,
  );
  assert.match(
    stopServiceBlockReason({ id: 'images', status: 'reachable', busy: true, canUnload: false }),
    /A render is using this service/,
  );
  assert.match(
    stopServiceBlockReason({
      id: 'images',
      status: 'reachable',
      busy: false,
      managed: false,
      canUnload: false,
    }),
    /runs in its own app/,
  );
  assert.match(
    stopServiceBlockReason({
      id: 'chat',
      status: 'reachable',
      busy: false,
      managed: true,
      canUnload: false,
    }),
    /Qwen is idle/,
  );
  assert.match(
    stopServiceBlockReason({
      id: 'images',
      status: 'reachable',
      busy: false,
      managed: true,
      canUnload: false,
    }),
    /cannot verify that this service is idle/,
  );
});

test('GPU memory text sums the devices that report it and says nothing when none do', () => {
  assert.equal(
    gpuMemoryText({
      devices: [
        { usedMiB: 4096, totalMiB: 16384 },
        { usedMiB: 2048, totalMiB: 8192 },
      ],
    }),
    '6.0 of 24.0 GiB in use',
  );
  assert.equal(gpuMemoryText({ devices: [{ usedMiB: null, totalMiB: 8192 }] }), null);
  assert.equal(gpuMemoryText(null), null);
});

test('engine facts show unknown values as unknown rather than guessing', () => {
  const facts = engineFacts(
    { status: 'reachable', busy: true, modelLoaded: undefined, managed: true },
    { devices: [{ usedMiB: 1024, totalMiB: 2048 }] },
  );
  assert.deepEqual(facts, [
    { label: 'Engine', value: 'Reachable' },
    { label: 'Busy with a render', value: 'Yes' },
    { label: 'Model loaded', value: 'Unknown' },
    { label: 'Process verified as Forge’s', value: 'Yes' },
    { label: 'GPU memory', value: '1.0 of 2.0 GiB in use' },
  ]);
  const missing = engineFacts(null, null);
  assert.equal(missing[0].value, 'Unknown');
  assert.equal(missing[4].value, 'Unavailable');
  assert.equal(engineFacts({ status: 'unverified' }, null)[0].value, 'Not reachable (unverified)');
});

test('the GPU requirement comparison is unknown unless both numbers are known', () => {
  assert.equal(gpuCoversRequirement(21, 22), true);
  assert.equal(gpuCoversRequirement(21, 19.5), false);
  assert.equal(gpuCoversRequirement(21, null), null);
  assert.equal(gpuCoversRequirement(undefined, 19.5), null);
});
