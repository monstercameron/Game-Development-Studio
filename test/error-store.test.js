import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractLogErrors } from '../runtime/error-log-parser.js';
import { scanJobs, scanLogs } from '../runtime/error-scanner.js';
import { createErrorStore } from '../runtime/error-store.js';

// Stores are closed before their folder is removed (Windows keeps open SQLite files locked).
async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-errors-store-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) {
      store.close();
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const track = (store) => {
    stores.push(store);
    return store;
  };
  return { directory, track };
}

const TRACEBACK = [
  '2026-11-08T10:00:00.000Z INFO starting',
  'Traceback (most recent call last):',
  '  File "C:\\Users\\alice\\Forge\\runtime\\sam31_worker.py", line 118, in render_worker',
  '    result = run(model)',
  '             ~~~^^^^^^^',
  '  File "C:\\Users\\alice\\Forge\\runtime\\sam31_backend.py", line 138, in segment_image',
  "    raise ValueError('No matching objects were found.')",
  'ValueError: No matching objects were found.',
  'INFO:     Started server process [7968]',
].join('\n');

test('log parser reads multi-line Python tracebacks, chained exceptions and ASGI errors', () => {
  const { entries, safeLength } = extractLogErrors(`${TRACEBACK}\n`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, 'ValueError: No matching objects were found.');
  assert.equal(entries[0].stack.split('\n').length, 7);
  assert.equal(safeLength, TRACEBACK.length + 1);

  const chained = extractLogErrors(
    [
      'ERROR:    Exception in ASGI application',
      'Traceback (most recent call last):',
      '  File "a.py", line 1, in f',
      'KeyError: x',
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'Traceback (most recent call last):',
      '  File "b.py", line 2, in g',
      'RuntimeError: wrapped',
      'INFO: next',
      '',
    ].join('\n'),
  );
  assert.equal(chained.entries.length, 1);
  assert.equal(chained.entries[0].message, 'RuntimeError: wrapped');
  assert.equal(chained.entries[0].context.logLine, 'Exception in ASGI application');
  assert.match(chained.entries[0].stack, /KeyError: x[\s\S]*During handling/);
});

test('log parser reads error-level lines and Node stacks, and holds unfinished tracebacks', () => {
  const { entries } = extractLogErrors(
    [
      '2026-11-07T01:22:45.419Z ERROR Runtime worker 3892 stopped (4294967295).',
      '2026-11-07T01:22:46.000Z WARN only a warning',
      'TypeError: Cannot read properties of undefined',
      '    at run (C:\\x\\a.js:1:2)',
      '    at main (C:\\x\\b.js:3:4)',
      '',
    ].join('\n'),
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, 'Runtime worker 3892 stopped (4294967295).');
  assert.equal(entries[0].timestamp, '2026-11-07T01:22:45.419Z');
  assert.match(entries[1].stack, /at main/);

  const partial = 'INFO ok\nTraceback (most recent call last):\n  File "a.py", line 1, in f\n';
  const held = extractLogErrors(partial);
  assert.equal(held.entries.length, 0);
  assert.equal(held.safeLength, 'INFO ok\n'.length);
  assert.equal(extractLogErrors(partial, { final: true }).entries.length, 1);
});

test('store dedupes by fingerprint, redacts, limits fields and reopens regressions', async (t) => {
  const { directory, track } = await tempDir(t);
  const store = track(
    createErrorStore({
      directory,
      roots: { repo: 'C:\\Users\\alice\\Forge', home: 'C:\\Users\\alice', user: 'alice' },
    }),
  );
  const first = store.record({
    source: 'engine:segmentation',
    message: 'Job 1a2b3c4d-1111-2222-3333-444455556666 failed with key sk-abcdefghijklmnopqrstuv',
    stack: 'x'.repeat(100000),
  });
  const second = store.record({
    source: 'engine:segmentation',
    message: 'Job 99999999-1111-2222-3333-444455556666 failed with key sk-abcdefghijklmnopqrstuv',
    stack: 'x'.repeat(100000),
  });
  assert.equal(first.id, second.id);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  const row = store.get(first.id);
  assert.equal(row.count, 2);
  assert.ok(row.stack.length <= 32000);
  assert.doesNotMatch(row.message, /sk-abc/);
  assert.throws(() => store.record({ source: 'elsewhere', message: 'x' }), /source/);

  assert.equal(store.setStatus(row.id, 'resolved'), true);
  assert.throws(() => store.setStatus(row.id, 'done'), /valid status/);
  store.record({ source: 'engine:segmentation', message: row.message, stack: row.stack });
  assert.equal(store.get(row.id).status, 'new', 'a recurring resolved error is a regression');
  store.setStatus(row.id, 'verified', {
    fixNote: 'Fixed in C:\\Users\\alice\\Forge\\a.js',
    fixSource: 'ai',
  });
  const verified = store.get(row.id);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.fixNote, 'Fixed in <repo>\\a.js');
  assert.equal(verified.fixSource, 'ai');
  store.setStatus(row.id, 'ignored');
  store.record({ source: 'engine:segmentation', message: row.message, stack: row.stack });
  assert.equal(store.get(row.id).status, 'ignored', 'ignored errors stay ignored');

  store.markReviewed(row.id);
  assert.equal(store.get(row.id).status, 'ignored', 'viewing only changes new errors');
  const { errors } = store.list({ source: 'engine', query: 'failed' });
  assert.equal(errors.length, 1);
  assert.equal(store.list({ query: '100%_' }).errors.length, 0, 'LIKE wildcards are escaped');
});

