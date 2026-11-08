// /api/logs routes (runtime/logs-service.js) on a loopback Express host with a temporary runtime
// folder: security checks, validation, filters, FTS, tail, export, delete and request logging.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { configureAppLog, createLogger, resetAppLogForTests } from '../runtime/app-log.js';
import { logsService, parseBrowserRecord } from '../runtime/logs-service.js';

async function startHost(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-logs-service-'));
  resetAppLogForTests();
  configureAppLog({ runtimeDirectory: directory, sink: 'spool' });
  const app = express();
  const httpServer = http.createServer(app);
  const service = logsService({
    runtimeDir: directory,
    ingestIntervalMs: 0,
    retentionIntervalMs: 0,
    getSetting: () => undefined,
    ...options,
  });
  service.configureServer({ middlewares: app, httpServer });
  // Stand-ins for the older file-log routes in diagnostics.js and another studio route.
  app.use('/api/logs', (req, res) => res.json({ sources: [], fileLogs: true, url: req.url }));
  app.get('/api/projects/:id/assets', (_req, res) => res.json({ ok: true }));
  app.get('/api/broken', (_req, res) => res.status(500).json({ error: 'boom' }));
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    service.close();
    resetAppLogForTests();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return { origin, service, directory };
}

function api(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
  return fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const LOGS = { 'X-Forge-Request': 'logs' };
const INGEST = { 'X-Forge-Request': 'app-log' };

function browserRecord(overrides = {}) {
  return {
    ts: Date.now(),
    level: 'info',
    component: 'ui',
    event: 'ui.route.changed',
    message: '',
    fields: { page: 'images' },
    process: 'browser',
    pid: 0,
    seq: 1,
    traceId: null,
    jobId: null,
    durationMs: null,
    count: 1,
    firstTs: null,
    ...overrides,
  };
}

test('ingest validates browser batches and stores only allow-listed fields', async (t) => {
  const { origin } = await startHost(t);
  assert.equal(
    (await api(origin, '/api/logs/ingest', { method: 'POST', body: { records: [] } })).status,
    403,
  );
  assert.equal(
    (
      await api(origin, '/api/logs/ingest', {
        method: 'POST',
        headers: { ...INGEST, Origin: 'http://evil.example' },
        body: { records: [] },
      })
    ).status,
    403,
  );
  assert.equal(
    (await api(origin, '/api/logs/ingest', { method: 'POST', headers: INGEST, body: '{oops' }))
      .status,
    400,
  );
  assert.equal(
    (
      await api(origin, '/api/logs/ingest', {
        method: 'POST',
        headers: INGEST,
        body: { records: [{}], extra: 'x'.repeat(200 * 1024) },
      })
    ).status,
    413,
  );
  const response = await api(origin, '/api/logs/ingest', {
    method: 'POST',
    headers: INGEST,
    body: {
      records: [
        browserRecord(),
        browserRecord({
          level: 'warn',
          component: 'http',
          event: 'http.request.failed',
          fields: { route: '/api/jobs/:param', status: 500, prompt: 'a castle at dusk' },
          durationMs: 12,
        }),
        browserRecord({ event: 'Not valid' }),
        browserRecord({ component: 'made-up' }),
        browserRecord({ secret: 'x' }),
      ],
      droppedCount: 4,
    },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: 2, rejected: 3 });

  const list = await (await api(origin, '/api/logs?component=http', { headers: LOGS })).json();
  const [row] = list.rows;
  assert.equal(row.event, 'http.request.failed');
  assert.equal(row.process, 'browser');
  assert.equal(row.durationMs, 12);
  assert.equal(row.fields.route, '/api/jobs/:param');
  assert.ok(!JSON.stringify(row).includes('castle'));
  const summary = await (await api(origin, '/api/logs/summary', { headers: LOGS })).json();
  assert.equal(summary.dropped.browser_rejected_records, 3);
  assert.equal(summary.dropped.browser_dropped_records, 4);
});

test('ingest is rate limited', async (t) => {
  const { origin } = await startHost(t, { ingestLimitPer10s: 2 });
  const send = () =>
    api(origin, '/api/logs/ingest', { method: 'POST', headers: INGEST, body: { records: [] } });
  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 429);
});

