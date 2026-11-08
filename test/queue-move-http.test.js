import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { JobQueue } from '../runtime/jobs.js';
import { runtimeService } from '../runtime/supervisor.js';

// The queue_rank scheduler with a substitute sound engine, the real runtime worker behind the
// HTTP route (isolated state, every engine URL on a closed port) and the MCP tool schema.
// No model is loaded and the GPU is not used.

const CLOSED = 'http://127.0.0.1:1';
const ENGINE_URLS = [
  'FORGE_MUSIC_URL',
  'FORGE_SFX_URL',
  'FORGE_TTS_URL',
  'FORGE_HUNYUAN_URL',
  'FORGE_TRELLIS_URL',
  'FORGE_SAM31_URL',
  'FORGE_IMAGE_URL',
  'FORGE_VIDEO_URL',
  'FORGE_WORLD_URL',
  'FORGE_HYMOTION_URL',
  'FORGE_MOTIONBRICKS_URL',
];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) {
      return value;
    }
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Cleanup steps run last-in first-out in one hook, so a queue is stopped before its folder goes.
function cleanupStack(t) {
  const steps = [];
  t.after(async () => {
    for (const step of steps.reverse()) {
      await step();
    }
  });
  return (step) => steps.push(step);
}

async function projectFolder(prefix, defer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Game', 'sfx'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Game', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  defer(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }));
  return { dir, projects, projectId };
}

// A sound engine that records which prompt it was asked to render, in order.
async function fakeSoundEngine(defer) {
  const prompts = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') {
      return res.end(JSON.stringify({ phase: 'ready', loaded: true }));
    }
    if (req.url === '/api/session') {
      return res.end(JSON.stringify({ session: 'key' }));
    }
    if (req.url === '/api/generate' && req.method === 'POST') {
      prompts.push(JSON.parse(raw).prompt);
      return res.end(JSON.stringify({ job_id: `engine-${prompts.length}` }));
    }
    if (/^\/api\/jobs\/engine-\d+$/.test(req.url)) {
      return res.end(
        JSON.stringify({ status: 'completed', result: { url: `/audio/${prompts.length}.wav` } }),
      );
    }
    if (req.url.startsWith('/audio/')) {
      res.setHeader('Content-Type', 'audio/wav');
      return res.end('RIFF-test');
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  defer(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, prompts };
}

test(
  'the scheduler claims the moved render next and never preempts the running one',
  { timeout: 30000 },
  async (t) => {
    const defer = cleanupStack(t);
    const engine = await fakeSoundEngine(defer);
    const previous = process.env.FORGE_SFX_URL;
    process.env.FORGE_SFX_URL = engine.url;
    defer(() => {
      if (previous === undefined) {
        delete process.env.FORGE_SFX_URL;
      } else {
        process.env.FORGE_SFX_URL = previous;
      }
    });
    const { dir, projects, projectId } = await projectFolder('forge-move-sched-', defer);
    const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, autoStart: false });
    defer(() => queue.stop());
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((prompt) =>
      queue.enqueue({ type: 'sfx', projectId, request: { prompt } }),
    );
    queue.move(c.id, { to: 'next' });

    // The first claim takes the moved render. A finished render starts the next claim by itself.
    await queue.tick();
    assert.notEqual(queue.get(c.id).status, 'queued', 'the moved render was claimed');
    assert.equal(queue.get(a.id).status, 'queued');
    // It is under way now: it cannot be moved, and moving others does not disturb it.
    assert.throws(() => queue.move(c.id, { to: 'end' }), { code: 'not_movable' });
    queue.move(d.id, { to: 'next' });
    assert.notEqual(queue.get(c.id).status, 'queued');
    await waitFor(
      () => [a, b, c, d].every((job) => queue.get(job.id).status === 'completed'),
      'all renders to finish',
    );
    assert.deepEqual(engine.prompts, ['c', 'd', 'a', 'b']);
  },
);

