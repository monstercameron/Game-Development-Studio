import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JobQueue } from '../runtime/jobs.js';
import {
  MIN_RANK_GAP,
  QueueMoveError,
  moveQueuedJob,
  parseMoveRequest,
  planMove,
  ranksBetween,
  waitingOrder,
} from '../runtime/queue-order.js';
import { forecastQueue } from '../runtime/queue-timing.js';

// Reordering the waiting part of the durable queue. Everything runs on temporary state with
// autoStart off, so no engine, model or GPU is used; every engine URL points at a closed port.
for (const name of [
  'FORGE_MUSIC_URL',
  'FORGE_SFX_URL',
  'FORGE_TTS_URL',
  'FORGE_HUNYUAN_URL',
  'FORGE_TRELLIS_URL',
  'FORGE_SAM31_URL',
  'FORGE_IMAGE_URL',
  'FORGE_VIDEO_URL',
]) {
  process.env[name] = 'http://127.0.0.1:1';
}

const WAITING = ['queued', 'waiting_engine', 'waiting_memory'];

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-move-'));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Game'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Game', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  const state = path.join(dir, 'state');
  const opened = [];
  const records = [];
  const open = (options = {}) => {
    const next = new JobQueue({
      directory: state,
      projects,
      autoStart: false,
      onQueueLog: (record) => records.push(record),
      ...options,
    });
    opened.push(next);
    return next;
  };
  const queue = open();
  t.after(async () => {
    for (const item of opened) {
      try {
        item.stop();
      } catch {
        // A test may already have stopped this queue to simulate a restart.
      }
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, projects, projectId, queue, open, state, records };
}

const sfx = (projectId, prompt) => ({ type: 'sfx', projectId, request: { prompt } });
const segmentation = (projectId, extra = {}) => ({
  type: 'segmentation',
  projectId,
  request: { prompt: 'the dragon', references: [`${randomUUID()}.png`], ...extra },
});
const model3d = (projectId, from) => ({
  type: '3d',
  projectId,
  request: { references: [], referenceFrom: from },
});

function addJobs(queue, projectId, count) {
  return Array.from({ length: count }, (_, index) =>
    queue.enqueue(sfx(projectId, `render ${index + 1}`)),
  );
}

// Ids of the waiting renders in the order the scheduler will take them.
const waitingIds = (queue) =>
  queue
    .list()
    .filter((job) => WAITING.includes(job.status) && !job.remoteId)
    .map((job) => job.id);
const names = (queue, ids) => ids.map((id) => queue.get(id).request.prompt);
const storedRanks = (queue) =>
  Object.fromEntries(
    queue.db
      .prepare('SELECT id,queue_rank FROM jobs')
      .all()
      .map((row) => [row.id, row.queue_rank]),
  );
const refused = (status, code) => (error) =>
  error instanceof QueueMoveError && error.status === status && error.code === code;

test('new renders append with an increasing rank and the list is in rank order', async (t) => {
  const { queue, projectId } = await setup(t);
  const jobs = addJobs(queue, projectId, 4);
  assert.deepEqual(
    waitingIds(queue),
    jobs.map((job) => job.id),
  );
  const ranks = jobs.map((job) => queue.get(job.id).queueRank);
  assert.ok(ranks.every((rank) => Number.isFinite(rank)));
  assert.deepEqual(
    [...ranks].sort((a, b) => a - b),
    ranks,
  );
  assert.equal(new Set(ranks).size, 4);
  // The same rows when read as the studio reads them.
  assert.deepEqual(
    queue.list().map((job) => job.queueRank),
    ranks,
  );
});

test('equal ranks fall back to creation time, then insertion order', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b, c] = addJobs(queue, projectId, 3);
  const set = queue.db.prepare('UPDATE jobs SET queue_rank=7,created_at=? WHERE id=?');
  set.run('2026-01-02T00:00:00.000Z', a.id);
  set.run('2026-01-01T00:00:00.000Z', b.id);
  set.run('2026-01-01T00:00:00.000Z', c.id);
  assert.deepEqual(waitingIds(queue), [b.id, c.id, a.id]);
});

