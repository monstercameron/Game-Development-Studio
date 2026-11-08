import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAsrStarter, probeAsr } from '../runtime/asr-preparation.js';
import { planModelLoad } from '../runtime/model-load.js';
import { JobQueue } from '../runtime/jobs.js';
import { EngineManager } from '../runtime/engines.js';
import { createServer } from 'node:net';

test('ASR admission refuses low or unknown GPU memory before starting the native model', async () => {
  let starts = 0,
    claims = 0,
    freeMiB = 1000;
  const starter = createAsrStarter({
    hardware: async () => ({ devices: freeMiB === null ? [] : [{ freeMiB }] }),
    services: async () => [{ id: 'tts', name: 'TTS', modelLoaded: true, canUnload: true }],
    startEngine: async () => {
      starts++;
      return { status: 'starting' };
    },
    checkFile: async () => {},
    modelFile: 'test',
    baseUrl: 'http://127.0.0.1:8282',
    fetcher: async () => {
      throw Error('offline');
    },
  });
  const begin = () => {
    claims++;
    return true;
  };
  let result = await starter(begin);
  assert.equal(result.body.code, 'insufficient_gpu_memory');
  assert.equal(result.body.candidates[0].id, 'tts');
  assert.equal(starts, 0);
  assert.equal(claims, 0);
  freeMiB = null;
  result = await starter(begin);
  assert.equal(result.body.code, 'gpu_memory_unavailable');
  assert.equal(starts, 0);
  freeMiB = 100000;
  result = await starter(begin);
  assert.equal(result.body.code, 'load_requested');
  assert.equal(result.keepBarrier, true);
  assert.equal(starts, 1);
  assert.equal(claims, 1);
});

test('GPU memory choices distinguish a busy managed speech service from an idle one', () => {
  const hardware = { devices: [{ freeMiB: 500 }] };
  const result = planModelLoad(
    hardware,
    [{ id: 'asr', name: 'Speech', modelLoaded: true, managed: true, busy: true, canUnload: false }],
    4096,
  );
  assert.deepEqual(
    result.candidates.map(({ id, name, managed, busy, canUnload }) => ({
      id,
      name,
      managed,
      busy,
      canUnload,
    })),
    [{ id: 'asr', name: 'Speech', managed: true, busy: true, canUnload: false }],
  );
  const idle = planModelLoad(
    hardware,
    [{ id: 'asr', name: 'Speech', modelLoaded: true, managed: true, busy: false, canUnload: true }],
    4096,
  );
  assert.equal(idle.candidates[0].canUnload, true);
  assert.equal(idle.candidates[0].busy, false);
});

test('ASR retains the persisted barrier when process startup outcome is unknown', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-asr-barrier-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = new JobQueue({ directory: dir, autoStart: false, leaseMs: 50 });
  first.suspendForModelLoad('asr');
  const starter = createAsrStarter({
    hardware: async () => ({ devices: [{ freeMiB: 100000 }] }),
    services: async () => [],
    startEngine: async () => {
      throw Error('Connection lost');
    },
    checkFile: async () => {},
    modelFile: 'test',
    baseUrl: 'http://127.0.0.1:8282',
    fetcher: async () => {
      throw Error('offline');
    },
  });
  const result = await starter(() => first.markModelLoadRequested('asr'));
  assert.equal(result.body.code, 'load_unknown');
  assert.equal(result.keepBarrier, true);
  first.stop();
  await new Promise((resolve) => setTimeout(resolve, 70));
  const second = new JobQueue({ directory: dir, autoStart: false, leaseMs: 50 });
  try {
    assert.equal(second.lease(), true);
    assert.equal(second.modelLoadEngine, 'asr');
    assert.equal(second.modelLoadState, 'loading');
  } finally {
    second.stop();
  }
});

test('ASR releases its load barrier when model files are being removed', async () => {
  const starter = createAsrStarter({
    hardware: async () => ({ devices: [{ freeMiB: 100000 }] }),
    services: async () => [],
    startEngine: async () => ({ status: 'deleting', message: 'Model removal in progress.' }),
    checkFile: async () => {},
    modelFile: 'test',
    baseUrl: 'http://127.0.0.1:8282',
    fetcher: async () => {
      throw Error('offline');
    },
  });
  const result = await starter(() => true);
  assert.equal(result.status, 409);
  assert.equal(result.keepBarrier, false);
  assert.match(result.body.message, /removal/);
});

test('ASR readiness verifies the expected streaming model', async () => {
  const response = (json) => async () => ({ ok: true, json: async () => json });
  assert.equal(
    await probeAsr(
      'http://127.0.0.1:8282',
      response({ data: [{ id: 'other', capability: 'transcription', streaming: true }] }),
    ),
    false,
  );
  assert.equal(
    await probeAsr(
      'http://127.0.0.1:8282',
      response({
        data: [
          {
            id: '.nemotron-speech-streaming-en-0.6b.q8_0.gguf',
            capability: 'transcription',
            streaming: true,
          },
        ],
      }),
    ),
    true,
  );
});

test('on-demand ASR is excluded from bulk startup and cannot automatically reload after a crash', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-asr-engine-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const events = [];
  const manager = new EngineManager({
    logDir: dir,
    logger: (message) => events.push(message),
    definitions: [
      {
        id: 'asr',
        name: 'ASR test',
        port,
        endpoint: '/v1/models',
        kind: 'nemotron-asr',
        cwd: dir,
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
        onDemand: true,
        noRestart: true,
      },
    ],
  });
  assert.equal((await manager.startAll()).services[0].status, 'on_demand');
  assert.equal(manager.owns('asr'), false);
  assert.equal((await manager.start('asr')).status, 'starting');
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(manager.owns('asr'), false);
  assert.equal(events.filter((line) => line.includes('exited')).length, 1);
});
