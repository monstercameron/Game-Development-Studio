import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EngineManager, engineDefinitions } from '../runtime/engines.js';
import { JobQueue } from '../runtime/jobs.js';
import { autoStartsService, createServicePreparation } from '../runtime/service-preparation.js';

const picture = '11111111-1111-4111-8111-111111111111.png';

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error('Timed out.');
}

test('the queue may start the video engine itself unless the service is provided from outside', () => {
  assert.equal(autoStartsService('video', {}), true);
  assert.equal(autoStartsService('video', { FORGE_VIDEO_URL: 'http://127.0.0.1:9' }), false);
  assert.equal(
    autoStartsService('video', {
      FORGE_VIDEO_URL: 'http://127.0.0.1:9',
      FORGE_AUTO_START_VIDEO: '1',
    }),
    true,
  );
  assert.equal(autoStartsService('images', { FORGE_IMAGE_URL: 'x' }), false);
  assert.equal(
    autoStartsService('images', { FORGE_IMAGE_URL: 'x', FORGE_AUTO_START_IMAGE: '1' }),
    true,
  );
  assert.equal(autoStartsService('world', { FORGE_WORLD_URL: 'x' }), false);
  assert.equal(autoStartsService('sfx', { FORGE_SFX_URL: 'x' }), false);
  assert.equal(autoStartsService('sfx', {}), true);
});

test('a queued video job starts the unreachable video engine and then waits for it', async (t) => {
  const closedPort = await freePort();
  const previous = process.env.FORGE_VIDEO_URL;
  process.env.FORGE_VIDEO_URL = `http://127.0.0.1:${closedPort}`;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FORGE_VIDEO_URL;
    } else {
      process.env.FORGE_VIDEO_URL = previous;
    }
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-video-start-'));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Example'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Example', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  const started = [];
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    intervalMs: 50,
    prepareService: createServicePreparation({
      startEngine: async (id) => {
        started.push(id);
        return { id, status: 'starting' };
      },
      // The address above only points the queue at a closed port for this test; the real
      // worker passes its own environment.
      autoStart: (type) => autoStartsService(type, {}),
    }),
  });
  t.after(() => queue.stop());
  const job = queue.enqueue({
    type: 'video',
    projectId,
    request: { prompt: 'a lake', references: [picture], frames: 56, steps: 8 },
  });
  await waitFor(() => started.length > 0);
  assert.equal(started[0], 'video');
  await waitFor(() => /Starting the H3 Studio worker/.test(queue.get(job.id).stage));
  assert.equal(queue.get(job.id).status, 'waiting_engine');
});

test('a video job waits and starts nothing when the service address is configured', async (t) => {
  const closedPort = await freePort();
  const previous = process.env.FORGE_VIDEO_URL;
  process.env.FORGE_VIDEO_URL = `http://127.0.0.1:${closedPort}`;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FORGE_VIDEO_URL;
    } else {
      process.env.FORGE_VIDEO_URL = previous;
    }
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-video-nostart-'));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Example'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Example', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  let started = 0;
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    intervalMs: 50,
    prepareService: createServicePreparation({
      startEngine: async () => {
        started += 1;
        return { status: 'starting' };
      },
      autoStart: (type) => autoStartsService(type, { FORGE_VIDEO_URL: 'http://127.0.0.1:1' }),
    }),
  });
  t.after(() => queue.stop());
  const job = queue.enqueue({
    type: 'video',
    projectId,
    request: { prompt: 'a lake', references: [picture], frames: 56, steps: 8 },
  });
  await waitFor(() => /configured H3 Studio worker/.test(queue.get(job.id).stage));
  assert.equal(started, 0);
});

test('one engine can be started on its own with the same rules as start-all', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-start-one-'));
  const port = await freePort();
  const onDemandPort = await freePort();
  const base = { cwd: dir, command: process.execPath, endpoint: '/api/status', kind: 'h3' };
  const manager = new EngineManager({
    logDir: dir,
    logger: () => {},
    definitions: [
      {
        ...base,
        id: 'video',
        name: 'H3 test',
        port,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        noRestart: true,
      },
      {
        ...base,
        id: 'world',
        name: 'On-demand test',
        port: onDemandPort,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        onDemand: true,
        noRestart: true,
      },
    ],
  });
  t.after(() => {
    manager.closed = true;
    for (const entry of manager.children.values()) {
      entry.child.kill();
    }
  });
  await assert.rejects(manager.startOne('nope'), /Unknown engine/);
  const status = manager.status();
  assert.equal(status.video.startsOnDemand, false);
  assert.equal(status.world.startsOnDemand, true);
  // An on-demand engine is never started by a plain start; it needs its own memory check.
  assert.deepEqual(await manager.startOne('world'), {
    id: 'world',
    status: 'on_demand',
    message: 'Starts after a GPU memory check.',
  });
  assert.equal(manager.owns('world'), false);
  const first = await manager.startOne('video');
  assert.equal(first.status, 'starting');
  assert.equal(manager.owns('video'), true);
  const again = await manager.startOne('video');
  assert.equal(again.status, 'already_managed');
  assert.equal(again.pid, first.pid);
  // start-all reports the same per-engine answers.
  const all = await manager.startAll();
  assert.deepEqual(
    all.services.map((item) => [item.id, item.status]),
    [
      ['video', 'already_managed'],
      ['world', 'on_demand'],
    ],
  );
});

test('a port held by something else is reported, not taken over, by a single start', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-start-busy-'));
  const holder = createServer();
  holder.listen(0, '127.0.0.1');
  await once(holder, 'listening');
  t.after(() => holder.close());
  const manager = new EngineManager({
    logDir: dir,
    logger: () => {},
    definitions: [
      {
        id: 'video',
        name: 'H3 test',
        port: holder.address().port,
        endpoint: '/api/status',
        kind: 'h3',
        cwd: dir,
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      },
    ],
  });
  const result = await manager.startOne('video');
  assert.equal(result.status, 'port_in_use');
  assert.equal(manager.owns('video'), false);
});

test('the video engine is a guarded, stoppable engine in the real definitions', () => {
  const video = engineDefinitions.find((item) => item.id === 'video');
  assert.equal(video.quiesce, 'h3-guard-v1');
  assert.equal(video.onDemand, undefined);
  const manager = new EngineManager({
    // The video guard is adoptable after a studio restart, which starts the ownership lock helper
    // process; this test only reads status and must not start it.
    definitions: engineDefinitions
      .filter((item) => ['video', 'chat'].includes(item.id))
      .map((item) => ({ ...item, recoverable: false })),
    logDir: os.tmpdir(),
    logger: () => {},
  });
  assert.equal(manager.status().video.startsOnDemand, false);
  assert.equal(manager.status().chat.startsOnDemand, true);
  assert.equal(
    manager.canOffload('video'),
    false,
    'only an engine this runtime owns can be stopped',
  );
});