test('rows from before ranks existed keep their order and join the new numbering', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b, c] = addJobs(queue, projectId, 3);
  queue.db.exec('UPDATE jobs SET queue_rank=NULL');
  assert.deepEqual(waitingIds(queue), [a.id, b.id, c.id], 'created order');
  const d = queue.enqueue(sfx(projectId, 'newer'));
  assert.deepEqual(waitingIds(queue), [a.id, b.id, c.id, d.id], 'a new render is last');
  const result = queue.move(c.id, { to: 'top' });
  assert.deepEqual(result.waiting.order, [c.id, a.id, b.id, d.id]);
  const ranks = storedRanks(queue);
  assert.ok(Number.isFinite(ranks[c.id]));
  assert.equal(ranks[a.id], null, 'untouched legacy rows are not rewritten');
  assert.equal(ranks[b.id], null);
  assert.deepEqual(result.waiting.ranks[a.id], null);
});

test('a database from before ranks gains the column, keeps its order and appends', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-move-legacy-'));
  let queue = null;
  t.after(async () => {
    queue?.stop();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const legacy = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
  legacy.exec(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, stage TEXT, error TEXT, output TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  );
  const projectId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  ids.forEach((id, index) =>
    legacy
      .prepare(
        "INSERT INTO jobs(id,type,project_id,request,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
      )
      .run(id, 'sfx', projectId, '{"prompt":"old"}', `2026-01-0${index + 1}`, '2026-01-01'),
  );
  legacy.close();
  queue = new JobQueue({ directory: dir, projects: dir, autoStart: false });
  assert.ok(
    queue.db
      .prepare('PRAGMA table_info(jobs)')
      .all()
      .some((column) => column.name === 'queue_rank'),
  );
  assert.deepEqual(
    queue.list().map((job) => job.id),
    ids,
  );
  assert.ok(queue.list().every((job) => job.queueRank === null));
  const moved = queue.move(ids[2], { to: 'next' });
  assert.deepEqual(moved.waiting.order, [ids[2], ids[0], ids[1]]);
});

test('every way of naming a place moves the render there', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b, c, d, e] = addJobs(queue, projectId, 5);
  const move = (job, body) => queue.move(job.id, body);
  const order = () => names(queue, waitingIds(queue)).join(' ');

  const next = move(e, { to: 'next' });
  assert.equal(order(), 'render 5 render 1 render 2 render 3 render 4');
  assert.equal(next.moved, true);
  assert.equal(next.to, 1);
  assert.equal(next.count, 5);
  move(e, { to: 'end' });
  assert.equal(order(), 'render 1 render 2 render 3 render 4 render 5');
  move(d, { to: 'top' });
  assert.equal(order(), 'render 4 render 1 render 2 render 3 render 5');
  move(d, { before: c.id });
  assert.equal(order(), 'render 1 render 2 render 4 render 3 render 5');
  move(a, { after: c.id });
  assert.equal(order(), 'render 2 render 4 render 3 render 1 render 5');
  move(a, { direction: 'up' });
  assert.equal(order(), 'render 2 render 4 render 1 render 3 render 5');
  move(b, { direction: 'down' });
  assert.equal(order(), 'render 4 render 2 render 1 render 3 render 5');
  assert.deepEqual(waitingOrder(queue.db).order, waitingIds(queue));
});

test('a move that changes nothing reports it and writes nothing', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b, c] = addJobs(queue, projectId, 3);
  const before = storedRanks(queue);
  for (const [job, body] of [
    [a, { to: 'top' }],
    [a, { direction: 'up' }],
    [c, { to: 'end' }],
    [c, { direction: 'down' }],
    [b, { before: c.id }],
    [b, { after: a.id }],
  ]) {
    const result = queue.move(job.id, body);
    assert.equal(result.moved, false, JSON.stringify(body));
  }
  assert.deepEqual(storedRanks(queue), before);
  assert.deepEqual(waitingIds(queue), [a.id, b.id, c.id]);
});