async function startStudio(t) {
  const defer = cleanupStack(t);
  const { dir, projects, projectId } = await projectFolder('forge-move-http-', defer);
  const state = path.join(dir, 'state');
  // A head render that needs attention blocks the scheduler, so nothing here can ever start.
  const seed = new JobQueue({ directory: state, projects, autoStart: false });
  const ids = [];
  for (const prompt of ['one', 'two', 'three', 'four']) {
    ids.push(seed.enqueue({ type: 'sfx', projectId, request: { prompt } }).id);
  }
  const blocker = seed.enqueue({ type: 'sfx', projectId, request: { prompt: 'blocker' } });
  seed.db
    .prepare("UPDATE jobs SET status='needs_attention',queue_rank=-1 WHERE id=?")
    .run(blocker.id);
  seed.stop();

  const previousEnv = {};
  const env = {
    FORGE_RUNTIME_DIR: state,
    FORGE_PROJECTS_DIR: projects,
    ...Object.fromEntries(ENGINE_URLS.map((name) => [name, CLOSED])),
  };
  for (const [name, value] of Object.entries(env)) {
    previousEnv[name] = process.env[name];
    process.env[name] = value;
  }
  const app = express();
  const plugin = runtimeService();
  const httpServer = createServer(app);
  plugin.configureServer({ middlewares: app, httpServer });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const port = httpServer.address().port;
  defer(async () => {
    httpServer.closeAllConnections();
    httpServer.close();
    // Closing the server stops the runtime worker; give its process time to release the files.
    await pause(1000);
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  const send = (method, route, { body, headers } = {}) =>
    new Promise((resolve, reject) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path: route,
          headers: {
            Host: `127.0.0.1:${port}`,
            ...(text ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }),
          );
        },
      );
      req.on('error', reject);
      req.end(text);
    });
  const post = (route, body, headers = {}) =>
    send('POST', route, {
      body,
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'X-Forge-Request': 'runtime',
        ...headers,
      },
    });
  await waitFor(async () => (await send('GET', '/api/runtime/health')).status === 200, 'runtime');
  return { ids, blocker, send, post, port };
}

