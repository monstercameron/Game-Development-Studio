import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { DEPENDENCY_FAILED_STAGE, ENGINE_FAILED_OUTCOME, JobQueue } from '../runtime/jobs.js';
import { stageProjectAsset } from '../runtime/references.js';
import {
  SAM31_OPTION_FEATURE,
  cleanMatchReport,
  normalizeSelection,
  reportFromWorkerMetadata,
  usesSegmentationOptions,
} from '../runtime/sam31-options.js';

// Retrying a segmentation that failed with a known engine result, and the SAM match options.
// Every test uses temporary projects and a loopback fake SAM worker; no model is loaded.

// Point every engine URL at a closed port, so a test that forgets its fake fails instead of
// reaching a real engine.
for (const name of ['FORGE_HUNYUAN_URL', 'FORGE_TRELLIS_URL', 'FORGE_SAM31_URL']) {
  process.env[name] = 'http://127.0.0.1:1';
}

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cutout')]);
const removeFolder = (folder) =>
  fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

async function waitFor(check, label = 'condition') {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error(`Timed out waiting for ${label}`);
}

async function setup(t, { autoStart = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sam-retry-'));
  const projects = path.join(dir, 'projects');
  const folder = path.join(projects, 'Game');
  const projectId = randomUUID();
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  await fs.writeFile(path.join(folder, 'images', 'source.png'), PNG);
  const reference = await stageProjectAsset(folder, 'images/source.png');
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    autoStart,
    intervalMs: 50,
  });
  t.after(async () => {
    try {
      queue.stop();
    } catch {
      // A test may already have stopped this queue.
    }
    await removeFolder(dir);
  });
  const segmentation = (extra = {}) => ({
    type: 'segmentation',
    projectId,
    request: { prompt: 'the dragon', references: [reference.id], ...extra },
  });
  return { folder, projectId, queue, segmentation };
}

// Puts a job into the state the job worker leaves behind, without running anything.
function mark(queue, id, { status, remoteId = null, details = null, stage = 'Failed.', error }) {
  queue.db
    .prepare('UPDATE jobs SET status=?,remote_id=?,details=?,stage=?,error=? WHERE id=?')
    .run(status, remoteId, details && JSON.stringify(details), stage, error ?? null, id);
}

const REMOTE_ID = 'a'.repeat(32);
const KNOWN_FAILURE = { outcome: ENGINE_FAILED_OUTCOME };

test('retrying a known engine failure clears the remote id and queues a fresh attempt', async (t) => {
  const { queue, segmentation } = await setup(t);
  const job = queue.enqueue(segmentation());
  mark(queue, job.id, {
    status: 'failed',
    remoteId: REMOTE_ID,
    details: KNOWN_FAILURE,
    error: 'No matching objects were found.',
  });
  queue.db.prepare('UPDATE jobs SET started_at=?,finished_at=? WHERE id=?').run('a', 'b', job.id);
  const retried = queue.retry(job.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.remoteId, null);
  assert.equal(retried.stage, 'Queued for retry.');
  assert.equal(retried.error, null);
  assert.equal(retried.details, null);
  assert.equal(retried.startedAt, null);
  assert.equal(retried.finishedAt, null);
  // A second click must not queue the same attempt twice.
  assert.throws(() => queue.retry(job.id), /Only failed or waiting jobs can be retried/);
  assert.equal(queue.get(job.id).status, 'queued');
});

test('retrying a failure with an unknown outcome only rechecks the existing engine job', async (t) => {
  const { queue, segmentation } = await setup(t);
  // Failed after the engine accepted the job, but not by an engine result (for example the
  // result could not be saved), so the old job is still the source of truth.
  const unmarked = queue.enqueue(segmentation());
  mark(queue, unmarked.id, { status: 'failed', remoteId: REMOTE_ID, error: 'Disk full.' });
  const rechecked = queue.retry(unmarked.id);
  assert.equal(rechecked.status, 'running');
  assert.equal(rechecked.remoteId, REMOTE_ID);
  assert.equal(rechecked.stage, 'Rechecking the existing engine job.');
  // A job that needs attention after a lost reconnect is rechecked when it still has a remote id.
  const reconnect = queue.enqueue(segmentation());
  mark(queue, reconnect.id, {
    status: 'needs_attention',
    remoteId: REMOTE_ID,
    details: KNOWN_FAILURE,
    stage: 'Could not reconnect the engine for a previous render.',
  });
  assert.equal(queue.retry(reconnect.id).remoteId, REMOTE_ID);
  assert.equal(queue.get(reconnect.id).status, 'running');
  // An interrupted submission has an unknown outcome and can only be resolved, never retried.
  const lost = queue.enqueue(segmentation());
  mark(queue, lost.id, {
    status: 'interrupted',
    details: KNOWN_FAILURE,
    stage: 'Needs attention.',
  });
  assert.throws(() => queue.retry(lost.id), /Only failed or waiting jobs can be retried/);
  assert.equal(queue.get(lost.id).status, 'interrupted');
  // A failure before anything was submitted has nothing to recheck.
  const early = queue.enqueue(segmentation());
  mark(queue, early.id, { status: 'failed', error: 'Could not read the reference image.' });
  assert.equal(queue.retry(early.id).status, 'queued');
});