test('a move rewrites one rank and leaves every other row alone', async (t) => {
  const { queue, projectId } = await setup(t);
  const jobs = addJobs(queue, projectId, 6);
  const before = storedRanks(queue);
  const result = queue.move(jobs[5].id, { before: jobs[2].id });
  const after = storedRanks(queue);
  const changed = Object.keys(after).filter((id) => after[id] !== before[id]);
  assert.deepEqual(changed, [jobs[5].id]);
  assert.equal(result.renumbered, false);
  assert.ok(after[jobs[5].id] > before[jobs[1].id] && after[jobs[5].id] < before[jobs[2].id]);
});

test('many moves into the same gap renumber once and keep the order', async (t) => {
  const { queue, projectId } = await setup(t);
  const jobs = addJobs(queue, projectId, 4);
  let renumbered = 0;
  // Keep dropping the last render between the first two: the gap halves every time.
  for (let round = 0; round < 80; round += 1) {
    const result = queue.move(jobs[3 - (round % 2)].id, { after: jobs[0].id });
    renumbered += result.renumbered ? 1 : 0;
  }
  assert.ok(renumbered >= 1, 'the gap was exhausted at least once');
  const ranks = waitingIds(queue).map((id) => queue.get(id).queueRank);
  assert.deepEqual(
    [...ranks].sort((x, y) => x - y),
    ranks,
  );
  assert.equal(new Set(ranks).size, ranks.length);
  assert.ok(ranks.every((rank, index) => index === 0 || rank - ranks[index - 1] >= MIN_RANK_GAP));
  assert.equal(waitingIds(queue)[0], jobs[0].id);
});

test('ranksBetween spreads ranks inside a gap and refuses one that is too small', () => {
  assert.deepEqual(ranksBetween(undefined, undefined, 2), [1024, 2048]);
  assert.deepEqual(ranksBetween(10, undefined, 2), [11, 12]);
  assert.deepEqual(ranksBetween(undefined, 10, 2), [8, 9]);
  assert.deepEqual(ranksBetween(0, 3, 2), [1, 2]);
  assert.equal(ranksBetween(1, 1, 1), null);
  assert.equal(ranksBetween(1, 1 + MIN_RANK_GAP / 4, 1), null);
});

test('only waiting renders without an engine job can be moved', async (t) => {
  const { queue, projectId } = await setup(t);
  const [mover, other] = addJobs(queue, projectId, 2);
  const states = {
    running: "status='running',remote_id='engine-1'",
    preparing: "status='preparing'",
    submitting: "status='submitting'",
    finalizing: "status='finalizing',remote_id='engine-1'",
    interrupted: "status='interrupted'",
    needs_attention: "status='needs_attention'",
    failed: "status='failed'",
    cancelled: "status='cancelled'",
    completed: "status='completed'",
    'waiting with an engine job': "status='waiting_engine',remote_id='engine-1'",
  };
  for (const [label, assignment] of Object.entries(states)) {
    queue.db.exec(`UPDATE jobs SET ${assignment} WHERE id='${mover.id}'`);
    assert.throws(() => queue.move(mover.id, { to: 'end' }), refused(409, 'not_movable'), label);
    queue.db.exec(`UPDATE jobs SET status='queued',remote_id=NULL WHERE id='${mover.id}'`);
  }
  assert.throws(() => queue.move(randomUUID(), { to: 'end' }), refused(404, 'not_found'));
  // Waiting renders in the other waiting states move fine.
  for (const status of ['waiting_engine', 'waiting_memory']) {
    queue.db.exec(`UPDATE jobs SET status='${status}' WHERE id='${mover.id}'`);
    assert.equal(queue.move(mover.id, { to: 'end' }).moved, true, status);
    queue.move(mover.id, { to: 'top' });
  }
  // A render that cannot move cannot be used as the place to move next to either.
  queue.db.exec(`UPDATE jobs SET status='running',remote_id='engine-1' WHERE id='${other.id}'`);
  assert.throws(
    () => queue.move(mover.id, { before: other.id }),
    refused(409, 'anchor_not_movable'),
  );
  assert.throws(
    () => queue.move(mover.id, { after: randomUUID() }),
    refused(404, 'anchor_not_found'),
  );
  assert.throws(() => queue.move(mover.id, { after: mover.id }), refused(400, 'invalid_request'));
});

