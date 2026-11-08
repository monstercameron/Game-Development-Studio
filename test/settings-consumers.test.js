import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planChainUnload, resolveChainUnloadOption } from '../runtime/chain-unload.js';
import { createSettings } from '../runtime/core-settings.js';
import { createHunyuanPreparation } from '../runtime/hunyuan-preparation.js';
import { createHyMotionPreparation } from '../runtime/hymotion-preparation.js';
import { hostMemoryShort, setHostMemoryPolicySource } from '../runtime/model-load.js';
import { createMotionBricksPreparation } from '../runtime/motionbricks-preparation.js';
import { createMusicPreparation } from '../runtime/music-preparation.js';
import { createRecoverService } from '../runtime/recover-service.js';
import { createSam31Preparation } from '../runtime/sam31-preparation.js';
import {
  autoStartsService,
  createServicePreparation,
  gatePreparation,
  resolveAutoStart,
} from '../runtime/service-preparation.js';
import { createSoundPreparation } from '../runtime/sound-preparation.js';
import { createTrellisPreparation } from '../runtime/trellis-preparation.js';
import { createTtsPreparation } from '../runtime/tts-preparation.js';

const GiB = 1024 ** 3;
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function makeSettings(t, env = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-consumers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 }));
  // cacheMs 0: a change made by another process shows on the next read, as it does after 1.5 s.
  return createSettings({ directory, env, cacheMs: 0 });
}

test('resolveAutoStart accepts a boolean or a live function', () => {
  assert.equal(resolveAutoStart(true), true);
  assert.equal(resolveAutoStart(false), false);
  let value = true;
  const live = () => value;
  assert.equal(resolveAutoStart(live), true);
  value = false;
  assert.equal(resolveAutoStart(live), false);
});

const PREPARATIONS = [
  ['music', createMusicPreparation, 'music'],
  ['sound', createSoundPreparation, 'sfx'],
  ['tts', createTtsPreparation, 'tts'],
  ['hunyuan', createHunyuanPreparation, '3d'],
  ['trellis', createTrellisPreparation, '3d-trellis'],
  ['sam31', createSam31Preparation, 'segmentation'],
  ['hymotion', createHyMotionPreparation, 'motion-hy'],
  ['motionbricks', createMotionBricksPreparation, 'motion-bricks'],
];

for (const [name, factory] of PREPARATIONS) {
  test(`engines.autoStart.${name} is honoured by the next job without a restart`, async (t) => {
    const settings = makeSettings(t);
    const started = [];
    const prepare = factory({
      startEngine: async (id) => {
        started.push(id);
        return { status: 'started' };
      },
      loadModel: async () => ({ status: 200, body: {} }),
      autoStart: () => settings.get(`engines.autoStart.${name}`),
    });
    const unreachable = { reachable: false, health: null, claimLoad: () => true };

    const first = await prepare(unreachable);
    assert.equal(started.length, 1, 'on by default: the worker is started');
    assert.match(first.stage, /Starting/);

    await settings.set([{ key: `engines.autoStart.${name}`, value: false }]);
    const waiting = await prepare(unreachable);
    assert.equal(started.length, 1, 'switched off: the same prepare function starts nothing');
    assert.equal(waiting.status, 'waiting_engine');
    assert.match(waiting.stage, /^Waiting for the/);

    await settings.reset({ key: `engines.autoStart.${name}` });
    await prepare(unreachable);
    assert.equal(started.length, 2, 'back on without recreating anything');
  });
}

test('an environment variable still beats the saved setting for every consumer', async (t) => {
  const settings = makeSettings(t, { FORGE_TRELLIS_URL: 'http://127.0.0.1:9' });
  const started = [];
  const prepare = createTrellisPreparation({
    startEngine: async (id) => {
      started.push(id);
      return { status: 'started' };
    },
    loadModel: async () => ({}),
    autoStart: () => settings.get('engines.autoStart.trellis'),
  });
  await prepare({ reachable: false, health: null, claimLoad: () => true });
  assert.deepEqual(started, [], 'an external TRELLIS.2 service is never started by the queue');
  await assert.rejects(
    settings.set([{ key: 'engines.autoStart.trellis', value: true }]),
    /FORGE_TRELLIS_URL/,
  );

  const opted = makeSettings(t, {
    FORGE_TRELLIS_URL: 'http://127.0.0.1:9',
    FORGE_AUTO_START_TRELLIS: '1',
  });
  assert.equal(opted.get('engines.autoStart.trellis'), true);
});

