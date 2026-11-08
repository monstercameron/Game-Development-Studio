import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DB_NAME,
  readAssetMeta,
  recordJobOutput,
  resetBackfillCache,
} from '../runtime/asset-metadata.js';
import { backupTargets, createBackupManager } from '../runtime/backup-manager.js';
import {
  listBackups,
  projectBackupDirectory,
  resetDatabaseChecksForTests,
} from '../runtime/durable-db.js';
import { readRecoveryEvents } from '../runtime/recovery-events.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-backup-manager-'));
  const runtime = path.join(root, 'runtime');
  const projects = path.join(root, 'projects');
  await fs.mkdir(path.join(projects, 'Alpha'), { recursive: true });
  await fs.mkdir(path.join(runtime, 'credentials'), { recursive: true });
  const previous = process.env.FORGE_RUNTIME_DIR;
  process.env.FORGE_RUNTIME_DIR = runtime;
  resetDatabaseChecksForTests();
  resetBackfillCache();
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.FORGE_RUNTIME_DIR;
    } else {
      process.env.FORGE_RUNTIME_DIR = previous;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runtime, projects, project: path.join(projects, 'Alpha') };
}

function makeDb(file, rows = ['one']) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  for (const value of rows) {
    db.prepare('INSERT INTO t VALUES (?)').run(value);
  }
  db.close();
}

test('backup targets are the irreplaceable databases and every project database', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  makeDb(path.join(project, DB_NAME));
  await fs.mkdir(path.join(projects, 'Plain'));
  const names = backupTargets({ runtimeDirectory: runtime, projectsRoot: projects }).map((target) =>
    target.name.replace(/-[0-9a-f]{8}$/, ''),
  );
  assert.deepEqual(names, ['jobs', 'settings', 'i18n', 'keys', 'megascans', 'project-Alpha']);
});

test('a run backs up what exists, skips what is missing and unchanged, and reports no failure', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  makeDb(path.join(runtime, 'jobs.sqlite'));
  makeDb(path.join(project, DB_NAME));
  const manager = createBackupManager({ runtimeDirectory: runtime, projectsRoot: projects });
  const first = await manager.runOnce();
  const status = Object.fromEntries(
    first.map((result) => [result.name.replace(/-[0-9a-f]{8}$/, ''), result.status]),
  );
  assert.deepEqual(status, {
    jobs: 'created',
    settings: 'skipped',
    i18n: 'skipped',
    keys: 'skipped',
    megascans: 'skipped',
    'project-Alpha': 'created',
  });
  const second = await manager.runOnce();
  assert.equal(second.find((result) => result.name === 'jobs').status, 'unchanged');
  assert.deepEqual(
    readRecoveryEvents({ directory: runtime }).filter(
      (event) => event.code === 'database.backup_failed',
    ),
    [],
  );
});

test('a damaged project database is restored from its backup the next time it is opened', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  const id = randomUUID();
  const output = `sfx/forge-${id}.wav`;
  const record = {
    id,
    type: 'sfx',
    projectId: randomUUID(),
    status: 'completed',
    request: { prompt: 'click', duration: 1, steps: 8, seed: 1 },
    output,
    startedAt: '2026-11-07T10:00:00.000Z',
    finishedAt: '2026-11-07T10:00:42.000Z',
  };
  assert.equal(recordJobOutput(record, project), true);
  assert.equal(readAssetMeta(project, output).prompt.text, 'click');

  const manager = createBackupManager({ runtimeDirectory: runtime, projectsRoot: projects });
  await manager.runOnce();
  assert.equal(listBackups(projectBackupDirectory(project, runtime)).length, 1);

  // A torn write: the file keeps its size but the pages after the header are zeros.
  const file = path.join(project, DB_NAME);
  const bytes = await fs.readFile(file);
  bytes.fill(0, 100);
  await fs.writeFile(file, bytes);
  resetDatabaseChecksForTests();
  assert.equal(readAssetMeta(project, output).prompt.text, 'click', 'the backup was restored');
  const events = readRecoveryEvents({ directory: runtime }).map((event) => event.code);
  assert.ok(events.includes('database.quarantined'));
  assert.ok(events.includes('database.restored'));
  const names = await fs.readdir(project);
  assert.ok(
    names.some((name) => name.startsWith('.forge-meta.corrupt-')),
    'the damaged file is kept',
  );
});