test('reads need the header and a loopback host; the old file-log routes still work', async (t) => {
  const { origin } = await startHost(t);
  const fileLogs = await (await api(origin, '/api/logs?source=studio')).json();
  assert.equal(fileLogs.fileLogs, true);
  const stream = await (await api(origin, '/api/logs/stream', { headers: LOGS })).json();
  assert.equal(stream.fileLogs, true);
  assert.equal((await api(origin, '/api/logs/summary')).status, 403);
  const foreignHost = await new Promise((resolve) => {
    const request = http.request(
      `${origin}/api/logs/summary`,
      { headers: { ...LOGS, Host: 'forge.example.com' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await api(origin, '/api/logs?level=loud', { headers: LOGS })).status, 400);
  assert.equal((await api(origin, '/api/logs?component=nope', { headers: LOGS })).status, 400);
  assert.equal((await api(origin, '/api/logs?limit=9999', { headers: LOGS })).status, 400);
  assert.equal((await api(origin, '/api/logs?cursor=bad', { headers: LOGS })).status, 400);
  assert.equal((await api(origin, '/api/logs/nothing', { headers: LOGS })).status, 404);
});

test('filters, full-text search, tail, export and delete', async (t) => {
  const { origin } = await startHost(t);
  const queue = createLogger('queue');
  const engine = createLogger('engine');
  queue.info('job.state.changed', { jobId: 'job-1', from: 'queued', to: 'running' });
  queue.warn(
    'queue.admission.waited',
    { jobId: 'job-2', reason: 'waiting_memory', freeMiB: 10 },
    'Waiting for GPU memory.',
  );
  engine.error('engine.start.failed', { engineId: 'images', exitCode: 3 });

  const warnings = await (await api(origin, '/api/logs?level=warn', { headers: LOGS })).json();
  assert.deepEqual(warnings.rows.map((row) => row.event).sort(), [
    'engine.start.failed',
    'queue.admission.waited',
  ]);
  const search = await (await api(origin, '/api/logs?text=gpu', { headers: LOGS })).json();
  assert.equal(search.rows[0].jobId, 'job-2');
  const prefix = await (await api(origin, '/api/logs?event=engine.', { headers: LOGS })).json();
  assert.equal(prefix.rows.length, 1);
  const job = await (await api(origin, '/api/logs?jobId=job-1', { headers: LOGS })).json();
  assert.equal(job.rows[0].fields.to, 'running');

  const firstTail = await (await api(origin, '/api/logs/tail', { headers: LOGS })).json();
  queue.info('job.state.changed', { jobId: 'job-3', to: 'completed' });
  const nextTail = await (
    await api(origin, `/api/logs/tail?after=${firstTail.cursor}&component=queue`, { headers: LOGS })
  ).json();
  assert.deepEqual(
    nextTail.rows.map((row) => row.jobId),
    ['job-3'],
  );

  const exported = await api(origin, '/api/logs/export?format=jsonl&component=queue', {
    headers: LOGS,
  });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /forge-log-.*\.jsonl/);
  const lines = (await exported.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((line) => line.component === 'queue'));
  assert.equal((await api(origin, '/api/logs/export?format=csv', { headers: LOGS })).status, 400);

  const deleteWithoutOrigin = await api(origin, '/api/logs', {
    method: 'DELETE',
    headers: LOGS,
    body: { olderThanDays: 0, confirm: true },
  });
  assert.equal(deleteWithoutOrigin.status, 403);
  const unconfirmed = await api(origin, '/api/logs', {
    method: 'DELETE',
    headers: { ...LOGS, Origin: origin },
    body: { olderThanDays: 0 },
  });
  assert.equal(unconfirmed.status, 400);
  const deleted = await api(origin, '/api/logs', {
    method: 'DELETE',
    headers: { ...LOGS, Origin: origin },
    body: { olderThanDays: 0, confirm: true },
  });
  assert.equal(deleted.status, 200);
  assert.ok((await deleted.json()).deleted >= 4);
});

test('every /api request is logged with a route template and a trace id', async (t) => {
  const { origin } = await startHost(t);
  const assets = await api(origin, '/api/projects/my-secret-game/assets?search=dragon', {
    headers: { 'x-forge-trace': 'trace-from-browser-1' },
  });
  assert.equal(assets.headers.get('x-forge-trace'), 'trace-from-browser-1');
  const broken = await api(origin, '/api/broken');
  assert.match(broken.headers.get('x-forge-trace'), /^[0-9a-f]{16}$/);
  const rows = (
    await (await api(origin, '/api/logs?component=http&level=trace', { headers: LOGS })).json()
  ).rows;
  const failed = rows.find((row) => row.event === 'http.request.failed');
  assert.equal(failed.fields.route, '/api/broken');
  assert.equal(failed.fields.status, 500);
  const completed = rows.find((row) => row.traceId === 'trace-from-browser-1');
  assert.equal(completed, undefined, 'successful requests are debug and off by default');
  assert.ok(!JSON.stringify(rows).includes('my-secret-game'));
  assert.ok(!JSON.stringify(rows).includes('dragon'));
});

test('parseBrowserRecord rejects unknown keys and keeps timestamps sane', () => {
  const now = () => 1_000_000_000_000;
  const redact = (text) => text;
  assert.equal(parseBrowserRecord({ ...browserRecord(), extra: 1 }, { now, redact }), null);
  const record = parseBrowserRecord(browserRecord({ ts: 5 }), { now, redact });
  assert.equal(record.ts, now());
  assert.equal(record.process, 'browser');
});