test('autoStartsService follows the live setting and keeps its legacy environment rule', async (t) => {
  const settings = makeSettings(t);
  const read = (key) => settings.get(key);
  assert.equal(autoStartsService('images', {}, read), true);
  await settings.set([{ key: 'engines.autoStart.images', value: false }]);
  assert.equal(autoStartsService('images', {}, read), false);
  assert.equal(autoStartsService('video', {}, read), true);
  await settings.set([
    { key: 'engines.autoStart.video', value: false },
    { key: 'engines.autoStart.world', value: false },
    { key: 'engines.autoStart.sound', value: false },
  ]);
  assert.equal(autoStartsService('video', {}, read), false);
  assert.equal(autoStartsService('world', {}, read), false);
  assert.equal(autoStartsService('sfx', {}, read), false);
  // Without the accessor nothing changes: the pure environment rules the older tests pin down.
  assert.equal(autoStartsService('images', {}), true);
  assert.equal(autoStartsService('images', { FORGE_IMAGE_URL: 'x' }), false);
  assert.equal(
    autoStartsService('video', { FORGE_VIDEO_URL: 'x', FORGE_AUTO_START_VIDEO: '1' }),
    true,
  );
  assert.equal(autoStartsService('sfx', { FORGE_SFX_URL: 'x' }), false);
});

test('the generic service preparation starts a worker only while the setting allows it', async (t) => {
  const settings = makeSettings(t);
  const started = [];
  const prepare = createServicePreparation({
    startEngine: async (id) => {
      started.push(id);
      return { status: 'started' };
    },
    autoStart: (type) => autoStartsService(type, {}, (key) => settings.get(key)),
  });
  assert.match(
    (await prepare({ type: 'video', reachable: false })).stage,
    /Starting the H3 Studio/,
  );
  await settings.set([{ key: 'engines.autoStart.video', value: false }]);
  const waiting = await prepare({ type: 'video', reachable: false });
  assert.match(waiting.stage, /Waiting for the configured H3 Studio worker/);
  assert.deepEqual(started, ['video']);
});

test('turning model auto-loading off sends music and sound renders down the waiting path', async (t) => {
  const settings = makeSettings(t);
  const calls = [];
  const loader = async (input) => {
    calls.push(['loader', input.reachable]);
    return { status: 'waiting_engine', stage: 'loader' };
  };
  const service = async (input) => {
    calls.push(['service', input.type]);
    return { status: 'waiting_engine', stage: 'service' };
  };
  const prepare = gatePreparation(
    loader,
    () => settings.get('engines.autoPrepare.music'),
    ({ reachable, health }) => service({ type: 'music', reachable, health }),
  );
  assert.equal((await prepare({ reachable: true })).stage, 'loader');
  await settings.set([{ key: 'engines.autoPrepare.music', value: false }]);
  assert.equal((await prepare({ reachable: true })).stage, 'service');
  assert.deepEqual(calls, [
    ['loader', true],
    ['service', 'music'],
  ]);
  const withEnv = makeSettings(t, { FORGE_AUTO_PREPARE_SOUND: '0' });
  assert.equal(withEnv.get('engines.autoPrepare.sound'), false);
});

