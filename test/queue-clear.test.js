import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';

test('bulk clear requires confirmation and cancels only waiting jobs without remote work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-clear-'));
  const queue = new JobQueue({ directory: dir, projects: dir, autoStart: false });
  try {
    const insert = queue.db.prepare(
      'INSERT INTO jobs(id,type,project_id,request,status,remote_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    );
    for (const [id, status, remote] of [
      ['q', 'queued', null],
      ['w', 'waiting_memory', null],
      ['r', 'running', 'remote'],
      ['u', 'needs_attention', null],
      ['x', 'waiting_engine', 'remote'],
    ]) {
      insert.run(id, 'images', 'project', '{}', status, remote, '2026-01-01', '2026-01-01');
    }
    assert.throws(() => queue.clearWaiting(''), /confirm/i);
    assert.equal(queue.get('q').status, 'queued');
    assert.equal(queue.clearWaiting('cancel-waiting-renders').cancelled, 2);
    assert.equal(queue.get('q').status, 'cancelled');
    assert.equal(queue.get('w').status, 'cancelled');
    assert.equal(queue.get('r').status, 'running');
    assert.equal(queue.get('u').status, 'needs_attention');
    assert.equal(queue.get('x').status, 'waiting_engine');
  } finally {
    queue.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
