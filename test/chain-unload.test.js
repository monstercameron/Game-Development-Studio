import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { createAutoMemoryManager } from '../runtime/auto-memory.js';
import {
  CHAIN_UNLOAD_ENV,
  isChainUnloadEnabled,
  planChainUnload,
} from '../runtime/chain-unload.js';

// A chained render frees the model of the render it took its input from. Everything here uses
// substitute engines on loopback ports and a fake offload: no model is loaded, nothing is stopped.

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake-image')]);
const ENV = ['FORGE_HUNYUAN_URL', 'FORGE_TRELLIS_URL', 'FORGE_SAM31_URL', 'FORGE_IMAGE_URL'];

async function waitFor(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function serve(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
    const reply = handler(req);
    res.setHeader('Content-Type', Buffer.isBuffer(reply) ? 'image/png' : 'application/json');
    if (Buffer.isBuffer(reply)) {
      return res.end(reply);
    }
    res.statusCode = reply?.status || 200;
    res.end(JSON.stringify(reply?.json ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// The engine a chained 3D render talks to. `onGenerate` lets a test observe the moment it starts.
function trellisEngine(t, { loaded = true, onGenerate = () => {} } = {}) {
  return serve(t, (req) => {
    if (req.url === '/api/status') {
      return {
        json: {
          engine: 'forge-trellis2-512-experimental-v1',
          phase: 'ready',
          loaded,
          model_downloaded: true,
        },
      };
    }
    if (req.url === '/api/generate') {
      onGenerate();
      return { status: 202, json: { id: 'c'.repeat(32) } };
    }
    if (req.url === `/api/jobs/${'c'.repeat(32)}`) {
      return { json: { status: 'completed' } };
    }
    if (req.url === `/api/jobs/${'c'.repeat(32)}/mesh`) {
      return 'glTF-test';
    }
    return { status: 404 };
  });
}

function qwenEngine(t) {
  return serve(t, (req) => {
    if (req.url === '/api/status') {
      return { json: { status: 'ready', model_downloaded: true, busy: false } };
    }
    if (req.url === '/api/generate') {
      return { json: { id: 'img-1' } };
    }
    if (req.url === '/api/jobs/img-1') {
      return { json: { status: 'completed', images: ['/outputs/made.png'] } };
    }
    if (req.url === '/outputs/made.png') {
      return PNG;
    }
    return { status: 404 };
  });
}

// Fake service list in the shape worker.js builds; `events` records the order of what happened.
function fakeAutoMemory(events, overrides = {}) {
  const state = {
    offloads: [],
    services: [
      {
        id: 'images',
        name: 'Qwen Image',
        status: 'reachable',
        managed: true,
        canUnload: true,
        busy: false,
        modelLoaded: true,
        ...overrides.images,
      },
      {
        id: 'segmentation',
        name: 'SAM 3.1',
        status: 'reachable',
        managed: true,
        canUnload: true,
        busy: false,
        modelLoaded: true,
        ...overrides.segmentation,
      },
    ],
  };
  const autoMemory = createAutoMemoryManager({
    services: async () => state.services.map((service) => ({ ...service })),
    offload: async (id) => {
      events.push(`offload:${id}`);
      state.offloads.push(id);
      if (overrides.offload) {
        return overrides.offload(id);
      }
      state.services.find((service) => service.id === id).modelLoaded = false;
      return { stopped: true };
    },
  });
  return { state, autoMemory };
}

async function setup(t, engines, options = {}) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) {
    process.env[name] = engines[name] || 'http://127.0.0.1:1';
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-chain-unload-')),
    projects = path.join(dir, 'projects'),
    folder = path.join(projects, 'Game'),
    projectId = randomUUID();
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const opened = [];
  const open = (extra = {}) => {
    const next = new JobQueue({
      directory: path.join(dir, 'state'),
      projects,
      intervalMs: 30,
      ...options,
      ...extra,
    });
    opened.push(next);
    return next;
  };
  const queue = open();
  t.after(async () => {
    for (const item of opened) {
      try {
        item.stop();
      } catch {
        // A test may already have stopped this queue to simulate a restart.
      }
    }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { queue, open, folder, projectId };
}

const imageStep = (projectId, extra = {}) => ({
  type: 'images',
  projectId,
  request: { prompt: 'a wooden barrel', transparent: true, seed: 4, ...extra },
});
const trellisStep = (projectId) => ({
  type: 'trellis',
  projectId,
  request: { references: [], referenceFrom: { step: 0 } },
});

test('planChainUnload decides from the parent type, the child engine and the open jobs', () => {
  assert.deepEqual(
    planChainUnload({
      parentType: 'images',
      childEngine: '3d-trellis',
      upcomingEngines: ['tts'],
      enabled: true,
    }),
    { engine: 'images' },
  );
  assert.deepEqual(
    planChainUnload({
      parentType: 'segmentation',
      childEngine: '3d-hunyuan',
      upcomingEngines: [],
      enabled: true,
    }),
    { engine: 'segmentation' },
  );
  const skip = (extra) =>
    planChainUnload({
      parentType: 'images',
      childEngine: '3d-trellis',
      upcomingEngines: [],
      enabled: true,
      ...extra,
    });
  assert.deepEqual(skip({ upcomingEngines: ['images'] }), { skip: 'needed_next' });
  assert.deepEqual(skip({ childEngine: 'images' }), { skip: 'same_engine' });
  assert.deepEqual(skip({ parentType: 'voices' }), { skip: 'not_a_chain_parent' });
  assert.deepEqual(skip({ enabled: false }), { skip: 'disabled' });
});

test('FORGE_CHAIN_UNLOAD turns the behavior off and is on by default', () => {
  assert.equal(isChainUnloadEnabled({}), true);
  assert.equal(isChainUnloadEnabled({ [CHAIN_UNLOAD_ENV]: '1' }), true);
  for (const value of ['0', 'false', 'OFF', ' no ']) {
    assert.equal(isChainUnloadEnabled({ [CHAIN_UNLOAD_ENV]: value }), false, value);
  }
});

test('text to 3D: Qwen Image is offloaded after its picture is staged and before TRELLIS.2 starts', async (t) => {
  const events = [];
  const qwen = await qwenEngine(t);
  const trellis = await trellisEngine(t, { onGenerate: () => events.push('trellis:generate') });
  // A slow offload, as a real engine stop is, so the stage text can be observed.
  const { autoMemory, state } = fakeAutoMemory(events, {
    offload: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { stopped: true };
    },
  });
  const stages = [];
  const { queue, projectId } = await setup(
    t,
    { FORGE_IMAGE_URL: qwen.url, FORGE_TRELLIS_URL: trellis.url },
    { autoMemory, refreshHardware: async () => events.push('hardware') },
  );
  const [image, model] = queue.enqueueChain([imageStep(projectId), trellisStep(projectId)]);
  const poll = setInterval(() => stages.push(queue.get(model.id).stage), 5);
  await waitFor(() => queue.get(model.id).status === 'completed', 'the model to finish');
  clearInterval(poll);

  assert.deepEqual(state.offloads, ['images']);
  assert.deepEqual(events, ['offload:images', 'hardware', 'trellis:generate']);
  assert.equal(queue.get(image.id).status, 'completed');
  assert.ok(
    stages.includes('Freeing memory from the finished Qwen Image render...'),
    `visible stage text was ${[...new Set(stages)].join(' | ')}`,
  );
  // The reference was staged before the offload, so the child still got the finished picture.
  const sent = trellis.requests.find((r) => r.url === '/api/generate').body;
  assert.equal(sent.image, `data:image/png;base64,${PNG.toString('base64')}`);
  // The offload is reserved while it runs and released afterwards.
  assert.equal(queue.suspendedEngines.size, 0);
});

test('remove background: SAM 3.1 is offloaded before the 3D render when it is the only user', async (t) => {
  const events = [];
  const { autoMemory } = fakeAutoMemory(events);
  const trellis = await trellisEngine(t);
  const { queue, projectId, folder } = await setup(
    t,
    { FORGE_TRELLIS_URL: trellis.url },
    { autoMemory, autoStart: false },
  );
  const cutout = {
    type: 'segmentation',
    projectId,
    request: { prompt: 'barrel', references: [`${randomUUID()}.png`] },
  };
  const [parent, child] = queue.enqueueChain([cutout, trellisStep(projectId)]);
  await fs.mkdir(path.join(folder, 'masks'), { recursive: true });
  await fs.writeFile(path.join(folder, 'masks', 'cutout.png'), PNG);
  queue.db
    .prepare("UPDATE jobs SET status='completed',output='masks/cutout.png' WHERE id=?")
    .run(parent.id);
  await queue.tick();
  assert.deepEqual(events, ['offload:segmentation']);
  assert.equal(queue.get(child.id).request.referenceFrom.output, 'masks/cutout.png');
  assert.equal(queue.suspendedEngines.size, 0);
});

// Drives one tick by hand on a finished parent so the cases below stay deterministic.
async function finishedParent(t, { services, queueOptions = {}, extraJobs = () => {} } = {}) {
  const events = [];
  const fake = fakeAutoMemory(events, services);
  // Not loaded, so the chained render stays in preparation and no job worker is started.
  const trellis = await trellisEngine(t, { loaded: false });
  const env = { FORGE_TRELLIS_URL: trellis.url };
  const context = await setup(t, env, {
    autoMemory: fake.autoMemory,
    autoStart: false,
    ...queueOptions,
  });
  const { queue, projectId, folder } = context;
  const [parent, child] = queue.enqueueChain([imageStep(projectId), trellisStep(projectId)]);
  extraJobs(queue, projectId);
  await fs.writeFile(path.join(folder, 'images', 'made.png'), PNG);
  queue.db
    .prepare("UPDATE jobs SET status='completed',output='images/made.png' WHERE id=?")
    .run(parent.id);
  return { ...context, events, fake, parent, child, trellis };
}

test('Qwen Image stays loaded while another queued render still needs it', async (t) => {
  const context = await finishedParent(t, {
    // Created after the chain, so it waits behind the 3D render.
    extraJobs: (queue, projectId) => queue.enqueue(imageStep(projectId, { prompt: 'a crate' })),
  });
  await context.queue.tick();
  assert.deepEqual(context.events, []);
  assert.equal(context.fake.state.services[0].modelLoaded, true);
  assert.equal(context.queue.get(context.child.id).request.referenceFrom.output, 'images/made.png');
});

test('an engine Forge does not own, or that is busy or already unloaded, is left alone', async (t) => {
  const cases = {
    unowned: { images: { managed: false } },
    cannotUnload: { images: { canUnload: false } },
    busy: { images: { busy: true } },
    notLoaded: { images: { modelLoaded: false } },
    unreachable: { images: { status: 'unavailable' } },
  };
  for (const [label, services] of Object.entries(cases)) {
    await t.test(label, async (inner) => {
      const context = await finishedParent(inner, { services });
      await context.queue.tick();
      assert.deepEqual(context.events, []);
      // The child carries on to its own preparation; the chain was not failed by the refusal.
      assert.notEqual(context.queue.get(context.child.id).status, 'failed');
      assert.equal(
        context.queue.get(context.child.id).request.referenceFrom.output,
        'images/made.png',
      );
    });
  }
});

test('a failed offload does not fail the chained render and is reported in its stage', async (t) => {
  const events = [];
  const failing = fakeAutoMemory(events, {
    offload: async () => {
      throw Error('The engine is busy or its idle state cannot be verified.');
    },
  });
  const trellis = await trellisEngine(t, { loaded: false });
  const { queue, projectId, folder } = await setup(
    t,
    { FORGE_TRELLIS_URL: trellis.url },
    { autoMemory: failing.autoMemory, autoStart: false },
  );
  const [parent, child] = queue.enqueueChain([imageStep(projectId), trellisStep(projectId)]);
  await fs.writeFile(path.join(folder, 'images', 'made.png'), PNG);
  queue.db
    .prepare("UPDATE jobs SET status='completed',output='images/made.png' WHERE id=?")
    .run(parent.id);
  const logged = [];
  queue.onQueueLog = (record) => logged.push(record);
  await queue.tick();

  assert.deepEqual(events, ['offload:images']);
  const after = queue.get(child.id);
  assert.notEqual(after.status, 'failed');
  assert.notEqual(after.status, 'cancelled');
  assert.equal(after.request.referenceFrom.output, 'images/made.png');
  assert.equal(queue.suspendedEngines.size, 0);
  assert.ok(
    logged.some((record) => record.event === 'chain_unload' && record.outcome === 'failed'),
  );
  // The warning shows until the job's own preparation reports its stage.
  assert.equal(failing.state.services[0].modelLoaded, true);
});

test('a refresh that throws after a successful offload does not stop the render', async (t) => {
  const context = await finishedParent(t, {
    queueOptions: {
      refreshHardware: async () => {
        throw Error('GPU monitor unavailable.');
      },
    },
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => {
    console.error = original;
  });
  await context.queue.tick();
  console.error = original;
  assert.deepEqual(context.events, ['offload:images']);
  assert.notEqual(context.queue.get(context.child.id).status, 'failed');
  assert.ok(errors.some((line) => /Could not re-read GPU memory/.test(line)));
});

test('the switch disables the unload, by option and by environment', async (t) => {
  const byOption = await finishedParent(t, { queueOptions: { chainUnload: false } });
  await byOption.queue.tick();
  assert.deepEqual(byOption.events, []);

  const previous = process.env[CHAIN_UNLOAD_ENV];
  process.env[CHAIN_UNLOAD_ENV] = '0';
  t.after(() => {
    if (previous === undefined) {
      delete process.env[CHAIN_UNLOAD_ENV];
    } else {
      process.env[CHAIN_UNLOAD_ENV] = previous;
    }
  });
  const byEnv = await finishedParent(t);
  await byEnv.queue.tick();
  assert.deepEqual(byEnv.events, []);
  assert.equal(byEnv.queue.get(byEnv.child.id).request.referenceFrom.output, 'images/made.png');

  // The option wins over the environment, so a test or embedder can force it on.
  const forced = await finishedParent(t, { queueOptions: { chainUnload: true } });
  await forced.queue.tick();
  assert.deepEqual(forced.events, ['offload:images']);
});

test('only chained renders unload anything: a plain 3D render never touches Qwen Image', async (t) => {
  const events = [];
  const { autoMemory } = fakeAutoMemory(events);
  const trellis = await trellisEngine(t);
  const { queue, projectId, folder } = await setup(
    t,
    { FORGE_TRELLIS_URL: trellis.url },
    { autoMemory, autoStart: false },
  );
  await fs.writeFile(path.join(folder, 'images', 'a.png'), PNG);
  const { stageProjectAsset } = await import('../runtime/references.js');
  const staged = await stageProjectAsset(folder, 'images/a.png');
  queue.enqueue({ type: 'trellis', projectId, request: { references: [staged.id] } });
  await queue.tick();
  await queue.tick();
  assert.deepEqual(events, []);
});

test('each chained render gets one attempt, so the engine is never offloaded twice', async (t) => {
  const context = await finishedParent(t);
  await context.queue.tick();
  await context.queue.tick();
  await context.queue.tick();
  assert.deepEqual(context.events, ['offload:images']);
  assert.equal(context.fake.state.offloads.length, 1);
});

test('a restarted runtime tries once more, and a model that is already gone is not offloaded again', async (t) => {
  const context = await finishedParent(t);
  await context.queue.tick();
  assert.deepEqual(context.events, ['offload:images']);
  context.queue.stop();
  // The new process has an empty attempt list; the service report now says the model is unloaded.
  const reopened = context.open({ autoMemory: context.fake.autoMemory });
  await reopened.tick();
  assert.deepEqual(context.events, ['offload:images']);
  assert.notEqual(reopened.get(context.child.id).status, 'failed');
});

test('cancelling the chained render during the offload releases the engine and ends the tick', async (t) => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const offloadStarted = new Promise((resolve) => {
    started = resolve;
  });
  const slow = fakeAutoMemory(events, {
    offload: async () => {
      started();
      await gate;
      return { stopped: true };
    },
  });
  const trellis = await trellisEngine(t);
  const { queue, projectId, folder } = await setup(
    t,
    { FORGE_TRELLIS_URL: trellis.url },
    { autoMemory: slow.autoMemory, autoStart: false },
  );
  const [parent, child] = queue.enqueueChain([imageStep(projectId), trellisStep(projectId)]);
  await fs.writeFile(path.join(folder, 'images', 'made.png'), PNG);
  queue.db
    .prepare("UPDATE jobs SET status='completed',output='images/made.png' WHERE id=?")
    .run(parent.id);
  const tick = queue.tick();
  await offloadStarted;
  assert.equal(queue.suspendedEngines.has('images'), true);
  assert.equal(queue.cancel(child.id).status, 'cancelled');
  release();
  await tick;
  assert.equal(queue.get(child.id).status, 'cancelled');
  assert.equal(queue.suspendedEngines.size, 0);
  // A later tick must not resurrect or re-offload anything.
  await queue.tick();
  assert.deepEqual(events, ['offload:images']);
});

test('a failed parent still fails the child with its own message and offloads nothing', async (t) => {
  const events = [];
  const { autoMemory } = fakeAutoMemory(events);
  const trellis = await trellisEngine(t);
  const { queue, projectId } = await setup(
    t,
    { FORGE_TRELLIS_URL: trellis.url },
    { autoMemory, autoStart: false },
  );
  const [parent, child] = queue.enqueueChain([imageStep(projectId), trellisStep(projectId)]);
  queue.db
    .prepare("UPDATE jobs SET status='failed',error='CUDA out of memory' WHERE id=?")
    .run(parent.id);
  await queue.tick();
  assert.equal(queue.get(child.id).status, 'failed');
  assert.equal(queue.get(child.id).stage, 'Dependency failed.');
  assert.deepEqual(events, []);
});

test('retrying the chained render allows another attempt to free the model', async (t) => {
  const context = await finishedParent(t);
  await context.queue.tick();
  assert.deepEqual(context.events, ['offload:images']);
  context.queue.db
    .prepare("UPDATE jobs SET status='failed',error='boom',remote_id=NULL WHERE id=?")
    .run(context.child.id);
  context.fake.state.services[0].modelLoaded = true;
  context.queue.retry(context.child.id);
  await context.queue.tick();
  assert.deepEqual(context.events, ['offload:images', 'offload:images']);
});

test('the live queue.chainUnload setting switches the unload without recreating the queue', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-chain-setting-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const { createSettings } = await import('../runtime/core-settings.js');
  const settings = createSettings({ directory, env: {}, cacheMs: 0 });
  const chainUnload = () => settings.get('queue.chainUnload');

  const enabled = await finishedParent(t, { queueOptions: { chainUnload } });
  await enabled.queue.tick();
  assert.deepEqual(enabled.events, ['offload:images']);

  await settings.set([{ key: 'queue.chainUnload', value: false }]);
  const disabled = await finishedParent(t, { queueOptions: { chainUnload } });
  await disabled.queue.tick();
  assert.deepEqual(disabled.events, [], 'the same accessor now reports off');
  assert.equal(
    disabled.queue.get(disabled.child.id).request.referenceFrom.output,
    'images/made.png',
  );

  // An environment switch is still stronger than anything saved.
  const locked = createSettings({ directory, env: { [CHAIN_UNLOAD_ENV]: '1' }, cacheMs: 0 });
  assert.equal(locked.get('queue.chainUnload'), true);
  const forced = await finishedParent(t, {
    queueOptions: { chainUnload: () => locked.get('queue.chainUnload') },
  });
  await forced.queue.tick();
  assert.deepEqual(forced.events, ['offload:images']);
});