test('crash recovery restarts a worker only while its auto-start setting is on', async (t) => {
  const settings = makeSettings(t);
  const started = [];
  const recover = createRecoverService({
    startEngine: async (id) => {
      started.push(id);
      return { status: 'started' };
    },
    readSetting: (key) => settings.get(key),
  });
  await recover('trellis');
  await settings.set([{ key: 'engines.autoStart.trellis', value: false }]);
  await recover('trellis');
  await recover('voices');
  assert.deepEqual(started, ['3d-trellis', 'tts']);
  // The environment-only form is unchanged.
  const legacy = [];
  const plain = createRecoverService({
    env: { FORGE_TTS_URL: 'x' },
    startEngine: async (id) => legacy.push(id) && { status: 'started' },
  });
  await plain('voices');
  await plain('trellis');
  assert.deepEqual(legacy, ['3d-trellis']);
});

test('memory.hostPolicy changes the host memory check at once, and the environment wins', async (t) => {
  const settings = makeSettings(t);
  t.after(() => setHostMemoryPolicySource());
  setHostMemoryPolicySource(() => settings.get('memory.hostPolicy'));
  assert.equal(hostMemoryShort(7 * GiB, 12 * GiB), false, 'soft by default');
  await settings.set([{ key: 'memory.hostPolicy', value: 'strict' }]);
  assert.equal(hostMemoryShort(7 * GiB, 12 * GiB), true, 'strict needs the full budget');
  assert.equal(hostMemoryShort(12 * GiB, 12 * GiB), false);
  assert.equal(hostMemoryShort(7 * GiB, 12 * GiB, 'soft'), false, 'an explicit policy still wins');
  await settings.reset({ key: 'memory.hostPolicy' });
  assert.equal(hostMemoryShort(7 * GiB, 12 * GiB), false);

  const strictEnvironment = makeSettings(t, { FORGE_HOST_MEMORY_POLICY: 'strict' });
  setHostMemoryPolicySource(() => strictEnvironment.get('memory.hostPolicy'));
  assert.equal(hostMemoryShort(7 * GiB, 12 * GiB), true);
  await assert.rejects(
    strictEnvironment.set([{ key: 'memory.hostPolicy', value: 'soft' }]),
    /FORGE_HOST_MEMORY_POLICY/,
  );
  // Without a source the plain environment variable is read, as it always was.
  setHostMemoryPolicySource();
  assert.equal(hostMemoryShort(7 * GiB, 12 * GiB), false);
});

test('queue.chainUnload changes the unload decision on the next call', async (t) => {
  const settings = makeSettings(t);
  const option = () => settings.get('queue.chainUnload');
  const input = { parentType: 'images', childEngine: '3d-trellis', upcomingEngines: [] };
  assert.deepEqual(planChainUnload({ ...input, enabled: resolveChainUnloadOption(option) }), {
    engine: 'images',
  });
  await settings.set([{ key: 'queue.chainUnload', value: false }]);
  assert.deepEqual(planChainUnload({ ...input, enabled: resolveChainUnloadOption(option) }), {
    skip: 'disabled',
  });
  assert.equal(resolveChainUnloadOption(true), true);
  assert.equal(resolveChainUnloadOption(false), false);
  assert.equal(resolveChainUnloadOption(null), undefined);
  assert.equal(resolveChainUnloadOption(undefined), undefined);
});

test('the worker, supervisor and job processes read these toggles through the registry', () => {
  const source = (file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
  const worker = source('runtime/worker.js');
  assert.doesNotMatch(worker, /FORGE_AUTO_START|FORGE_AUTO_PREPARE|FORGE_HOST_MEMORY_POLICY/);
  assert.match(worker, /getSetting\('queue\.chainUnload'\)/);
  assert.match(worker, /setHostMemoryPolicySource\(\(\) => getSetting\('memory\.hostPolicy'\)\)/);
  assert.match(worker, /getSetting\('engines\.autoPrepare\.music'\)/);
  assert.match(worker, /autoStartsService\(type, process\.env, getSetting\)/);
  assert.match(worker, /readSetting: getSetting/);
  assert.match(source('server.js'), /getSetting\('tray\.enabled'\)/);
  assert.match(source('runtime/vegetation-job.js'), /getSetting\('vegetation\.timeoutMs'\)/);
  assert.match(source('runtime/engines.js'), /\.\.\.engineEnvironment\(\)/);
});
