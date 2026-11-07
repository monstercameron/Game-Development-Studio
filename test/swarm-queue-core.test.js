import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';

function createQueue(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-queue-core-'));
  const queue = new JobQueue({ directory, projects: directory, autoStart: false });
  t.after(() => {
    queue.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return queue;
}

function insertJob(queue, { id, status, remoteId = null }) {
  const now = new Date().toISOString();
  queue.db
    .prepare(
      'INSERT INTO jobs(id,type,project_id,request,status,remote_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(id, 'images', 'project', '{}', status, remoteId, now, now);
}

test('cancel does not hide a known remote job as cancelled', (t) => {
  const queue = createQueue(t);
  insertJob(queue, { id: 'remote', status: 'needs_attention', remoteId: 'engine-42' });

  assert.throws(() => queue.cancel('remote'), /only queued jobs/i);
  assert.equal(queue.get('remote').status, 'needs_attention');
});

test('engine suspension is fenced while the scheduler is checking jobs', (t) => {
  const queue = createQueue(t);
  assert.equal(queue.lease(), true);
  queue.polling = true;

  assert.throws(() => queue.suspend('images'), /current queue check/i);
  assert.equal(queue.suspendedEngines.has('images'), false);

  // The queue's own guarded memory recovery must still reserve its target engine.
  assert.doesNotThrow(() => queue.suspend('images', true));
  assert.equal(queue.suspendedEngines.has('images'), true);
});