test('retrying a known failure requeues the chained renders that failed only because of it', async (t) => {
  const { queue, projectId, segmentation } = await setup(t);
  const parent = queue.enqueue(segmentation());
  const child = queue.enqueue({
    type: '3d',
    projectId,
    request: { references: [], referenceFrom: { jobId: parent.id } },
  });
  mark(queue, parent.id, {
    status: 'failed',
    remoteId: REMOTE_ID,
    details: KNOWN_FAILURE,
    error: 'No matching objects were found.',
  });
  mark(queue, child.id, {
    status: 'failed',
    stage: DEPENDENCY_FAILED_STAGE,
    error: 'The cutout this render depends on failed.',
  });
  queue.retry(parent.id);
  assert.equal(queue.get(parent.id).status, 'queued');
  assert.equal(queue.get(parent.id).remoteId, null);
  const requeued = queue.get(child.id);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.error, null);
  assert.match(requeued.stage, /Waiting for the render it depends on/);
  assert.equal(requeued.dependsOn, parent.id);
});

test('cancelling a retried parent says so and cancels the renders waiting for it', async (t) => {
  const { queue, projectId, segmentation } = await setup(t);
  const parent = queue.enqueue(segmentation());
  const child = queue.enqueue({
    type: '3d',
    projectId,
    request: { references: [], referenceFrom: { jobId: parent.id } },
  });
  mark(queue, parent.id, { status: 'failed', remoteId: REMOTE_ID, details: KNOWN_FAILURE });
  mark(queue, child.id, { status: 'failed', stage: DEPENDENCY_FAILED_STAGE });
  queue.retry(parent.id);
  queue.cancel(parent.id);
  const cancelled = queue.get(parent.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.stage, 'Cancelled.');
  assert.equal(cancelled.error, null);
  assert.equal(queue.get(child.id).status, 'cancelled');
  assert.match(queue.get(child.id).stage, /Cancelled because the render it depends on/);
});

// A fake SAM worker that remembers jobs until `restart()` and then answers 404 for them, like a
// worker process that was restarted. Failed and finished outcomes are scripted per submission.
async function fakeSam(t, { features = [SAM31_OPTION_FEATURE], outcomes } = {}) {
  const log = { submissions: [], lookups: [] };
  const ids = outcomes.map((_, index) => String(index + 1).repeat(32));
  const known = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') {
      return res.end(
        JSON.stringify({
          engine: 'forge-sam31-image-experimental-v1',
          phase: 'ready',
          loaded: true,
          model_downloaded: true,
          ...(features ? { features } : {}),
        }),
      );
    }
    if (req.url === '/api/generate' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
      }
      log.submissions.push(JSON.parse(raw));
      const id = ids[log.submissions.length - 1];
      known.add(id);
      return res.end(JSON.stringify({ id }));
    }
    const match = /^\/api\/jobs\/([a-f0-9]{32})(\/image)?$/.exec(req.url);
    if (match) {
      const index = ids.indexOf(match[1]);
      log.lookups.push(match[1]);
      if (index < 0 || !known.has(match[1])) {
        res.statusCode = 404;
        return res.end('{}');
      }
      if (match[2]) {
        res.setHeader('Content-Type', 'image/png');
        return res.end(PNG);
      }
      return res.end(JSON.stringify(outcomes[index]));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = process.env.FORGE_SAM31_URL;
  process.env.FORGE_SAM31_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    process.env.FORGE_SAM31_URL = previous;
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    ids,
    log,
    restart: () => known.clear(),
  };
}