test('running, interrupted and attention renders keep their place ahead of the waiting line', async (t) => {
  const { queue, projectId } = await setup(t);
  const [run, blocked, a, b, c] = addJobs(queue, projectId, 5);
  queue.db.exec(`UPDATE jobs SET status='running',remote_id='e' WHERE id='${run.id}'`);
  queue.db.exec(`UPDATE jobs SET status='needs_attention' WHERE id='${blocked.id}'`);
  assert.deepEqual(
    queue
      .list()
      .map((job) => job.id)
      .slice(0, 2),
    [run.id, blocked.id],
  );
  const result = queue.move(c.id, { to: 'top' });
  assert.deepEqual(result.waiting.order, [c.id, a.id, b.id]);
  // The scheduler still sees the running job first and the blocked one second.
  const head = queue.db
    .prepare(
      "SELECT id FROM jobs WHERE status IN ('queued','running','needs_attention') ORDER BY COALESCE(queue_rank,rowid),created_at,rowid",
    )
    .all()
    .map((row) => row.id);
  assert.deepEqual(head, [run.id, blocked.id, c.id, a.id, b.id]);
  assert.equal(queue.get(run.id).status, 'running');
  assert.equal(queue.get(run.id).remoteId, 'e');
  assert.equal(queue.get(run.id).queueRank, storedRanks(queue)[run.id]);
});

test('a chained render stays behind its source, and moving a source carries what waits for it', async (t) => {
  const { queue, projectId } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  const [x, y] = addJobs(queue, projectId, 2);

  const early = queue.move(child.id, { to: 'top' });
  assert.equal(early.moved, false);
  assert.equal(early.clamped, parent.id);
  assert.match(early.note, /placed right after/);
  assert.deepEqual(waitingIds(queue), [parent.id, child.id, x.id, y.id]);

  queue.move(x.id, { to: 'top' });
  const stillBehind = queue.move(child.id, { before: x.id });
  assert.equal(stillBehind.moved, false);
  assert.deepEqual(waitingIds(queue), [x.id, parent.id, child.id, y.id]);
  assert.equal(queue.move(child.id, { direction: 'up' }).moved, false);

  const later = queue.move(parent.id, { to: 'end' });
  assert.deepEqual(later.carried, [child.id]);
  assert.match(later.note, /moved with it/);
  assert.deepEqual(waitingIds(queue), [x.id, y.id, parent.id, child.id]);

  // Moving the source forward leaves the render that waits for it where it was.
  queue.move(parent.id, { to: 'top' });
  assert.deepEqual(waitingIds(queue), [parent.id, x.id, y.id, child.id]);

  // Moving the dependent later is an ordinary move.
  const down = queue.move(child.id, { direction: 'up' });
  assert.equal(down.moved, true);
  assert.deepEqual(waitingIds(queue), [parent.id, x.id, child.id, y.id]);
  assert.equal(queue.move(child.id, { after: y.id }).moved, true);
  assert.deepEqual(waitingIds(queue), [parent.id, x.id, y.id, child.id]);
});

test('a chain of three keeps its order when the first render moves', async (t) => {
  const { queue, projectId } = await setup(t);
  const [image, cutout, shape] = queue.enqueueChain([
    { type: 'images', projectId, request: { prompt: 'a barrel', width: 512, height: 512 } },
    {
      type: 'segmentation',
      projectId,
      request: { prompt: 'barrel', references: [], referenceFrom: { step: 0 } },
    },
    { type: '3d', projectId, request: { references: [], referenceFrom: { step: 1 } } },
  ]);
  const [other] = addJobs(queue, projectId, 1);
  const result = queue.move(image.id, { after: other.id });
  assert.deepEqual(result.carried, [cutout.id, shape.id]);
  assert.deepEqual(waitingIds(queue), [other.id, image.id, cutout.id, shape.id]);
  // The last render cannot jump over the one it is built from.
  assert.equal(queue.move(shape.id, { to: 'top' }).moved, false);
  assert.deepEqual(waitingIds(queue), [other.id, image.id, cutout.id, shape.id]);
});

