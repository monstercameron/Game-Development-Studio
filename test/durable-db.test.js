import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  backupDatabase,
  checkDatabaseFile,
  listBackups,
  openDatabase,
  resetDatabaseChecksForTests,
} from '../runtime/durable-db.js';
import { readRecoveryEvents } from '../runtime/recovery-events.js';
import { startCrashWorker } from './fixtures/start-crash-worker.js';

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-durable-db-'));
  resetDatabaseChecksForTests();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function seed(file, rows) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  for (const value of rows) {
    db.prepare('INSERT INTO t(v) VALUES (?)').run(value);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

const values = (db) =>
  db
    .prepare('SELECT v FROM t ORDER BY id')
    .all()
    .map((row) => row.v);

test('databases open with explicit durability settings', async (t) => {
  const directory = await temp(t);
  const full = openDatabase(path.join(directory, 'jobs.sqlite'), { directory });
  assert.equal(full.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(full.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(full.prepare('PRAGMA busy_timeout').get().timeout, 5000);
  const relaxed = openDatabase(path.join(directory, 'errors.sqlite'), {
    directory,
    synchronous: 'NORMAL',
  });
  assert.equal(relaxed.prepare('PRAGMA synchronous').get().synchronous, 1);
  full.close();
  relaxed.close();
});

test('a corrupt database is moved aside and the newest valid backup is restored', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'jobs.sqlite');
  seed(file, ['one', 'two']);
  const first = backupDatabase(file, { name: 'jobs', directory });
  assert.equal(first.status, 'created');
  // Damage the live file the way a torn write would: zeroed pages after the header.
  const bytes = await fs.readFile(file);
  bytes.fill(0x00, 100, bytes.length);
  await fs.writeFile(file, bytes);
  assert.equal(checkDatabaseFile(file).ok, false);

  const db = openDatabase(file, { name: 'jobs', directory });
  assert.deepEqual(values(db), ['one', 'two']);
  db.close();

  const names = await fs.readdir(directory);
  assert.ok(
    names.some((name) => /^jobs\.sqlite\.corrupt-\d+$/.test(name)),
    names.join(),
  );
  const codes = readRecoveryEvents({ directory }).map((event) => event.code);
  assert.ok(codes.includes('database.quarantined'));
  assert.ok(codes.includes('database.restored'));
  assert.ok(!codes.includes('database.started_fresh'));
});

test('without a usable backup a corrupt database starts fresh and keeps the damaged file', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'settings.sqlite');
  await fs.writeFile(file, 'this is not a sqlite database at all'.repeat(40));
  const db = openDatabase(file, { name: 'settings', directory });
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.close();
  const names = await fs.readdir(directory);
  assert.ok(names.some((name) => name.startsWith('settings.sqlite.corrupt-')));
  const damaged = names.find((name) => name.startsWith('settings.sqlite.corrupt-'));
  assert.match(await fs.readFile(path.join(directory, damaged), 'utf8'), /not a sqlite/);
  const events = readRecoveryEvents({ directory });
  const fresh = events.find((event) => event.code === 'database.started_fresh');
  assert.equal(fresh.severity, 'error');
  assert.equal(fresh.id, 'settings');
});

test('a damaged backup is skipped in favour of an older valid one', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'jobs.sqlite');
  seed(file, ['good']);
  const older = backupDatabase(file, { name: 'jobs', directory, now: new Date('2026-01-01') });
  assert.equal(older.status, 'created');
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO t(v) VALUES (?)').run('newer');
  db.close();
  const newer = backupDatabase(file, { name: 'jobs', directory, now: new Date('2026-02-01') });
  assert.equal(newer.status, 'created');
  await fs.writeFile(newer.file, 'damaged backup');
  await fs.writeFile(file, 'damaged live database'.repeat(50));

  const restored = openDatabase(file, { name: 'jobs', directory });
  assert.deepEqual(values(restored), ['good']);
  restored.close();
  const codes = readRecoveryEvents({ directory }).map((event) => event.code);
  assert.ok(codes.includes('database.backup_invalid'));
  assert.ok(codes.includes('database.restored'));
});