test(
  'after the SAM worker restarts, retrying a known failure submits again instead of rechecking',
  { timeout: 20000 },
  async (t) => {
    const sam = await fakeSam(t, {
      outcomes: [
        { status: 'failed', message: 'No matching objects were found. Try another description.' },
        {
          status: 'completed',
          metadata: {
            instances: 2,
            used: 1,
            matches: [
              { score: 0.91, selected: true },
              { score: 0.42, selected: false },
            ],
          },
        },
      ],
    });
    const { queue, folder, segmentation } = await setup(t, { autoStart: true });
    const job = queue.enqueue(segmentation());
    await waitFor(() => queue.get(job.id)?.status === 'failed', 'the engine failure');
    const failed = queue.get(job.id);
    assert.equal(failed.remoteId, sam.ids[0]);
    assert.match(failed.error, /No matching objects/);
    assert.deepEqual(failed.details, KNOWN_FAILURE);
    assert.equal(sam.log.submissions.length, 1);

    sam.restart();
    const lookupsBeforeRetry = sam.log.lookups.length;
    queue.retry(job.id);
    await waitFor(() => queue.get(job.id)?.status === 'completed', 'the fresh attempt');
    const done = queue.get(job.id);
    assert.equal(done.remoteId, sam.ids[1]);
    assert.equal(sam.log.submissions.length, 2);
    // The forgotten job was never asked about again, so it could not turn into "interrupted".
    assert.equal(sam.log.lookups.slice(lookupsBeforeRetry).includes(sam.ids[0]), false);
    assert.deepEqual(done.details, {
      result: { found: 2, used: 1, scores: [0.91, 0.42], usedScores: [0.91] },
    });
    assert.deepEqual(await fs.readFile(path.join(folder, ...done.output.split('/'))), PNG);
    // Another retry of a finished job is refused, so nothing can submit a third time.
    assert.throws(() => queue.retry(job.id), /Only failed or waiting jobs can be retried/);
    assert.equal(sam.log.submissions.length, 2);
  },
);

test(
  'a failure that is not an engine result is still rechecked, and a forgotten job stays guarded',
  { timeout: 20000 },
  async (t) => {
    const sam = await fakeSam(t, { outcomes: [{ status: 'completed' }] });
    const { queue, segmentation } = await setup(t, { autoStart: true });
    const job = queue.enqueue(segmentation());
    await waitFor(() => queue.get(job.id)?.status === 'completed', 'the first render');
    // Pretend saving the result failed after the engine had finished, then the worker restarted.
    mark(queue, job.id, {
      status: 'failed',
      remoteId: sam.ids[0],
      error: 'Could not save the result.',
    });
    sam.restart();
    queue.retry(job.id);
    await waitFor(() => queue.get(job.id)?.status === 'interrupted', 'the guarded recheck');
    assert.match(queue.get(job.id).error, /no longer recognizes this job/);
    assert.equal(queue.get(job.id).remoteId, sam.ids[0]);
    assert.equal(sam.log.submissions.length, 1);
  },
);

test(
  'match selection and outputs reach the SAM worker only when it supports them',
  { timeout: 20000 },
  async (t) => {
    const sam = await fakeSam(t, { outcomes: [{ status: 'completed' }, { status: 'completed' }] });
    const { queue, segmentation } = await setup(t, { autoStart: true });
    const job = queue.enqueue(
      segmentation({ output: 'cropped', select: 'top', max_instances: 2, confidence: 0.3 }),
    );
    await waitFor(() => queue.get(job.id)?.status === 'completed', 'the render');
    assert.deepEqual(
      { ...sam.log.submissions[0], image: undefined },
      {
        image: undefined,
        prompt: 'the dragon',
        output: 'cropped',
        confidence: 0.3,
        select: 'top',
        max_instances: 2,
      },
    );
    // Worker output without metadata (a job recovered after a restart) just has no report.
    assert.equal(queue.get(job.id).details, null);

    // A request that uses none of the new options sends none of the new fields.
    const plain = queue.enqueue(segmentation());
    await waitFor(() => queue.get(plain.id)?.status === 'completed', 'the second render');
    assert.equal('select' in sam.log.submissions[1], false);
    assert.equal('max_instances' in sam.log.submissions[1], false);
  },
);

test(
  'an older SAM worker is refused before anything is submitted',
  { timeout: 20000 },
  async (t) => {
    const sam = await fakeSam(t, { features: null, outcomes: [{ status: 'completed' }] });
    const { queue, segmentation } = await setup(t, { autoStart: true });
    const job = queue.enqueue(segmentation({ select: 'best' }));
    await waitFor(() => queue.get(job.id)?.status === 'failed', 'the version check');
    assert.match(queue.get(job.id).error, /older than the match selection/);
    assert.equal(sam.log.submissions.length, 0);
    // Nothing was submitted, so there is no remote job to recheck and a retry starts clean.
    assert.equal(queue.get(job.id).remoteId, null);
    assert.equal(queue.retry(job.id).status, 'queued');
    // Requests that use no new option never depend on the version check.
    queue.enqueue(segmentation());
    await waitFor(() => sam.log.submissions.length > 0, 'a plain submission');
    assert.equal(sam.log.submissions[0].output, 'transparent');
  },
);