test(
  'the move route validates its input, checks the origin and returns the new order',
  {
    timeout: 60000,
  },
  async (t) => {
    const { ids, blocker, send, post, port } = await startStudio(t);
    const [one, two, three, four] = ids;
    const route = (id) => `/api/runtime/jobs/${id}/move`;
    const waiting = async () =>
      (await send('GET', '/api/runtime/jobs')).body.jobs
        .filter((job) => job.status === 'queued')
        .map((job) => job.request.prompt);

    // The list carries the rank, in scheduler order.
    const listed = (await send('GET', '/api/runtime/jobs')).body.jobs;
    assert.deepEqual(
      listed.map((job) => job.request.prompt),
      ['blocker', 'one', 'two', 'three', 'four'],
    );
    assert.ok(listed.every((job) => job.queueRank !== undefined));

    // Same protections as the sibling routes.
    assert.equal((await send('POST', route(four), { body: { to: 'top' } })).status, 403);
    assert.equal(
      (await post(route(four), { to: 'top' }, { Origin: 'http://evil.example' })).status,
      403,
    );
    assert.equal(
      (await post(route(four), { to: 'top' }, { 'X-Forge-Request': 'other' })).status,
      403,
    );
    assert.equal((await post(route(four), { to: 'top' }, { Host: 'evil.example' })).status, 403);
    assert.equal((await send('GET', route(four))).status, 404);
    assert.deepEqual(
      await waiting(),
      ['one', 'two', 'three', 'four'],
      'refused requests changed nothing',
    );

    // Strict validation.
    for (const body of [
      {},
      { to: 'sideways' },
      { to: 'top', direction: 'up' },
      { before: 'nope' },
      { to: 'top', extra: 1 },
      { to: 'top', expectedRank: 'x' },
    ]) {
      const response = await post(route(four), body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.code, 'invalid_request');
    }
    assert.equal((await post(route(four), [])).status, 400);
    assert.equal((await post(route(randomUUID()), { to: 'top' })).status, 404);

    // A move returns the new order of waiting renders and the ranks.
    const moved = await post(route(four), { to: 'next' });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.order, [four, one, two, three]);
    assert.equal(moved.body.moved, true);
    assert.equal(moved.body.position, 1);
    assert.equal(moved.body.count, 4);
    assert.match(moved.body.message, /Moved the render to position 1 of 4/);
    assert.equal(moved.body.job.id, four);
    assert.deepEqual(Object.keys(moved.body.ranks).sort(), [...ids].sort());
    assert.deepEqual(await waiting(), ['four', 'one', 'two', 'three']);

    // before / after / direction, and the blocked head cannot move or be a place.
    assert.deepEqual((await post(route(four), { after: two })).body.order, [one, two, four, three]);
    assert.deepEqual((await post(route(three), { direction: 'up' })).body.order, [
      one,
      two,
      three,
      four,
    ]);
    assert.equal((await post(route(blocker.id), { to: 'end' })).status, 409);
    assert.equal((await post(route(blocker.id), { to: 'end' })).body.code, 'not_movable');
    assert.equal((await post(route(one), { before: blocker.id })).body.code, 'anchor_not_movable');

    // A stale move answers 409 with the fresh order and changes nothing.
    const stale = await post(route(one), { to: 'end', expectedRank: 12345 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale');
    assert.deepEqual(stale.body.order, [one, two, three, four]);
    assert.equal(typeof stale.body.ranks[one], 'number');
    assert.deepEqual(await waiting(), ['one', 'two', 'three', 'four']);
    const fresh = stale.body.ranks[one];
    assert.equal((await post(route(one), { to: 'end', expectedRank: fresh })).status, 200);
    assert.deepEqual(await waiting(), ['two', 'three', 'four', 'one']);
    assert.ok(port > 0);
  },
);

test('forge_move_job validates its arguments and posts to the move route', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({
      path: req.url,
      kind: req.headers['x-forge-request'],
      origin: req.headers.origin,
      body: body ? JSON.parse(body) : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ moved: true, order: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client(
    { name: 'queue-move-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: { ...process.env, FORGE_STUDIO_URL: origin },
      stderr: 'pipe',
    }),
  );
  const tool = (await client.listTools()).tools.find((item) => item.name === 'forge_move_job');
  assert.ok(tool, 'forge_move_job is registered');
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.required, ['id']);
  assert.deepEqual(tool.inputSchema.properties.to.enum, ['next', 'top', 'end']);
  assert.deepEqual(tool.inputSchema.properties.direction.enum, ['up', 'down']);
  assert.match(tool.description, /next render to start/);

  const id = randomUUID();
  const other = randomUUID();
  const call = (args) => client.callTool({ name: 'forge_move_job', arguments: args });
  // Anything that is not exactly one place is refused before any request is made.
  for (const args of [
    { id },
    { id, to: 'top', direction: 'up' },
    { id: 'not-a-uuid', to: 'top' },
    { id, to: 'middle' },
    { id, before: 'x' },
  ]) {
    assert.equal((await call(args)).isError, true, JSON.stringify(args));
  }
  assert.equal(requests.length, 0);

  assert.notEqual((await call({ id, to: 'next' })).isError, true);
  assert.notEqual((await call({ id, after: other, expectedRank: 4.5 })).isError, true);
  assert.notEqual((await call({ id, direction: 'down', expectedRank: null })).isError, true);
  assert.deepEqual(
    requests.map((item) => [item.path, item.kind, item.origin, item.body]),
    [
      [`/api/runtime/jobs/${id}/move`, 'runtime', origin, { to: 'next' }],
      [`/api/runtime/jobs/${id}/move`, 'runtime', origin, { after: other, expectedRank: 4.5 }],
      [
        `/api/runtime/jobs/${id}/move`,
        'runtime',
        origin,
        { direction: 'down', expectedRank: null },
      ],
    ],
  );
});
