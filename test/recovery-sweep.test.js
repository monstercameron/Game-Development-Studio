import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { quarantineOrphans, runSweep } from '../runtime/recovery-sweep.js';
import { readRecoveryEvents } from '../runtime/recovery-events.js';

const HOUR = 3600 * 1000;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sweep-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'Alpha');
  await fs.mkdir(path.join(project, 'images'), { recursive: true });
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(
    path.join(project, '.forge-project.json'),
    JSON.stringify({ id: randomUUID(), name: 'Alpha' }),
  );
  return { root, runtime, projects, project };
}

async function age(file, hours) {
  const when = new Date(Date.now() - hours * HOUR);
  await fs.utimes(file, when, when);
}

function openJobs(runtime, ids) {
  const db = new DatabaseSync(path.join(runtime, 'jobs.sqlite'));
  db.exec('CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT)');
  for (const [id, status] of ids) {
    db.prepare('INSERT INTO jobs VALUES (?, ?)').run(id, status);
  }
  db.close();
}

test('stale staging files are deleted, recent and in-use ones are kept, and only names are reported', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  const liveJob = randomUUID();
  const deadJob = randomUUID();
  openJobs(runtime, [
    [liveJob, 'running'],
    [deadJob, 'failed'],
  ]);
  const images = path.join(project, 'images');
  const staleDownload = path.join(images, `.forge-${deadJob}.png.${randomUUID()}.part`);
  const staleIndex = path.join(project, `.forge-assets.json.${randomUUID()}.tmp`);
  const liveDownload = path.join(images, `.forge-${liveJob}.png.${randomUUID()}.part`);
  const recent = path.join(images, `.forge-${randomUUID()}.png.${randomUUID()}.part`);
  const asset = path.join(images, 'forge-final.png');
  for (const file of [staleDownload, staleIndex, liveDownload, recent, asset]) {
    await fs.writeFile(file, 'bytes');
  }
  await age(staleDownload, 30);
  await age(staleIndex, 30);
  await age(liveDownload, 200);
  await age(asset, 500);

  const result = runSweep({ runtimeDirectory: runtime, projectsRoot: projects });
  assert.deepEqual(
    result.deleted.map((item) => item.kind),
    ['stale_staging', 'stale_staging'],
  );
  await assert.rejects(fs.stat(staleDownload), { code: 'ENOENT' });
  await assert.rejects(fs.stat(staleIndex), { code: 'ENOENT' });
  await fs.stat(liveDownload);
  await fs.stat(recent);
  await fs.stat(asset);
  assert.equal(result.skipped, 2);
  assert.ok(
    result.deleted.every((item) => !path.isAbsolute(item.path) && item.project?.name === 'Alpha'),
  );
  assert.ok(
    readRecoveryEvents({ directory: runtime }).some(
      (event) => event.code === 'sweep.staging_deleted',
    ),
  );
});

test('files that need a decision are reported and never deleted, and a dry run deletes nothing', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  openJobs(runtime, []);
  const conflict = path.join(project, 'images', `.forge-${randomUUID()}.png.conflict`);
  const damaged = path.join(project, '.forge-meta.corrupt-20260101.sqlite');
  const stale = path.join(project, 'images', `.${randomUUID()}.tmp`);
  const conversion = path.join(project, 'images', `.forge-convert-${randomUUID()}`);
  await fs.mkdir(conversion);
  await fs.writeFile(path.join(conversion, 'model-converted.glb'), 'x');
  await age(conversion, 100);
  for (const file of [conflict, damaged, stale]) {
    await fs.writeFile(file, 'x');
    await age(file, 100);
  }
  const dry = runSweep({ runtimeDirectory: runtime, projectsRoot: projects, apply: false });
  assert.deepEqual(dry.deleted, []);
  assert.deepEqual(dry.reported.map((item) => item.kind).sort(), [
    'conversion_staging_folder',
    'damaged_database',
    'output_conflict',
    'stale_staging',
  ]);
  await fs.stat(stale);
  const real = runSweep({ runtimeDirectory: runtime, projectsRoot: projects });
  assert.equal(real.deleted.length, 1);
  assert.deepEqual(real.reported.map((item) => item.kind).sort(), [
    'conversion_staging_folder',
    'damaged_database',
    'output_conflict',
  ]);
  await fs.stat(path.join(conversion, 'model-converted.glb'));
  await fs.stat(conflict);
  await fs.stat(damaged);
});