test('variation siblings move one at a time', async (t) => {
  const { queue, projectId } = await setup(t);
  const seeds = [1, 2, 3].map((seed) =>
    queue.enqueue({
      type: 'images',
      projectId,
      request: { prompt: 'a fox', width: 512, height: 512, seed },
    }),
  );
  queue.move(seeds[2].id, { before: seeds[1].id });
  assert.deepEqual(waitingIds(queue), [seeds[0].id, seeds[2].id, seeds[1].id]);
});

test('a stale expectedRank is refused with the fresh order and writes nothing', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b, c] = addJobs(queue, projectId, 3);
  const seenRank = queue.get(c.id).queueRank;
  queue.move(c.id, { to: 'top' });
  const before = storedRanks(queue);
  assert.throws(
    () => queue.move(c.id, { to: 'end', expectedRank: seenRank }),
    (error) =>
      refused(409, 'stale')(error) &&
      JSON.stringify(error.extra.order) === JSON.stringify([c.id, a.id, b.id]) &&
      error.extra.ranks[c.id] === queue.get(c.id).queueRank,
  );
  assert.deepEqual(storedRanks(queue), before);
  // The current rank is accepted.
  assert.equal(
    queue.move(c.id, { to: 'end', expectedRank: queue.get(c.id).queueRank }).moved,
    true,
  );
  // A legacy row is identified by a null rank until its first move.
  queue.db.exec('UPDATE jobs SET queue_rank=NULL');
  assert.throws(() => queue.move(a.id, { to: 'end', expectedRank: 5 }), refused(409, 'stale'));
  assert.equal(queue.move(a.id, { to: 'end', expectedRank: null }).moved, true);
  assert.throws(() => queue.move(a.id, { to: 'top', expectedRank: null }), refused(409, 'stale'));
  // The anchor can be checked too.
  const anchorRank = queue.get(b.id).queueRank;
  queue.move(b.id, { to: 'end' });
  assert.throws(
    () => queue.move(c.id, { after: b.id, expectedAnchorRank: anchorRank }),
    refused(409, 'stale'),
  );
});

test('two connections racing to move the same render cannot corrupt the order', async (t) => {
  const { queue, open, projectId } = await setup(t);
  const [a, b, c, d] = addJobs(queue, projectId, 4);
  const other = open();
  const seen = queue.get(d.id).queueRank;
  const first = queue.move(d.id, { to: 'top', expectedRank: seen });
  assert.equal(first.moved, true);
  // The second tab still holds the rank it saw before the first move.
  assert.throws(() => other.move(d.id, { after: b.id, expectedRank: seen }), refused(409, 'stale'));
  assert.deepEqual(waitingIds(other), [d.id, a.id, b.id, c.id]);
  // A different render moved from the second connection still works and sees both changes.
  other.move(a.id, { to: 'end' });
  assert.deepEqual(waitingIds(queue), [d.id, b.id, c.id, a.id]);
  const ranks = waitingIds(queue).map((id) => queue.get(id).queueRank);
  assert.equal(new Set(ranks).size, 4);
});

test('a conflicting write is rolled back in full', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b] = addJobs(queue, projectId, 2);
  // Make the final write find the row claimed: the whole move must roll back.
  const original = queue.db.prepare.bind(queue.db);
  let armed = true;
  queue.db.prepare = (sql) => {
    if (armed && sql.startsWith('UPDATE jobs SET queue_rank=?')) {
      armed = false;
      queue.db.exec(`UPDATE jobs SET status='preparing' WHERE id='${b.id}'`);
    }
    return original(sql);
  };
  const before = storedRanks(queue);
  assert.throws(() => moveQueuedJob(queue.db, b.id, { kind: 'to', value: 'top' }), QueueMoveError);
  queue.db.prepare = original;
  assert.equal(queue.get(b.id).status, 'queued', 'the transaction was rolled back');
  assert.deepEqual(storedRanks(queue), before);
  assert.deepEqual(waitingIds(queue), [a.id, b.id]);
});

