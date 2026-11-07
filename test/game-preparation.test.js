import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGameLoader,
  GAME_GPU_BUDGET_MIB,
  GAME_HOST_REQUIRED_BYTES,
} from '../runtime/game-preparation.js';

function fixture(overrides = {}) {
  const calls = [];
  const ready = { loaded: false, loading: false, load_finished: false, model_downloaded: true };
  const dependencies = {
    hardware: async () => ({ devices: [{ freeMiB: GAME_GPU_BUDGET_MIB + 2048 }] }),
    services: async () => [],
    startEngine: async () => ({ status: 'starting' }),
    activity: async () => ready,
    requestLoad: async () => {
      calls.push('load');
      return { status: 202, body: { accepted: true } };
    },
    freeMemory: () => GAME_HOST_REQUIRED_BYTES,
    wait: async () => {},
    ...overrides,
  };
  return {
    load: createGameLoader(dependencies),
    calls,
    mark: () => {
      calls.push('mark');
      return true;
    },
  };
}

test('Mammoth reserves the durable barrier before asking its worker to load', async () => {
  const f = fixture();
  const result = await f.load(f.mark);
  assert.equal(result.body.code, 'load_requested');
  assert.equal(result.keepBarrier, true);
  assert.deepEqual(f.calls, ['mark', 'load']);
});

test('insufficient GPU memory returns eligible offload choices without loading', async () => {
  const f = fixture({
    hardware: async () => ({ devices: [{ freeMiB: 1000 }] }),
    services: async () => [
      { id: 'tts', name: 'TTS', modelLoaded: true, managed: true, canUnload: true },
    ],
  });
  const result = await f.load(f.mark);
  assert.equal(result.body.code, 'insufficient_gpu_memory');
  assert.equal(result.body.candidates[0].id, 'tts');
  assert.deepEqual(f.calls, []);
});

test('external services are never started, loaded or stopped by this path', async () => {
  const f = fixture({
    services: async () => [{ id: 'game', status: 'reachable', managed: false, modelLoaded: false }],
    startEngine: async () => {
      throw Error('must not start');
    },
  });
  const result = await f.load(f.mark);
  assert.equal(result.body.code, 'external_service');
  assert.deepEqual(f.calls, []);
});

test('ambiguous submissions retain the barrier and a rejected load releases it', async () => {
  const uncertain = fixture({
    requestLoad: async () => {
      throw Error('connection lost');
    },
  });
  assert.equal((await uncertain.load(uncertain.mark)).keepBarrier, true);
  const rejected = fixture({
    requestLoad: async () => ({ status: 409, body: { error: 'missing files' } }),
  });
  const result = await rejected.load(rejected.mark);
  assert.equal(result.body.code, 'load_rejected');
  assert.notEqual(result.keepBarrier, true);
});

test('previous failed attempt requires a fresh worker before retry', async () => {
  const f = fixture({
    activity: async () => ({
      loaded: false,
      loading: false,
      load_finished: true,
      model_downloaded: true,
    }),
  });
  assert.equal((await f.load(f.mark)).body.code, 'previous_load_failed');
  assert.deepEqual(f.calls, []);
});