test('backups are rotated, size capped, skipped when unchanged and never taint the source', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'jobs.sqlite');
  seed(file, ['a']);
  assert.equal(backupDatabase(file, { name: 'jobs', directory, keep: 2 }).status, 'created');
  assert.equal(backupDatabase(file, { name: 'jobs', directory, keep: 2 }).status, 'unchanged');
  assert.equal(backupDatabase(file, { name: 'jobs', directory, maxBytes: 10 }).reason, 'too_large');
  assert.equal(
    backupDatabase(path.join(directory, 'missing.sqlite'), { name: 'missing', directory }).reason,
    'missing',
  );
  for (const [index, day] of ['2026-03-01', '2026-03-02', '2026-03-03'].entries()) {
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO t(v) VALUES (?)').run(`row-${index}`);
    db.close();
    const result = backupDatabase(file, { name: 'jobs', directory, keep: 2, now: new Date(day) });
    assert.equal(result.status, 'created');
    // The change detector compares file times, so make the next write look newer.
    await fs.utimes(
      file,
      new Date(Date.now() + (index + 1) * 5000),
      new Date(Date.now() + (index + 1) * 5000),
    );
  }
  const backups = listBackups(path.join(directory, 'backups', 'jobs'));
  assert.equal(backups.length, 2);
  assert.ok(backups.every((backup) => checkDatabaseFile(backup.file).ok));
  const leftovers = (await fs.readdir(path.join(directory, 'backups', 'jobs'))).filter((name) =>
    name.endsWith('.tmp'),
  );
  assert.deepEqual(leftovers, []);
});

test('a backup can be taken while a writer holds an open write transaction', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'jobs.sqlite');
  seed(file, ['committed']);
  const writer = openDatabase(file, { name: 'jobs', directory });
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare('INSERT INTO t(v) VALUES (?)').run('uncommitted');
  const result = backupDatabase(file, { name: 'jobs', directory });
  assert.equal(result.status, 'created');
  writer.exec('ROLLBACK');
  writer.close();
  const copy = new DatabaseSync(result.file, { readOnly: true });
  // Only committed data is in the backup.
  assert.deepEqual(values(copy), ['committed']);
  copy.close();
});

test('a process killed inside a write transaction loses only the uncommitted rows', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'jobs.sqlite');
  const { child, ready } = startCrashWorker(t, 'sqlite-transaction', file);
  await ready;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;

  assert.equal(checkDatabaseFile(file).ok, true);
  const db = openDatabase(file, { name: 'jobs', directory });
  const rows = values(db);
  db.close();
  assert.equal(rows.length, 50);
  assert.ok(rows.every((value) => value.startsWith('committed-')));
  assert.deepEqual(
    readRecoveryEvents({ directory }).filter((event) => event.kind === 'database'),
    [],
    'a clean recovery from the write-ahead log needs no repair',
  );
});

test('a torn write-ahead log tail keeps every earlier commit', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'jobs.sqlite');
  const { child, ready } = startCrashWorker(t, 'sqlite-plain', file);
  await ready;
  // Commit rows from this process while the child still holds the database open, so they sit in
  // the write-ahead log instead of the main file.
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA wal_autocheckpoint=0');
  for (let index = 0; index < 40; index++) {
    writer.prepare('INSERT INTO t(v) VALUES (?)').run(`row-${index}-${'x'.repeat(200)}`);
  }
  const walPath = `${file}-wal`;
  const walBytes = await fs.readFile(walPath);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  writer.close();

  // Rebuild the state a power failure leaves: the main file as it was and a log whose last frame
  // is cut in half.
  const crashed = path.join(directory, 'crashed');
  await fs.mkdir(crashed);
  const crashedFile = path.join(crashed, 'jobs.sqlite');
  seed(crashedFile, []);
  await fs.rm(`${crashedFile}-wal`, { force: true });
  await fs.rm(`${crashedFile}-shm`, { force: true });
  await fs.writeFile(`${crashedFile}-wal`, walBytes.subarray(0, walBytes.length - 1500));
  const db = openDatabase(crashedFile, { name: 'jobs', directory: crashed });
  const rows = values(db);
  db.close();
  assert.ok(rows.length > 0 && rows.length < 40, `${rows.length} rows survived`);
  assert.deepEqual(
    rows,
    Array.from({ length: rows.length }, (_, index) => `row-${index}-${'x'.repeat(200)}`),
  );
  assert.equal(checkDatabaseFile(crashedFile).ok, true);
});