test('when the job table cannot be read nothing that names a job is deleted', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  await fs.writeFile(path.join(runtime, 'jobs.sqlite'), 'not a database'.repeat(50));
  const file = path.join(project, 'images', `.forge-${randomUUID()}.png.${randomUUID()}.part`);
  await fs.writeFile(file, 'x');
  await age(file, 100);
  const result = runSweep({ runtimeDirectory: runtime, projectsRoot: projects });
  assert.equal(result.jobsUnreadable, true);
  assert.deepEqual(result.deleted, []);
  await fs.stat(file);
});

test('project folders without readable metadata and staged imports are reported', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  await fs.mkdir(path.join(projects, 'Broken'));
  await fs.writeFile(path.join(projects, 'Broken', '.forge-project.json'), '{"id":"cut');
  await fs.writeFile(path.join(projects, 'Broken', 'keep.txt'), 'x');
  await fs.mkdir(path.join(projects, 'Empty'));
  await fs.mkdir(path.join(project, '.forge-staging', 'megascans', randomUUID()), {
    recursive: true,
  });
  const result = runSweep({ runtimeDirectory: runtime, projectsRoot: projects });
  assert.deepEqual(
    result.projectProblems.sort((a, b) => (a.folder < b.folder ? -1 : 1)),
    [
      { folder: 'Broken', kind: 'project_metadata_unreadable' },
      { folder: 'Empty', kind: 'project_folder_empty' },
    ],
  );
  assert.equal(result.stagedImports, 1);
});

test('the runtime folder sweep stays at its own staging files', async (t) => {
  const { runtime, projects } = await fixture(t);
  await fs.mkdir(path.join(runtime, 'some-venv', 'Lib'), { recursive: true });
  const foreign = path.join(runtime, 'some-venv', 'Lib', '.cache.tmp');
  const own = path.join(runtime, `.settings.json.${randomUUID()}.tmp`);
  await fs.writeFile(foreign, 'x');
  await fs.writeFile(own, 'x');
  await age(foreign, 100);
  await age(own, 100);
  const result = runSweep({ runtimeDirectory: runtime, projectsRoot: projects });
  assert.equal(result.deleted.length, 1);
  await fs.stat(foreign);
});

test('quarantine moves a reported file into a recoverable folder and resolves paths itself', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  openJobs(runtime, []);
  const conflict = path.join(project, 'images', `.forge-${randomUUID()}.png.conflict`);
  await fs.writeFile(conflict, 'marker');
  await age(conflict, 100);
  const [item] = runSweep({ runtimeDirectory: runtime, projectsRoot: projects }).reported;
  const outcome = quarantineOrphans({
    ids: [item.id, '0123456789abcdef'],
    runtimeDirectory: runtime,
    projectsRoot: projects,
  });
  assert.deepEqual(outcome.moved, [item.id]);
  assert.deepEqual(outcome.missing, ['0123456789abcdef']);
  await assert.rejects(fs.stat(conflict), { code: 'ENOENT' });
  const [stamp] = await fs.readdir(path.join(runtime, 'quarantine'));
  const [moved] = await fs.readdir(path.join(runtime, 'quarantine', stamp));
  assert.equal(await fs.readFile(path.join(runtime, 'quarantine', stamp, moved), 'utf8'), 'marker');
});

test('a file in use by an open job cannot be quarantined by naming its id', async (t) => {
  const { runtime, projects, project } = await fixture(t);
  const job = randomUUID();
  openJobs(runtime, [[job, 'running']]);
  const file = path.join(project, 'images', `.forge-${job}.png.${randomUUID()}.part`);
  await fs.writeFile(file, 'x');
  await age(file, 100);
  // A correctly derived id for a file that an open job is still writing must be refused.
  const guess = createHash('sha1')
    .update(`project|Alpha|images/${path.basename(file)}`)
    .digest('hex')
    .slice(0, 16);
  const outcome = quarantineOrphans({
    ids: [guess],
    runtimeDirectory: runtime,
    projectsRoot: projects,
  });
  assert.deepEqual(outcome.moved, []);
  await fs.stat(file);
});
