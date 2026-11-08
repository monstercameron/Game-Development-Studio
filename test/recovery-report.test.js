import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';
import { createRecoveryManager } from '../runtime/recovery-report.js';
import { recoveryService } from '../runtime/recovery-service.js';
import { recordRecoveryEvent } from '../runtime/recovery-events.js';
import { markRecoveryNeeded } from '../runtime/crash-loop.js';

// Sentinel: the report reads job rows but must never copy the request payload into its output.
const SECRET_PROMPT = 'a private prompt that must never appear in a report';
const REMOTE = 'b'.repeat(32);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recovery-report-'));
  const runtime = path.join(root, 'runtime');
  const projects = path.join(root, 'projects');
  const projectId = randomUUID();
  const project = path.join(projects, 'Alpha');
  await fs.mkdir(path.join(project, '3d'), { recursive: true });
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({ directory: runtime, projects, leaseMs: 50, autoStart: false });
  t.after(async () => {
    if (!queue.stopped) {
      if (!queue.stopped) {
        queue.stop();
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const insert = (values) => {
    const id = values.id || randomUUID();
    queue.db
      .prepare(
        `INSERT INTO jobs(id,type,project_id,request,status,remote_id,stage,error,output,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,'2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')`,
      )
      .run(
        id,
        values.type,
        projectId,
        JSON.stringify({ prompt: SECRET_PROMPT }),
        values.status,
        values.remoteId ?? null,
        values.stage ?? null,
        values.error ?? null,
        values.output ?? null,
      );
    return id;
  };
  const startup = async (previous) =>
    fs.writeFile(
      path.join(runtime, 'recovery-startup.json'),
      JSON.stringify({
        sessionId: randomUUID(),
        startedAt: '2026-01-03T00:00:00.000Z',
        previous,
      }),
    );
  return { root, runtime, projects, project, projectId, queue, insert, startup };
}

const UNCLEAN = {
  state: 'unclean',
  startedAt: '2026-01-01T00:00:00.000Z',
  lastAliveAt: '2026-01-02T12:00:00.000Z',
};

test('the report lists what the crash left, with evidence and without prompts or local paths', async (t) => {
  const { runtime, projects, project, queue, insert, startup } = await fixture(t);
  await startup(UNCLEAN);
  const submitting = insert({
    type: 'images',
    status: 'interrupted',
    error: 'Submission may have reached the engine. See C:\\Users\\someone\\secret\\log.txt',
  });
  const prepare = insert({ type: '3d', status: 'needs_attention', stage: 'Engine missing.' });
  const accepted = insert({ type: 'sfx', status: 'interrupted', remoteId: REMOTE });
  const savedId = randomUUID();
  const glb = Buffer.alloc(64);
  // A minimal GLB header (magic, version 2, total length) so the file looks whole to the check.
  glb.write('glTF', 0, 'latin1');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(64, 8);
  await fs.writeFile(path.join(project, '3d', `forge-${savedId}.glb`), glb);
  insert({ id: savedId, type: '3d', status: 'interrupted', remoteId: REMOTE });
  insert({ type: 'images', status: 'completed', remoteId: REMOTE });
  // Backdated far past any staging-file age limit, so the startup sweep is expected to remove it.
  const stale = path.join(project, `.forge-assets.json.${randomUUID()}.tmp`);
  await fs.writeFile(stale, 'x');
  await fs.utimes(
    stale,
    new Date(Date.now() - 100 * 3600000),
    new Date(Date.now() - 100 * 3600000),
  );
  const conflict = path.join(project, `.forge-${randomUUID()}.png.conflict`);
  await fs.writeFile(conflict, 'x');
  recordRecoveryEvent(
    {
      code: 'database.started_fresh',
      severity: 'error',
      kind: 'database',
      id: 'settings',
      detail: 'x',
    },
    { directory: runtime },
  );
  if (!queue.stopped) {
    queue.stop();
  }

  const manager = createRecoveryManager({
    runtimeDirectory: runtime,
    projectsRoot: projects,
    callRuntime: async () => ({
      services: [
        { id: 'images', name: 'Qwen', status: 'unavailable', reason: 'timeout', managed: false },
        { id: 'tts', name: 'Voices', status: 'reachable', ownershipRecovery: 'recovered' },
        { id: 'music', name: 'YuE', status: 'reachable' },
      ],
    }),
  });
  manager.runStartupSweep();
  const report = await manager.report();

  assert.equal(report.unclean, true);
  assert.equal(report.needsAttention, true);
  assert.equal(report.previous.lastAliveAt, UNCLEAN.lastAliveAt);
  const byId = Object.fromEntries(report.jobs.items.map((job) => [job.id, job]));
  assert.equal(byId[submitting].kind, 'unknown_outcome');
  assert.equal(byId[submitting].safeToRetry, false);
  assert.equal(byId[prepare].safeToRetry, true);
  assert.equal(byId[accepted].safeToRetry, false);
  assert.equal(byId[accepted].hasRemoteId, true);
  assert.equal(byId[savedId].savedOutput, 'valid', 'a whole saved file is reported as evidence');
  assert.equal(byId[savedId].savedOutputPath, `3d/forge-${savedId}.glb`);
  assert.equal(report.jobs.items.length, 4, 'a completed job needs nothing');
  assert.deepEqual(
    report.orphans.items.map((item) => item.kind),
    ['output_conflict'],
  );
  assert.equal(report.orphans.deleted, 1, 'the stale staging file was removed');
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  const settings = report.databases.find((database) => database.name === 'settings');
  assert.equal(settings.state, 'started_fresh');
  assert.deepEqual(
    report.engines.map((engine) => [engine.id, engine.reason, engine.ownership]),
    [
      ['images', 'timeout', null],
      ['tts', null, 'recovered'],
    ],
  );

  const text = JSON.stringify(report);
  assert.ok(!text.includes(SECRET_PROMPT), 'prompts are never read');
  assert.ok(!text.includes('someone'), 'local paths are redacted');
  assert.ok(!/[A-Za-z]:\\\\/.test(text));
});

test('a clean session with nothing to do needs no attention', async (t) => {
  const { runtime, projects, startup, queue } = await fixture(t);
  await startup({ state: 'clean', startedAt: '2026-01-01T00:00:00.000Z' });
  if (!queue.stopped) {
    queue.stop();
  }
  const manager = createRecoveryManager({ runtimeDirectory: runtime, projectsRoot: projects });
  manager.runStartupSweep();
  const report = await manager.report();
  assert.equal(report.unclean, false);
  assert.equal(report.needsAttention, false);
  assert.equal(report.engines, null, 'unreachable engines are reported as unknown, not as healthy');
});

test('a crash loop stop is surfaced and dismissing hides only what was shown', async (t) => {
  const { runtime, projects, startup, queue, insert } = await fixture(t);
  await startup({ state: 'clean', startedAt: '2026-01-01T00:00:00.000Z' });
  markRecoveryNeeded('host', { count: 5, windowMs: 600000 }, { directory: runtime });
  const manager = createRecoveryManager({ runtimeDirectory: runtime, projectsRoot: projects });
  manager.runStartupSweep();
  const first = await manager.report();
  assert.equal(first.recoveryNeeded.component, 'host');
  assert.equal(first.needsAttention, true);

  await manager.act({ action: 'dismiss' });
  const dismissed = await manager.report();
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.needsAttention, false);

  insert({ type: 'images', status: 'interrupted' });
  if (!queue.stopped) {
    queue.stop();
  }
  const afterNewProblem = await manager.report();
  assert.equal(afterNewProblem.needsAttention, true, 'a new problem brings the panel back');
});

test('actions are confirmed, re-checked against the job table, and limited to what is safe', async (t) => {
  const { runtime, projects, startup, queue, insert } = await fixture(t);
  await startup(UNCLEAN);
  const unknown = insert({ type: 'images', status: 'interrupted' });
  const safe = insert({ type: '3d', status: 'needs_attention' });
  const accepted = insert({ type: 'sfx', status: 'needs_attention', remoteId: REMOTE });
  if (!queue.stopped) {
    queue.stop();
  }
  const calls = [];
  const manager = createRecoveryManager({
    runtimeDirectory: runtime,
    projectsRoot: projects,
    callRuntime: async (route, init) => {
      calls.push([route, init?.method, init?.body]);
      return { job: { id: route.split('/')[4] } };
    },
  });
  manager.runStartupSweep();

  await assert.rejects(manager.act({ action: 'resolve-job', jobId: unknown }), { status: 400 });
  await assert.rejects(
    manager.act({ action: 'resolve-job', jobId: safe, confirm: 'engine-job-not-running' }),
    { status: 400 },
    'only an interrupted job can be marked cancelled',
  );
  await manager.act({ action: 'resolve-job', jobId: unknown, confirm: 'engine-job-not-running' });
  assert.deepEqual(calls.at(-1), [
    `/api/runtime/jobs/${unknown}/resolve`,
    'POST',
    { confirmRemoteNotRunning: true },
  ]);

  await assert.rejects(manager.act({ action: 'retry-job', jobId: unknown }), { status: 409 });
  await assert.rejects(manager.act({ action: 'retry-job', jobId: accepted }), { status: 409 });
  await manager.act({ action: 'retry-job', jobId: safe });
  assert.equal(calls.at(-1)[0], `/api/runtime/jobs/${safe}/retry`);

  await assert.rejects(manager.act({ action: 'retry-job', jobId: randomUUID() }), { status: 404 });
  await assert.rejects(manager.act({ action: 'retry-job', jobId: 'not-a-job' }), { status: 400 });
  await assert.rejects(manager.act({ action: 'delete-everything' }), { status: 400 });
  await assert.rejects(manager.act({ action: 'quarantine-orphans', ids: ['0123456789abcdef'] }), {
    status: 400,
  });
  assert.equal(calls.length, 2, 'refused actions never reached the runtime');
});

async function startService(t, { runtime, projects }) {
  const service = recoveryService({
    runtimeDirectory: runtime,
    projectsRoot: projects,
    startBackups: false,
  });
  const app = express();
  const runtimeCalls = [];
  app.post('/api/runtime/jobs/:id/resolve', (req, res) => {
    runtimeCalls.push({ origin: req.headers.origin, tag: req.headers['x-forge-request'] });
    res.json({ job: { id: req.params.id } });
  });
  const httpServer = http.createServer(app);
  service.configureServer({ middlewares: app, httpServer });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => {
    service.dispose();
    httpServer.closeAllConnections();
    httpServer.close();
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  return { base, runtimeCalls };
}

test('the HTTP route serves the report to anyone local and acts only for the studio itself', async (t) => {
  const { runtime, projects, startup, queue, insert } = await fixture(t);
  await startup(UNCLEAN);
  const interrupted = insert({ type: 'images', status: 'interrupted' });
  if (!queue.stopped) {
    queue.stop();
  }
  const { base, runtimeCalls } = await startService(t, { runtime, projects });

  const report = await (await fetch(`${base}/api/recovery`)).json();
  assert.equal(report.unclean, true);
  assert.equal(report.jobs.items[0].id, interrupted);
  const listing = await (await fetch(`${base}/api/recovery/backups`)).json();
  assert.ok(Array.isArray(listing.databases));
  assert.equal((await fetch(`${base}/api/recovery/unknown`)).status, 404);

  const body = JSON.stringify({
    action: 'resolve-job',
    jobId: interrupted,
    confirm: 'engine-job-not-running',
  });
  const post = (headers) =>
    fetch(`${base}/api/recovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  assert.equal((await post({})).status, 403, 'no origin or marker header');
  assert.equal((await post({ Origin: base })).status, 403, 'no marker header');
  assert.equal(
    (await post({ Origin: 'http://evil.example', 'X-Forge-Request': 'recovery' })).status,
    403,
  );
  const accepted = await post({ Origin: base, 'X-Forge-Request': 'recovery' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(runtimeCalls, [{ origin: base, tag: 'runtime' }]);
  const nonObjectBody = await fetch(`${base}/api/recovery`, {
    method: 'POST',
    headers: { Origin: base, 'X-Forge-Request': 'recovery', 'Content-Type': 'application/json' },
    body: '[1,2]',
  });
  assert.equal(nonObjectBody.status, 400);
});
