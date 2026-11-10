import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { JobQueue, findProject } from '../runtime/jobs.js';

test('project deletion requires its name and no open renders; files can be restored', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-project-trash-'));
  const projects = path.join(root, 'projects');
  const folder = path.join(projects, 'Example');
  const id = randomUUID();
  fs.mkdirSync(path.join(folder, 'images'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.forge-project.json'),
    JSON.stringify({ id, name: 'Example' }),
  );
  fs.writeFileSync(path.join(folder, 'images', 'asset.png'), 'original');
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, autoStart: false });
  t.after(() => {
    queue.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => queue.trashProject(id, 'wrong'), /exact project name/);
  assert.equal(fs.existsSync(folder), true);
  const job = queue.enqueue({ type: 'images', projectId: id, request: { prompt: 'fixture' } });
  assert.throws(() => queue.trashProject(id, 'Example'), /active and waiting renders/);
  assert.equal(fs.readFileSync(path.join(folder, 'images', 'asset.png'), 'utf8'), 'original');
  queue.cancel(job.id);
  const removed = queue.trashProject(id, 'Example');
  assert.equal(fs.existsSync(folder), false);
  assert.throws(() => findProject(id, projects), /not found/);
  assert.equal(queue.listProjectTrash()[0].trashId, removed.trashId);
  const stored = path.join(
    projects,
    '.forge-project-trash',
    removed.trashId,
    'project',
    'images',
    'asset.png',
  );
  assert.equal(fs.readFileSync(stored, 'utf8'), 'original');
  fs.mkdirSync(folder);
  assert.throws(() => queue.restoreProject(removed.trashId), /already in use/);
  fs.rmdirSync(folder);
  assert.equal(queue.restoreProject(removed.trashId).projectId, id);
  assert.equal(fs.readFileSync(path.join(folder, 'images', 'asset.png'), 'utf8'), 'original');
  assert.deepEqual(queue.listProjectTrash(), []);
});

test('invalid trash IDs cannot address files outside project trash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-project-trash-'));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, autoStart: false });
  t.after(() => {
    queue.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => queue.restoreProject('../outside'), /Invalid project trash ID/);
});
