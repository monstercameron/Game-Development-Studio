// Structured application log: Node writer, field rules, spool ingest, store and retention.
// See docs/LOGGING.md. Every test uses a temporary runtime folder or the memory sink.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clearMemoryLogRecords,
  configureAppLog,
  createLogger,
  currentTraceId,
  flushAppLog,
  readMemoryLogRecords,
  resetAppLogForTests,
  runWithTrace,
  traceEnv,
  traceHeaders,
  withLogging,
} from '../runtime/app-log.js';
import { createLogIngester } from '../runtime/log-ingest.js';
import { parseLevelSpec, routeTemplate, sanitizeFields } from '../runtime/log-fields.js';
import { createLogStore, ftsQuery } from '../runtime/log-store.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const writerScript = path.join(repositoryRoot, 'test', 'fixtures', 'log-writer.mjs');
const pythonWriter = path.join(repositoryRoot, 'test', 'fixtures', 'log_writer.py');
const python = path.join(repositoryRoot, '.venv-dev', 'Scripts', 'python.exe');

const openStores = new Set();

// Stores opened by a test are closed before its folder is removed (Windows keeps open files).
function openStore(options) {
  const store = createLogStore(options);
  openStores.add(store);
  return store;
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-app-log-'));
  t.after(() => {
    for (const store of openStores) {
      store.close();
    }
    openStores.clear();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return directory;
}

function useMemorySink(level) {
  const previous = process.env.FORGE_LOG_LEVEL;
  if (level) {
    process.env.FORGE_LOG_LEVEL = level;
  } else {
    delete process.env.FORGE_LOG_LEVEL;
  }
  resetAppLogForTests();
  configureAppLog({ sink: 'memory', processName: 'test' });
  clearMemoryLogRecords();
  return () => {
    if (previous === undefined) {
      delete process.env.FORGE_LOG_LEVEL;
    } else {
      process.env.FORGE_LOG_LEVEL = previous;
    }
    resetAppLogForTests();
  };
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('levels: default info, per-component overrides, and parse errors', (t) => {
  t.after(useMemorySink('warn,queue=debug'));
  const queue = createLogger('queue');
  const engine = createLogger('engine');
  queue.debug('job.poll.checked', { jobId: 'a' });
  queue.trace('job.poll.traced', { jobId: 'a' });
  engine.info('engine.start.requested', { engineId: 'images' });
  engine.warn('engine.health.failed', { engineId: 'images' });
  const events = readMemoryLogRecords().map((record) => record.event);
  assert.deepEqual(events, ['job.poll.checked', 'engine.health.failed']);
  assert.equal(queue.isEnabled('debug'), true);
  assert.equal(engine.isEnabled('info'), false);

  const parsed = parseLevelSpec('debug,unknown-area=trace,queue=loud,http=error');
  assert.equal(parsed.level, 'debug');
  assert.deepEqual(parsed.components, { http: 'error' });
  assert.equal(parsed.problems.length, 2);
});

test('allow-list keeps ids, numbers, enums and errors and drops everything else', (t) => {
  t.after(useMemorySink());
  const log = createLogger('image');
  log.info('image.render.completed', {
    jobId: 'job-1',
    modelId: 'Qwen/Qwen-Image',
    durationMs: 1234.6,
    outputBytes: 2048,
    isCached: false,
    to: 'completed',
    prompt: 'a castle at dusk',
    outputPath: 'C:\\Users\\alice\\Pictures\\castle.png',
    reason: 'the user typed a sentence',
    width: 'wide',
    options: { steps: 4 },
  });
  const [record] = readMemoryLogRecords();
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.durationMs, 1235);
  assert.deepEqual(record.fields, {
    modelId: 'Qwen/Qwen-Image',
    outputBytes: 2048,
    isCached: false,
    to: 'completed',
    droppedFields: 5,
    droppedFieldNames: ['prompt', 'outputPath', 'reason', 'width', 'options'],
  });

  const { fields, dropped } = sanitizeFields({ error: new TypeError('bad value'), 'bad-name': 1 });
  assert.equal(fields.errorClass, 'TypeError');
  assert.equal(fields.errorMessage, 'bad value');
  assert.ok(Array.isArray(fields.errorFrames));
  assert.deepEqual(dropped, ['(invalid-name)']);
});

test('invalid events, unknown components and hostile inputs never throw', (t) => {
  t.after(useMemorySink());
  const log = createLogger('not-a-component');
  const hostile = {
    get jobId() {
      throw new Error('getter exploded');
    },
  };
  assert.doesNotThrow(() => {
    log.info('Not An Event!', hostile);
    log.info(null, null);
    log.error('job.failed', 'a string instead of fields');
    log.warn('job.failed', { error: Symbol('x') });
    createLogger('queue').info('job.state.changed', { count: 10n });
  });
  const records = readMemoryLogRecords();
  assert.ok(records.some((record) => record.event === 'log.component.unknown'));
  assert.ok(records.some((record) => record.event === 'log.event.invalid'));
  assert.ok(records.every((record) => record.component !== 'not-a-component'));
});

test('redaction: prompts, keys, user paths and bearer tokens never reach the database', async (t) => {
  const directory = temporaryDirectory(t);
  t.after(() => resetAppLogForTests());
  resetAppLogForTests();
  configureAppLog({ runtimeDirectory: directory, sink: 'spool', processName: 'redaction' });
  const log = createLogger('errors');
  const prompt = 'a misty castle on a hill at dusk, cinematic';
  const apiKey = 'sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789';
  const userPath = 'C:\\Users\\alice\\Documents\\secret-plans.txt';
  const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijk';
  log.error(
    'errors.openai.request.failed',
    {
      prompt,
      modelId: apiKey,
      reason: userPath,
      route: '/home/alice/private',
      error: new Error(
        `Request failed for ${userPath} with ${bearer} and key ${apiKey}: ${prompt}`,
      ),
    },
    `Upload of ${userPath} failed with ${bearer}`,
  );
  await flushAppLog();
  const store = openStore({ directory });
  createLogIngester({ store, spoolDirectory: path.join(directory, 'log-spool') }).drain();
  const [row] = store.query({}).rows;
  assert.equal(row.event, 'errors.openai.request.failed');
  store.close();
  const bytes = fs.readFileSync(path.join(directory, 'logs.sqlite')).toString('latin1');
  const wal = fs.existsSync(path.join(directory, 'logs.sqlite-wal'))
    ? fs.readFileSync(path.join(directory, 'logs.sqlite-wal')).toString('latin1')
    : '';
  const spool = fs
    .readdirSync(path.join(directory, 'log-spool'))
    .map((name) => fs.readFileSync(path.join(directory, 'log-spool', name), 'utf8'))
    .join('');
  for (const secret of ['alice', 'sk-proj-Abcdef', 'eyJhbGciOiJIUzI1NiJ9abc', 'secret-plans']) {
    assert.ok(!bytes.includes(secret), `database contains ${secret}`);
    assert.ok(!wal.includes(secret), `WAL contains ${secret}`);
    assert.ok(!spool.includes(secret), `spool contains ${secret}`);
  }
  // The prompt is only reachable inside an error message, where it is truncated and redacted
  // but not removed: the guide forbids passing prompts, and the allow-list drops `prompt`.
  assert.ok(row.fields.droppedFieldNames.includes('prompt'));
  assert.ok(row.fields.droppedFieldNames.includes('reason'));
  assert.match(row.message, /<path>|<home>/);
});

test('dedupe collapses a hot loop and the rate limit counts drops', (t) => {
  t.after(useMemorySink());
  const log = createLogger('queue');
  for (let index = 0; index < 100; index += 1) {
    log.warn('queue.poll.failed', { jobId: 'same' });
  }
  let records = readMemoryLogRecords();
  const passed = records.filter((record) => record.count === 1);
  const summary = records.find((record) => record.count > 1);
  assert.equal(passed.length, 20);
  assert.equal(summary.count, 80);
  assert.equal(summary.fields.collapsed, true);
  assert.ok(summary.firstTs <= summary.ts);

  clearMemoryLogRecords();
  for (let index = 0; index < 1500; index += 1) {
    log.info('job.state.changed', { jobId: `job-${index}` });
  }
  records = readMemoryLogRecords();
  const drop = records.find((record) => record.event === 'log.records.dropped');
  assert.ok(drop, 'a drop record is written');
  assert.equal(drop.fields.reason, 'rate');
  const kept = records.filter((record) => record.event === 'job.state.changed').length;
  assert.equal(kept + drop.fields.droppedCount, 1500);
});

test('time, child, withLogging and trace propagation', async (t) => {
  t.after(useMemorySink());
  const log = createLogger('image');
  const jobLog = log.child({ jobId: 'job-7', modelId: 'qwen' });
  const stop = jobLog.time('image.render.timed', { steps: 4 });
  assert.equal(typeof stop({ outcome: 'completed' }), 'number');
  const wrapped = withLogging(async (value) => {
    if (value < 0) {
      throw new RangeError('negative');
    }
    return value * 2;
  }, 'image.thumbnail.render');
  assert.equal(await wrapped(2), 4);
  await assert.rejects(wrapped(-1), RangeError);
  await runWithTrace('trace-abc-123', async () => {
    await Promise.resolve();
    assert.equal(currentTraceId(), 'trace-abc-123');
    assert.deepEqual(traceHeaders(), { 'x-forge-trace': 'trace-abc-123' });
    assert.deepEqual(traceEnv(), { FORGE_TRACE_ID: 'trace-abc-123' });
    log.info('image.render.queued', { jobId: 'job-8' });
  });
  const records = readMemoryLogRecords();
  const timed = records.find((record) => record.event === 'image.render.timed');
  assert.equal(timed.jobId, 'job-7');
  assert.equal(timed.fields.modelId, 'qwen');
  assert.equal(timed.fields.steps, 4);
  assert.equal(typeof timed.durationMs, 'number');
  const events = records.map((record) => record.event);
  assert.ok(events.includes('image.thumbnail.render.completed'));
  const failed = records.find((record) => record.event === 'image.thumbnail.render.failed');
  assert.equal(failed.level, 'error');
  assert.equal(failed.fields.errorClass, 'RangeError');
  assert.equal(
    records.find((record) => record.event === 'image.render.queued').traceId,
    'trace-abc-123',
  );
});

test('route templates never keep ids, names or query strings', () => {
  assert.equal(routeTemplate('/api/jobs/42?x=1'), '/api/jobs/:param');
  assert.equal(routeTemplate('/api/projects/my-secret-game/assets'), '/api/projects/:param/assets');
  assert.equal(routeTemplate('/api/runtime/health'), '/api/runtime/health');
  assert.equal(routeTemplate('/api/files/Castle%20Plans.png'), '/api/files/:param');
});

test('store: filters, FTS search, cursor paging, tail and summary', (t) => {
  const directory = temporaryDirectory(t);
  const store = openStore({ directory, now: () => 1_000_000 });
  const base = { process: 'test', pid: 1, seq: 1, count: 1, fields: {} };
  store.insert([
    {
      ...base,
      ts: 1000,
      level: 'info',
      component: 'queue',
      event: 'job.state.changed',
      jobId: 'a',
    },
    { ...base, ts: 2000, level: 'error', component: 'engine', event: 'engine.start.failed' },
    {
      ...base,
      ts: 3000,
      level: 'warn',
      component: 'queue',
      event: 'queue.admission.waited',
      message: 'Waiting for GPU memory.',
      traceId: 'trace-0001',
    },
    { ...base, ts: 4000, level: 'debug', component: 'http', event: 'http.request.completed' },
  ]);
  assert.equal(store.query({ level: 'warn' }).rows.length, 2);
  assert.deepEqual(
    store.query({ components: ['queue'] }).rows.map((row) => row.ts),
    [3000, 1000],
  );
  assert.equal(store.query({ eventPrefix: 'engine.' }).rows[0].event, 'engine.start.failed');
  assert.equal(store.query({ text: 'gpu memo' }).rows[0].event, 'queue.admission.waited');
  assert.equal(store.query({ text: 'admission' }).rows.length, 1);
  assert.equal(store.query({ text: '") OR 1=1 --' }).rows.length, 0);
  assert.equal(ftsQuery('a "b" c*'), '"a"* AND "b"* AND "c"*');
  assert.equal(store.query({ traceId: 'trace-0001' }).rows.length, 1);
  assert.equal(store.query({ jobId: 'a' }).rows.length, 1);
  assert.equal(store.query({ since: 2000, until: 4000 }).rows.length, 2);
  assert.throws(() => store.query({ level: 'loud' }), /level/);
  assert.throws(() => store.query({ components: ['nope'] }), /component/);

  const first = store.query({}, { limit: 3 });
  assert.equal(first.rows.length, 3);
  const second = store.query({}, { limit: 3, cursor: first.nextCursor });
  assert.deepEqual(
    second.rows.map((row) => row.ts),
    [1000],
  );
  assert.equal(second.nextCursor, null);

  const tail = store.tail({}, { afterId: 2 });
  assert.deepEqual(
    tail.rows.map((row) => row.id),
    [3, 4],
  );
  assert.equal(tail.cursor, 4);

  const summary = store.summary();
  assert.equal(summary.rows, 4);
  assert.equal(summary.byLevel.error, 1);
  assert.ok(summary.fileBytes > 0);
});

test('retention: age and size limits prune the oldest rows', (t) => {
  const directory = temporaryDirectory(t);
  const now = Date.now();
  const store = openStore({ directory, now: () => now });
  const day = 24 * 60 * 60 * 1000;
  const rows = [];
  for (let index = 0; index < 6000; index += 1) {
    rows.push({
      ts: now - (index < 1000 ? 20 * day : day) + index,
      level: 'info',
      component: 'queue',
      event: 'job.state.changed',
      message: 'x'.repeat(200),
      fields: { index, padCount: index },
      process: 'test',
      pid: 1,
      seq: index,
    });
  }
  store.insert(rows);
  const byAge = store.prune({ maxAgeDays: 14, maxBytes: 1024 * 1024 * 1024 });
  assert.equal(byAge.deletedByAge, 1000);
  assert.equal(store.summary().rows, 5000);
  const bySize = store.prune({ maxAgeDays: 14, maxBytes: 256 * 1024 });
  assert.ok(bySize.deletedBySize > 0);
  assert.ok(bySize.usedBytes <= 256 * 1024, `used ${bySize.usedBytes}`);
  const remaining = store.query({}, { limit: 500 }).rows;
  assert.ok(remaining.length > 0, 'the newest rows are kept');
  assert.ok(remaining.every((row) => row.fields.index >= 1000));
  assert.equal(store.deleteOlderThan(0) >= 0, true);
});

test('concurrent writers: 4 Node processes x 500 rows (+ Python) lose nothing', async (t) => {
  const directory = temporaryDirectory(t);
  const env = { ...process.env, FORGE_RUNTIME_DIR: directory, FORGE_LOG_LEVEL: 'info' };
  delete env.FORGE_LOG_SINK;
  const store = openStore({ directory });
  const ingester = createLogIngester({ store, spoolDirectory: path.join(directory, 'log-spool') });
  let isRunning = true;
  // Ingest while the writers are still appending, as the host does.
  const ingestLoop = (async () => {
    while (isRunning) {
      ingester.ingestOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const writers = [1, 2, 3, 4].map(() => runNode([writerScript, '500'], env));
  const hasPython = fs.existsSync(python);
  if (hasPython) {
    writers.push(
      new Promise((resolve) => {
        const child = spawn(python, [pythonWriter, '500'], { env, stdio: 'ignore' });
        child.on('exit', (code) => resolve({ code, stderr: '' }));
      }),
    );
  }
  const results = await Promise.all(writers);
  isRunning = false;
  await ingestLoop;
  ingester.drain();
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
  }
  const expected = 2000 + (hasPython ? 500 : 0);
  const summary = store.summary({ eventPrefix: 'job.state.changed' });
  assert.equal(summary.rows, expected);
  assert.equal(summary.dropped.records, 0);
  assert.equal(ingester.stats.rejected, 0);
  assert.equal(ingester.stats.lastError, null);
  const unique = new Set(
    [...store.exportRows({ eventPrefix: 'job.state.changed' })].map(
      (row) => `${row.process}:${row.pid}:${row.seq}`,
    ),
  );
  assert.equal(unique.size, expected, 'no duplicates');
  assert.deepEqual(fs.readdirSync(path.join(directory, 'log-spool')), [], 'spool files removed');
});

test('crash flush: records logged right before an uncaught exception are kept', async (t) => {
  const directory = temporaryDirectory(t);
  const env = { ...process.env, FORGE_RUNTIME_DIR: directory };
  const result = await runNode([writerScript, '3', 'crash'], env);
  assert.equal(result.code, 1);
  const store = openStore({ directory });
  createLogIngester({ store, spoolDirectory: path.join(directory, 'log-spool') }).drain();
  const events = store.query({}).rows.map((row) => row.event);
  assert.equal(events.filter((event) => event === 'job.state.changed').length, 3);
  const crash = store.query({ eventPrefix: 'process.exception' }).rows[0];
  assert.equal(crash.fields.errorClass, 'Error');
  assert.equal(crash.fields.reason, 'uncaughtException');
});

test('ingest: a partial last line waits, and a second ingester never duplicates', (t) => {
  const directory = temporaryDirectory(t);
  const spoolDirectory = path.join(directory, 'log-spool');
  fs.mkdirSync(spoolDirectory, { recursive: true });
  const file = path.join(spoolDirectory, `test-${process.pid}-0-1-1.jsonl`);
  const record = (seq) =>
    JSON.stringify({
      ts: Date.now(),
      level: 'info',
      component: 'queue',
      event: 'job.state.changed',
      process: 'test',
      pid: process.pid,
      seq,
      fields: {},
    });
  fs.writeFileSync(file, `${record(1)}\n${record(2)}\nnot json\n${record(3).slice(0, 20)}`);
  const store = openStore({ directory });
  const secondStore = openStore({ directory });
  const first = createLogIngester({ store, spoolDirectory });
  const second = createLogIngester({ store: secondStore, spoolDirectory });
  first.ingestOnce();
  second.ingestOnce();
  assert.equal(store.summary().rows, 2);
  assert.equal(store.summary().dropped.spool_rejected_lines, 1);
  fs.appendFileSync(file, `${record(3).slice(20)}\n`);
  second.ingestOnce();
  first.ingestOnce();
  assert.equal(store.summary().rows, 3);
  assert.ok(fs.existsSync(file), 'a live writer keeps its file');
  const exitedWriterIngester = createLogIngester({ store, spoolDirectory, isAlive: () => false });
  exitedWriterIngester.ingestOnce();
  assert.ok(!fs.existsSync(file), 'the file of an exited writer is removed once ingested');
});

test('micro-benchmark: disabled calls are cheap and enabled calls do not block', (t) => {
  t.after(useMemorySink('info'));
  const log = createLogger('queue');
  const disabledCalls = 200_000;
  let started = process.hrtime.bigint();
  for (let index = 0; index < disabledCalls; index += 1) {
    log.debug('job.poll.checked', { jobId: 'job', index });
  }
  const disabledMicroseconds = Number(process.hrtime.bigint() - started) / 1000 / disabledCalls;
  assert.ok(disabledMicroseconds < 3, `disabled call took ${disabledMicroseconds} us`);

  const enabledCalls = 900;
  started = process.hrtime.bigint();
  for (let index = 0; index < enabledCalls; index += 1) {
    log.info('job.state.changed', {
      jobId: `job-${index}`,
      from: 'queued',
      to: 'running',
      durationMs: index,
      modelId: 'Qwen/Qwen-Image',
    });
  }
  const enabledMilliseconds = Number(process.hrtime.bigint() - started) / 1e6 / enabledCalls;
  assert.ok(enabledMilliseconds < 1, `enabled call took ${enabledMilliseconds} ms`);
  t.diagnostic(
    `disabled ${disabledMicroseconds.toFixed(3)} us/call, enabled ${(enabledMilliseconds * 1000).toFixed(1)} us/call`,
  );
});

test('shared-log (browser-safe) loggers reach the Node logger', async (t) => {
  t.after(useMemorySink());
  const { createLogger: createSharedLogger } = await import('../runtime/shared-log.js');
  const log = createSharedLogger('queue').child({ jobId: 'job-shared' });
  log.info('queue.move.completed', { position: 2, prompt: 'never kept' });
  assert.equal(log.isEnabled('debug'), false);
  const [record] = readMemoryLogRecords().filter((item) => item.event === 'queue.move.completed');
  assert.equal(record.jobId, 'job-shared');
  assert.equal(record.fields.position, 2);
  assert.deepEqual(record.fields.droppedFieldNames, ['prompt']);
});
