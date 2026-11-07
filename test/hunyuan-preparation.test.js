import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHunyuanLoader,
  createHunyuanPreparation,
  createHunyuanRenderPreparation,
} from '../runtime/hunyuan-preparation.js';

test('Hunyuan load requires host and GPU memory and protects uncertain submissions', async () => {
  let free = 1024,
    host = 1024,
    posts = 0;
  const fetcher = async (url, options = {}) => {
    if (url.endsWith('/api/status')) {
      return {
        ok: true,
        json: async () => ({
          engine: 'forge-hunyuan-shape-v1',
          phase: 'idle',
          loaded: false,
          model_downloaded: true,
        }),
      };
    }
    if (options.method === 'POST') {
      posts++;
      throw Error('Response lost');
    }
    throw Error('Unexpected');
  };
  const load = createHunyuanLoader({
    hardware: async () => ({ devices: [{ freeMiB: free }] }),
    services: async () => [{ id: 'tts', name: 'TTS', modelLoaded: true, canUnload: true }],
    baseUrl: 'http://127.0.0.1:8283',
    freeMemory: () => host,
    fetcher,
  });
  assert.equal((await load()).body.code, 'insufficient_host_memory');
  assert.equal(posts, 0);
  host = 16 * 1024 ** 3;
  const low = await load();
  assert.equal(low.body.code, 'insufficient_gpu_memory');
  assert.equal(low.body.candidates[0].id, 'tts');
  assert.equal(posts, 0);
  free = 30000;
  const unknown = await load();
  assert.equal(unknown.body.code, 'load_unknown');
  assert.equal(posts, 1);
  const prepare = createHunyuanPreparation({
    startEngine: async () => ({ status: 'starting' }),
    loadModel: load,
  });
  const state = await prepare({
    reachable: true,
    health: { phase: 'idle', model_downloaded: true },
    claimLoad: () => true,
  });
  assert.equal(state.loadBarrier, true);
  assert.equal(state.status, 'needs_attention');
});

test('Hunyuan checks additional working memory before each render', async () => {
  let host = 1024,
    free = 1000;
  const prepare = createHunyuanRenderPreparation({
    freeMemory: () => host,
    hardware: async () => ({ devices: [{ freeMiB: free }] }),
    services: async () => [
      { id: '3d-hunyuan', name: 'Hunyuan', modelLoaded: true, canUnload: true },
      { id: 'tts', name: 'TTS', modelLoaded: true, canUnload: true },
    ],
  });
  assert.equal((await prepare({ resolution: 128 })).status, 'waiting_memory');
  host = 8 * 1024 ** 3;
  const blocked = await prepare({ resolution: 128 });
  assert.equal(blocked.status, 'waiting_memory');
  assert.deepEqual(
    blocked.details.candidates.map((item) => item.id),
    ['tts'],
  );
  free = 30000;
  assert.equal(await prepare({ resolution: 128 }), null);
  assert.equal((await prepare({ resolution: 999 })).status, 'needs_attention');
});