test('the queue validates and stores the match selection', async (t) => {
  const { queue, segmentation } = await setup(t);
  const stored = (extra) => queue.enqueue(segmentation(extra)).request;
  // The default stores nothing, so requests keep the shape older Forge versions saved.
  assert.deepEqual(Object.keys(stored()).sort(), ['confidence', 'output', 'prompt', 'references']);
  assert.equal('select' in stored({ select: 'all' }), false);
  assert.equal(stored({ select: 'best' }).select, 'best');
  assert.equal('max_instances' in stored({ select: 'largest' }), false);
  assert.deepEqual(
    (({ select, max_instances }) => ({ select, max_instances }))(
      stored({ select: 'top', max_instances: 3, output: 'outline' }),
    ),
    { select: 'top', max_instances: 3 },
  );
  for (const output of ['transparent', 'mask', 'outline', 'cropped']) {
    assert.equal(stored({ output }).output, output);
  }
  assert.throws(() => stored({ output: 'sticker' }), /Invalid segmentation output/);
  for (const extra of [
    { select: 'some' },
    { select: 'top' },
    { select: 'top', max_instances: 0 },
    { select: 'top', max_instances: 51 },
    { select: 'top', max_instances: 2.5 },
    { select: 'top', max_instances: '2' },
    { select: 'best', max_instances: 2 },
    { select: 'all', max_instances: 1 },
  ]) {
    assert.throws(() => stored(extra), /select|max_instances/, JSON.stringify(extra));
  }
});

test('a cropped cutout can feed a chained render but an outline or mask cannot', async (t) => {
  const { queue, projectId, segmentation } = await setup(t);
  const child = (parent) => ({
    type: '3d',
    projectId,
    request: { references: [], referenceFrom: { jobId: parent.id } },
  });
  for (const output of ['transparent', 'cropped']) {
    assert.equal(queue.enqueue(child(queue.enqueue(segmentation({ output })))).status, 'queued');
  }
  for (const output of ['mask', 'outline']) {
    assert.throws(
      () => queue.enqueue(child(queue.enqueue(segmentation({ output })))),
      /transparent cutout \(or a cropped one\)/,
    );
  }
});

test('match option helpers validate input and clean worker reports', () => {
  assert.deepEqual(normalizeSelection({}), {});
  assert.deepEqual(normalizeSelection({ select: null, max_instances: null }), {});
  assert.deepEqual(normalizeSelection({ select: 'top', max_instances: 50 }), {
    select: 'top',
    max_instances: 50,
  });
  assert.equal(usesSegmentationOptions({ output: 'transparent' }), false);
  assert.equal(usesSegmentationOptions({ output: 'mask', select: 'all' }), false);
  assert.equal(usesSegmentationOptions({ output: 'outline' }), true);
  assert.equal(usesSegmentationOptions({ output: 'mask', select: 'best' }), true);

  assert.equal(reportFromWorkerMetadata(undefined), null);
  assert.equal(reportFromWorkerMetadata({ instances: 1, selectedPixels: 4 }), null);
  assert.equal(reportFromWorkerMetadata({ instances: -1, used: 0, matches: [] }), null);
  assert.deepEqual(
    reportFromWorkerMetadata({
      instances: 25,
      used: 2,
      matches: [
        { score: 0.123456, selected: true },
        { score: Number.NaN, selected: false },
        { score: 0.5, selected: true },
        null,
      ],
    }),
    { found: 25, used: 2, scores: [0.123, 0.5], usedScores: [0.123, 0.5] },
  );
  const manyScores = Array.from({ length: 40 }, (_, index) => ({ score: index / 100 }));
  assert.equal(
    cleanMatchReport({ found: 40, used: 0, scores: manyScores.map((m) => m.score) }).scores.length,
    20,
  );
  assert.equal(cleanMatchReport({ found: 1.5, used: 1 }), null);
  assert.equal(cleanMatchReport('2 matches'), null);
});

test('asset details record the match counts and the scores of the kept matches', () => {
  const job = {
    id: randomUUID(),
    type: 'segmentation',
    request: {
      prompt: 'the dragon',
      references: [`${randomUUID()}.png`],
      output: 'outline',
      confidence: 0.5,
      select: 'top',
      max_instances: 2,
    },
    details: {
      result: { found: 4, used: 2, scores: [0.9, 0.8, 0.5, 0.4], usedScores: [0.9, 0.8] },
    },
  };
  const { settings } = buildJobMetadata(job, 'masks/forge-example.png');
  assert.equal(settings.select, 'top');
  assert.equal(settings.max_instances, 2);
  assert.equal(settings.matches_found, 4);
  assert.equal(settings.matches_used, 2);
  assert.equal(settings.match_scores, '0.90, 0.80');
  const { settings: withoutDetails } = buildJobMetadata(
    { ...job, details: null },
    'masks/forge-example.png',
  );
  assert.equal('matches_found' in withoutDetails, false);
});
