// A child process that stops at a defined point so a test can kill it there (SIGKILL / terminate)
// and then inspect what a power loss would have left behind. Each mode sends "ready" over IPC
// once it is at the point to be killed at, then idles.
import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../../runtime/durable-db.js';
import { atomicWriteFile } from '../../runtime/durable-file.js';
import { JobQueue } from '../../runtime/jobs.js';
import { beginSession } from '../../runtime/session-state.js';

const [mode, target, extra] = process.argv.slice(2);
const idle = () => {
  process.send?.('ready');
  setInterval(() => {}, 1000);
};

if (mode === 'sqlite-transaction') {
  // Fifty committed rows, then fifty more inside a transaction that never commits.
  const db = openDatabase(target, {
    name: 'jobs',
    journal: 'WAL',
    directory: path.dirname(target),
  });
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  for (let index = 0; index < 50; index++) {
    db.prepare('INSERT INTO t(v) VALUES (?)').run(`committed-${index}`);
  }
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 50; index++) {
    db.prepare('INSERT INTO t(v) VALUES (?)').run(`uncommitted-${index}`);
  }
  idle();
} else if (mode === 'atomic-before-rename') {
  // Stops after the staging file is complete and flushed, before the rename into place.
  fsp.rename = async () => {
    idle();
    await new Promise(() => {});
  };
  await atomicWriteFile(target, extra);
} else if (mode === 'session') {
  const session = beginSession({ directory: target });
  session.startHeartbeat({ intervalMs: 50 });
  idle();
} else if (mode === 'queue') {
  // A queue that owns the lease and has a render mid-submission and another mid-run.
  const queue = new JobQueue({ directory: target, leaseMs: 400, autoStart: false });
  const insert = queue.db.prepare(
    "INSERT INTO jobs(id,type,project_id,request,status,remote_id,created_at,updated_at) VALUES(?,?,?,'{}',?,?,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
  );
  insert.run('11111111-1111-4111-8111-111111111111', 'images', 'p', 'submitting', null);
  insert.run('22222222-2222-4222-8222-222222222222', 'images', 'p', 'running', 'a'.repeat(32));
  queue.lease();
  idle();
} else if (mode === 'sqlite-plain') {
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  idle();
} else {
  throw Error(`Unknown crash-worker mode: ${mode}`);
}