test('the order survives a restart', async (t) => {
  const { queue, open, projectId } = await setup(t);
  const jobs = addJobs(queue, projectId, 4);
  queue.move(jobs[3].id, { to: 'top' });
  queue.move(jobs[0].id, { after: jobs[2].id });
  const expected = waitingIds(queue);
  queue.stop();
  const reopened = open();
  assert.deepEqual(waitingIds(reopened), expected);
  const appended = reopened.enqueue(sfx(projectId, 'after restart'));
  assert.equal(waitingIds(reopened).at(-1), appended.id);
});

test('moving is logged as a queue_move record without request data', async (t) => {
  const { queue, projectId, records } = await setup(t);
  const [a, b] = addJobs(queue, projectId, 2);
  records.length = 0;
  queue.move(b.id, { to: 'top' });
  queue.move(b.id, { to: 'top' });
  assert.deepEqual(records, [
    { event: 'queue_move', type: 'sfx', status: 'queued', jobId: b.id, position: 1, count: 2 },
  ]);
  assert.ok(a);
});

test('the forecast follows the new order', async (t) => {
  const { queue, projectId } = await setup(t);
  const [a, b, c] = addJobs(queue, projectId, 3);
  const estimates = Object.fromEntries(
    [a, b, c].map((job, index) => [
      job.id,
      { available: true, typicalSeconds: (index + 1) * 10, confidence: 'exact' },
    ]),
  );
  const waits = () => {
    const forecast = forecastQueue(queue.list(), estimates, Date.now());
    return [a, b, c].map((job) => forecast.perJob[job.id].waitSeconds);
  };
  assert.deepEqual(waits(), [0, 10, 30]);
  queue.move(c.id, { to: 'top' });
  assert.deepEqual(waits(), [30, 40, 0]);
});

test('every scheduler read of the open queue uses the rank order', async () => {
  const source = await fs.readFile(new URL('../runtime/jobs.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ORDER BY created_at/, 'a read of the line ignores queue_rank');
  assert.match(source, /ORDER BY COALESCE\(queue_rank,rowid\),created_at,rowid LIMIT 1/);
});

test('planMove keeps renders that cannot move in place and clamps by the rules', () => {
  const entry = (id, movable = true, parentId = null) => ({
    id,
    status: movable ? 'queued' : 'running',
    movable,
    parentId,
  });
  const entries = [entry('run', false), entry('a'), entry('b'), entry('c', true, 'a')];
  const plan = planMove(entries, 'b', { kind: 'to', value: 'top' });
  assert.deepEqual(plan.order, ['run', 'b', 'a', 'c']);
  assert.deepEqual([plan.from, plan.to, plan.count], [2, 1, 3]);
  // The render that uses "a" cannot go above it; it goes right behind it.
  const clamped = planMove(entries, 'c', { kind: 'to', value: 'top' });
  assert.deepEqual(clamped.order, ['run', 'a', 'c', 'b']);
  assert.equal(clamped.clamped, 'a');
  assert.throws(() => planMove(entries, 'run', { kind: 'to', value: 'end' }), QueueMoveError);
});

test('the move request is validated strictly', () => {
  const id = randomUUID();
  assert.deepEqual(parseMoveRequest({ to: 'next' }), { kind: 'to', value: 'next' });
  assert.deepEqual(parseMoveRequest({ direction: 'up', expectedRank: null }), {
    kind: 'direction',
    value: 'up',
    expectedRank: null,
  });
  assert.deepEqual(parseMoveRequest({ after: id, expectedAnchorRank: 3 }), {
    kind: 'after',
    value: id,
    expectedAnchorRank: 3,
  });
  for (const body of [
    null,
    [],
    'top',
    {},
    { to: 'top', direction: 'up' },
    { to: 'middle' },
    { to: 3 },
    { direction: 'sideways' },
    { before: 'not-an-id' },
    { before: id, after: id },
    { to: 'top', extra: true },
    { to: 'top', expectedRank: '5' },
    { to: 'top', expectedRank: Infinity },
    { to: 'top', expectedAnchorRank: 1 },
  ]) {
    assert.throws(
      () => parseMoveRequest(body),
      refused(400, 'invalid_request'),
      JSON.stringify(body),
    );
  }
});