test('unread counts errors seen since the dialog was opened', async (t) => {
  let clock = new Date('2026-11-08T10:00:00Z');
  const { directory, track } = await tempDir(t);
  const store = track(createErrorStore({ directory, now: () => clock }));
  store.record({ source: 'browser', message: 'one', at: '2026-11-08T09:00:00Z' });
  assert.equal(store.summary().unread, 1);
  store.markOpened();
  assert.equal(store.summary().unread, 0);
  clock = new Date('2026-11-08T11:00:00Z');
  store.record({ source: 'browser', message: 'two', at: '2026-11-08T10:30:00Z' });
  assert.equal(store.summary().unread, 1);
  assert.equal(store.summary().total, 2);
});

test('retention keeps the newest rows and drops old ones', async (t) => {
  const now = new Date('2026-11-08T10:00:00Z');
  const { directory, track } = await tempDir(t);
  const store = track(
    createErrorStore({ directory, retention: { maxRows: 5, maxAgeDays: 30 }, now: () => now }),
  );
  store.record({ source: 'server', message: 'ancient', at: '2026-09-01T00:00:00Z' });
  for (let index = 0; index < 8; index++) {
    store.record({
      source: 'server',
      message: `distinct ${'abcdefgh'[index]} failure`,
      at: `2026-11-0${index + 1}T00:00:00Z`,
    });
  }
  store.prune();
  const { errors, total } = store.list();
  assert.equal(total, 5);
  assert.ok(errors.every((error) => error.message !== 'ancient'));
  assert.equal(errors[0].message, 'distinct h failure');
  assert.equal(store.clear(['new']), 5);
});

test('log scanning reads incrementally from a cursor and tags the engine id', async (t) => {
  const { directory: runtimeDir, track } = await tempDir(t);
  const store = track(createErrorStore({ directory: runtimeDir }));
  const log = path.join(runtimeDir, 'engine-segmentation.log');
  await fs.writeFile(log, `${TRACEBACK}\n`);
  await fs.writeFile(path.join(runtimeDir, 'unrelated.log'), 'ERROR not a forge log\n');
  const first = await scanLogs(store, { runtimeDir });
  assert.equal(first.recorded, 1);
  const again = await scanLogs(store, { runtimeDir });
  assert.equal(again.recorded, 0, 'the cursor prevents re-reading the same lines');
  await fs.appendFile(log, 'Traceback (most recent call last):\n  File "a.py", line 1, in f\n');
  assert.equal((await scanLogs(store, { runtimeDir })).recorded, 0, 'an unfinished block waits');
  await fs.appendFile(log, 'OSError: disk full\n');
  assert.equal((await scanLogs(store, { runtimeDir })).recorded, 1);
  const { errors } = store.list();
  assert.deepEqual(new Set(errors.map((error) => error.source)), new Set(['engine:segmentation']));
  assert.ok(errors.some((error) => error.message === 'OSError: disk full'));
  // A truncated log is read again from the start.
  await fs.writeFile(log, 'ERROR fresh start\n');
  assert.equal((await scanLogs(store, { runtimeDir })).recorded, 1);
});

test('job scanning records failed jobs once and never reads job prompts', async (t) => {
  const { directory: runtimeDir, track } = await tempDir(t);
  const jobsFile = path.join(runtimeDir, 'jobs.sqlite');
  const jobs = new DatabaseSync(jobsFile);
  jobs.exec(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT, project_id TEXT, request TEXT, status TEXT, stage TEXT, error TEXT, details TEXT, created_at TEXT, updated_at TEXT)',
  );
  const insert = jobs.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run(
    'job-1',
    'images',
    'project-1',
    JSON.stringify({ prompt: 'SECRET PROMPT TEXT' }),
    'failed',
    'Failed.',
    'CUDA out of memory',
    JSON.stringify({ code: 'insufficient_gpu_memory', prompt: 'SECRET PROMPT TEXT' }),
    '2026-11-08T09:00:00Z',
    '2026-11-08T09:01:00Z',
  );
  insert.run(
    'job-2',
    'music',
    'project-1',
    '{}',
    'completed',
    'Done.',
    null,
    null,
    'a',
    '2026-11-08T09:02:00Z',
  );
  jobs.close();
  const store = track(createErrorStore({ directory: runtimeDir }));
  const now = () => new Date('2026-11-08T10:00:00Z').getTime();
  assert.equal(scanJobs(store, { jobsFile, now }).recorded, 1);
  assert.equal(scanJobs(store, { jobsFile, now }).recorded, 0);
  const [summary] = store.list().errors;
  const row = store.get(summary.id);
  assert.equal(row.source, 'queue');
  assert.equal(row.jobId, 'job-1');
  assert.equal(row.context.jobType, 'images');
  assert.equal(row.context.code, 'insufficient_gpu_memory');
  assert.doesNotMatch(JSON.stringify(row), /SECRET PROMPT/);
  assert.deepEqual(
    scanJobs(store, { jobsFile: path.join(runtimeDir, 'missing', 'x.sqlite') }).recorded,
    0,
  );
});
