import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';
import { classifyJobForRecovery, inspectFinishedOutput } from '../runtime/job-recovery.js';
import { readRecoveryEvents } from '../runtime/recovery-events.js';
import { startCrashWorker } from './fixtures/start-crash-worker.js';

// The queue state machine after a crash at every job state. The "crashed" runtime is a queue
// that held the lease and is simply abandoned (as a SIGKILL would leave it); a second queue then
// takes over. No engine is contacted and no worker is started.
const LEASE_MS = 60;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-job-crash-'));
  const directory = path.join(root, 'runtime');
  const projects = path.join(root, 'projects');
  const projectId = randomUUID();
  const project = path.join(projects, 'Alpha');
  await fs.mkdir(path.join(project, '3d'), { recursive: true });
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queues = [];
  t.after(async () => {
    for (const queue of queues) {
      if (!queue.stopped) {
        queue.stop();
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const open = () => {
    const queue = new JobQueue({ directory, projects, leaseMs: LEASE_MS, autoStart: false });
    queues.push(queue);
    return queue;
  };
  return { root, directory, projects, project, projectId, open };
}

function insertJob(queue, projectId, values) {
  const id = values.id || randomUUID();
  queue.db
    .prepare(
      `INSERT INTO jobs(id,type,project_id,request,status,remote_id,stage,error,created_at,updated_at,depends_on,queue_rank)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      values.type || 'images',
      projectId,
      JSON.stringify(values.request || {}),
      values.status,
      values.remoteId ?? null,
      values.stage ?? null,
      values.error ?? null,
      values.createdAt || '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      values.dependsOn ?? null,
      values.rank ?? null,
    );
  return id;
}

const REMOTE = 'a'.repeat(32);

test('every job state survives a runtime crash without losing work or repeating a submission', async (t) => {
  const { directory, projectId, open } = await fixture(t);
  const crashed = open();
  assert.equal(crashed.lease(), true);
  const ids = {};
  for (const [name, values] of Object.entries({
    queued: { status: 'queued', rank: 5 },
    waitingEngine: { status: 'waiting_engine', rank: 4 },
    waitingMemory: { status: 'waiting_memory', rank: 3 },
    preparing: { status: 'preparing', rank: 2 },
    submitting: { status: 'submitting', rank: 1 },
    running: { status: 'running', remoteId: REMOTE, rank: 0.5 },
    finalizing: { status: 'finalizing', remoteId: REMOTE, rank: 0.25 },
    interrupted: { status: 'interrupted', error: 'earlier', rank: 6 },
    needsAttention: { status: 'needs_attention', rank: 7 },
    completed: { status: 'completed', remoteId: REMOTE, rank: 8 },
  })) {
    ids[name] = insertJob(crashed, projectId, values);
  }
  const before = Object.fromEntries(
    Object.entries(ids).map(([name, id]) => [name, crashed.get(id)]),
  );
  const orderBefore = crashed.list().map((job) => job.id);

  // The runtime is gone without releasing anything. Its lease runs out.
  await wait(LEASE_MS + 40);
  const replacement = open();
  assert.equal(replacement.lease(), true);
  const after = Object.fromEntries(
    Object.entries(ids).map(([name, id]) => [name, replacement.get(id)]),
  );

  // A submission that may have reached an engine is interrupted, with a precise reason.
  assert.equal(after.submitting.status, 'interrupted');
  assert.match(after.submitting.error, /may have reached the engine/);
  assert.equal(after.submitting.remoteId, null, 'no remote id is invented');
  // A job that was only being prepared goes back to checking the engine.
  assert.equal(after.preparing.status, 'waiting_engine');
  assert.match(after.preparing.stage, /Rechecking the engine/);
  // Everything else is exactly as it was: nothing is resubmitted, completed or failed.
  for (const name of [
    'queued',
    'waitingEngine',
    'waitingMemory',
    'running',
    'finalizing',
    'interrupted',
    'needsAttention',
    'completed',
  ]) {
    assert.equal(after[name].status, before[name].status, name);
    assert.equal(after[name].remoteId, before[name].remoteId, name);
  }
  // The queue order, including manual reordering, is unchanged.
  assert.deepEqual(
    replacement.list().map((job) => job.id),
    orderBefore,
  );

  const events = readRecoveryEvents({ directory });
  assert.ok(
    events.some((event) => event.code === 'job.interrupted' && event.id === ids.submitting),
  );
  assert.ok(events.some((event) => event.code === 'job.rechecked' && event.id === ids.preparing));
});

test('an interrupted job at the head of the queue holds everything behind it', async (t) => {
  const { projectId, open } = await fixture(t);
  const queue = open();
  const first = insertJob(queue, projectId, { status: 'interrupted', rank: 1 });
  const second = insertJob(queue, projectId, { status: 'queued', rank: 2 });
  await queue.tick();
  assert.equal(queue.active, null, 'no worker was started');
  assert.equal(queue.get(first).status, 'interrupted');
  assert.equal(queue.get(second).status, 'queued');
});

test('a chained render waits behind an interrupted parent and fails if its parent failed in the crash', async (t) => {
  const { projectId, open } = await fixture(t);
  const queue = open();
  const waitingParent = insertJob(queue, projectId, {
    status: 'interrupted',
    rank: 1,
    type: 'images',
  });
  const waitingChild = insertJob(queue, projectId, {
    status: 'queued',
    rank: 2,
    type: '3d',
    dependsOn: waitingParent,
    request: { referenceFrom: { jobId: waitingParent } },
  });
  await queue.tick();
  assert.equal(
    queue.get(waitingChild).status,
    'queued',
    'it keeps waiting for the interrupted job',
  );

  const failedParent = insertJob(queue, projectId, { status: 'failed', rank: 0, type: 'images' });
  const orphanChild = insertJob(queue, projectId, {
    status: 'queued',
    rank: 0.5,
    type: '3d',
    dependsOn: failedParent,
    request: { referenceFrom: { jobId: failedParent } },
  });
  await queue.tick();
  const child = queue.get(orphanChild);
  assert.equal(child.status, 'failed');
  assert.match(child.error, /depends on failed/);
});

test('a finalizing job whose output was saved whole is completed, by signature and without an engine', async (t) => {
  const { project, projectId, open } = await fixture(t);
  const queue = open();
  const id = randomUUID();
  insertJob(queue, projectId, { id, type: '3d', status: 'finalizing', remoteId: REMOTE, rank: 1 });
  const glb = Buffer.alloc(64);
  glb.write('glTF', 0, 'latin1');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(64, 8);
  await fs.writeFile(path.join(project, '3d', `forge-${id}.glb`), glb);

  await queue.tick();
  const job = queue.get(id);
  assert.equal(job.status, 'completed');
  assert.equal(job.output, `3d/forge-${id}.glb`);
  assert.match(job.stage, /verified after a restart/);
  assert.equal(queue.active, null, 'no worker or engine was needed');
  assert.ok(
    readRecoveryEvents({ directory: queue.directory }).some(
      (event) => event.code === 'job.completed_from_output' && event.id === id,
    ),
  );
});

test('a finalizing job with a truncated or missing output is not completed', async (t) => {
  const { project, projectId, open } = await fixture(t);
  const queue = open();
  const truncated = randomUUID();
  const missing = randomUUID();
  insertJob(queue, projectId, {
    id: truncated,
    type: '3d',
    status: 'finalizing',
    remoteId: REMOTE,
  });
  insertJob(queue, projectId, { id: missing, type: '3d', status: 'finalizing', remoteId: REMOTE });
  const glb = Buffer.alloc(64);
  glb.write('glTF', 0, 'latin1');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(64, 8);
  await fs.writeFile(path.join(project, '3d', `forge-${truncated}.glb`), glb.subarray(0, 30));
  const token = { owner: queue.owner, epoch: queue.epoch };
  assert.equal(queue.lease(), true);
  for (const id of [truncated, missing]) {
    assert.equal(await queue.completeFromSavedOutput(queue.get(id), token), false);
    assert.equal(queue.get(id).status, 'finalizing');
  }
  const folder = path.join(project);
  assert.equal((await inspectFinishedOutput(queue.get(truncated), folder)).state, 'invalid');
  assert.equal((await inspectFinishedOutput(queue.get(missing), folder)).state, 'missing');
  assert.ok(
    readRecoveryEvents({ directory: queue.directory }).some(
      (event) => event.code === 'job.output_damaged' && event.id === truncated,
    ),
  );
});

test('a runtime killed with a submission in flight leaves it interrupted, not retried', async (t) => {
  const { directory, open } = await fixture(t);
  const { child, ready } = startCrashWorker(t, 'queue', directory);
  await ready;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  await wait(500);
  const replacement = open();
  assert.equal(replacement.lease(), true);
  assert.equal(replacement.get('11111111-1111-4111-8111-111111111111').status, 'interrupted');
  const running = replacement.get('22222222-2222-4222-8222-222222222222');
  assert.equal(running.status, 'running');
  assert.equal(running.remoteId, REMOTE);
});

test('a suspend resume interrupts only a submission in flight', async (t) => {
  const { projectId, open } = await fixture(t);
  const queue = open();
  assert.equal(queue.lease(), true);
  const submitting = insertJob(queue, projectId, { status: 'submitting', rank: 1 });
  const running = insertJob(queue, projectId, { status: 'running', remoteId: REMOTE, rank: 2 });
  const queued = insertJob(queue, projectId, { status: 'queued', rank: 3 });
  const rows = queue.handleResume(45_000);
  assert.deepEqual(
    rows.map((row) => row.id),
    [submitting],
  );
  assert.equal(queue.get(submitting).status, 'interrupted');
  assert.match(queue.get(submitting).error, /suspended/);
  assert.equal(queue.get(running).status, 'running');
  assert.equal(queue.get(queued).status, 'queued');
  assert.ok(
    readRecoveryEvents({ directory: queue.directory }).some(
      (event) => event.code === 'power.resumed',
    ),
  );
});

test('only provably safe jobs are classed as safe to retry', () => {
  const classify = (job) => classifyJobForRecovery({ id: 'x', ...job });
  assert.equal(
    classify({ type: 'images', status: 'interrupted', remoteId: null }).safeToRetry,
    false,
  );
  assert.equal(
    classify({ type: 'images', status: 'interrupted', remoteId: REMOTE }).safeToRetry,
    false,
  );
  assert.equal(
    classify({ type: 'images', status: 'interrupted', remoteId: null }).kind,
    'unknown_outcome',
  );
  assert.equal(
    classify({ type: '3d', status: 'needs_attention', remoteId: null }).safeToRetry,
    true,
  );
  assert.equal(
    classify({ type: '3d', status: 'needs_attention', remoteId: REMOTE }).safeToRetry,
    false,
  );
  assert.equal(classify({ type: 'sfx', status: 'failed', remoteId: null }).safeToRetry, true);
  assert.equal(classify({ type: 'sfx', status: 'failed', remoteId: REMOTE }).safeToRetry, false);
  // Vegetation is deterministic and has no remote job.
  assert.equal(classify({ type: 'vegetation', status: 'interrupted' }).safeToRetry, true);
  assert.equal(
    classify({ type: 'images', status: 'running', remoteId: REMOTE }).kind,
    'continuing',
  );
});
