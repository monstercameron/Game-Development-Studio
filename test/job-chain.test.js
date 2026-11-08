import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JobQueue } from '../runtime/jobs.js';

// Chained renders: a render declares request.referenceFrom = { jobId } and takes its reference
// from the finished output of an earlier render. These tests use temporary projects and no engine.

// Never reach a real engine that may be running on this computer: every engine URL points at a closed port.
for (const name of [
  'FORGE_HUNYUAN_URL',
  'FORGE_TRELLIS_URL',
  'FORGE_SAM31_URL',
  'FORGE_IMAGE_URL',
  'FORGE_VIDEO_URL',
  'FORGE_TTS_URL',
]) {
  process.env[name] = 'http://127.0.0.1:1';
}

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('cutout')]);

async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-chain-')),
    projects = path.join(dir, 'projects'),
    folder = path.join(projects, 'Game'),
    otherFolder = path.join(projects, 'Other'),
    projectId = randomUUID(),
    otherId = randomUUID();
  for (const [place, id] of [
    [folder, projectId],
    [otherFolder, otherId],
  ]) {
    await fs.mkdir(path.join(place, 'masks'), { recursive: true });
    await fs.mkdir(path.join(place, 'images'), { recursive: true });
    await fs.writeFile(path.join(place, '.forge-project.json'), JSON.stringify({ id }));
  }
  const state = path.join(dir, 'state');
  const opened = [];
  const open = () => {
    const next = new JobQueue({ directory: state, projects, autoStart: false, ...options });
    opened.push(next);
    return next;
  };
  const queue = open();
  // Hooks run in the order registered, so one hook closes every queue before the folder goes.
  t.after(async () => {
    for (const item of opened) {
      try {
        item.stop();
      } catch {
        // A test may already have stopped this queue to simulate a restart.
      }
    }
    await removeFolder(dir);
  });
  return { dir, projects, folder, projectId, otherId, queue, open, state };
}

const segmentation = (projectId, extra = {}) => ({
  type: 'segmentation',
  projectId,
  request: { prompt: 'the dragon', references: [`${randomUUID()}.png`], ...extra },
});
const model3d = (projectId, from, extra = {}) => ({
  type: '3d',
  projectId,
  request: { references: [], referenceFrom: from, ...extra },
});

const removeFolder = (folder) =>
  fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// Marks a job as finished the way the job worker would, then writes its output file.
async function complete(queue, folder, job, relative, bytes = PNG) {
  await fs.writeFile(path.join(folder, ...relative.split('/')), bytes);
  queue.db
    .prepare("UPDATE jobs SET status='completed',output=?,started_at=?,finished_at=? WHERE id=?")
    .run(relative, new Date(Date.now() - 5000).toISOString(), new Date().toISOString(), job.id);
}

test('a chained render stores its dependency and waits without a reference', async (t) => {
  const { queue, projectId } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }, { seed: 5 }));
  assert.equal(child.status, 'queued');
  assert.equal(child.dependsOn, parent.id);
  assert.equal(parent.dependsOn, null);
  assert.deepEqual(child.request.references, []);
  assert.deepEqual(child.request.referenceFrom, { jobId: parent.id });
  assert.match(child.stage, /Waiting for the render it depends on/);
  // The dependency is also in the list the studio reads.
  assert.equal(queue.list().find((job) => job.id === child.id).dependsOn, parent.id);
});

test('referenceFrom is validated for shape, type, project and parent state', async (t) => {
  const { queue, projectId, otherId } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const bad = (request, pattern, type = '3d', project = projectId) =>
    assert.throws(() => queue.enqueue({ type, projectId: project, request }), pattern);
  bad({ references: [], referenceFrom: 'abc' }, /referenceFrom must be an object/);
  bad({ references: [], referenceFrom: { jobId: 'not-an-id' } }, /referenceFrom must be/);
  bad({ references: [], referenceFrom: { jobId: parent.id, extra: 1 } }, /referenceFrom must be/);
  bad(
    { references: [], referenceFrom: { jobId: parent.id, output: 'images/x.png' } },
    /set by Forge/,
  );
  // A single-reference render cannot also bring its own picture.
  bad(
    { references: [`${randomUUID()}.png`], referenceFrom: { jobId: parent.id } },
    /cannot also have its own/,
  );
  // Only renders that take an image can chain.
  bad(
    { text: 'hello', referenceFrom: { jobId: parent.id } },
    /cannot take its reference/,
    'voices',
  );
  // The parent must exist, share the project, and make an image.
  bad({ references: [], referenceFrom: { jobId: randomUUID() } }, /was not found/);
  bad({ references: [], referenceFrom: { jobId: parent.id } }, /same project/, '3d', otherId);
  const voice = queue.enqueue({
    type: 'voices',
    projectId,
    request: { text: 'hello' },
  });
  bad({ references: [], referenceFrom: { jobId: voice.id } }, /image or a cutout/);
  const mask = queue.enqueue(segmentation(projectId, { output: 'mask' }));
  bad({ references: [], referenceFrom: { jobId: mask.id } }, /transparent cutout/);
  queue.cancel(parent.id);
  bad({ references: [], referenceFrom: { jobId: parent.id } }, /already cancelled/);
  // Each type's own rules still apply to the chained request.
  const live = queue.enqueue(segmentation(projectId));
  bad({ references: [], referenceFrom: { jobId: live.id }, seed: -1 }, /Invalid 3D seed/);
  // An image or video render may bring other references of its own.
  const video = queue.enqueue({
    type: 'video',
    projectId,
    request: {
      prompt: 'spin',
      references: [`${randomUUID()}.png`],
      referenceFrom: { jobId: live.id },
    },
  });
  assert.equal(video.request.references.length, 1);
  assert.equal(video.dependsOn, live.id);
});

test('the reference is staged from the finished render and recorded on the request', async (t) => {
  const { queue, folder, projectId } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  // While the parent is open the child keeps waiting and nothing is staged.
  queue.db.prepare("UPDATE jobs SET status='running',remote_id='r' WHERE id=?").run(parent.id);
  queue.db
    .prepare("UPDATE jobs SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(child.id);
  await queue.tick();
  assert.equal(queue.get(child.id).request.references.length, 0);

  await complete(queue, folder, parent, 'masks/cutout.png');
  await queue.tick();
  const resolved = queue.get(child.id);
  assert.equal(resolved.request.references.length, 1);
  assert.match(resolved.request.references[0], /^[a-f0-9-]{36}\.png$/);
  assert.deepEqual(resolved.request.referenceFrom, {
    jobId: parent.id,
    output: 'masks/cutout.png',
  });
  assert.deepEqual(
    await fs.readFile(path.join(folder, '.forge-inputs', resolved.request.references[0])),
    PNG,
  );
  assert.equal(resolved.dependsOn, parent.id);
  assert.notEqual(resolved.status, 'failed');

  // A resolved request is a normal single-reference request: it can be estimated again.
  assert.equal(
    queue.estimate({ type: '3d', projectId, request: resolved.request }).available,
    false,
  );
});

test('a render uses the renamed output of the earlier render', async (t) => {
  const asked = [];
  const { queue, folder, projectId } = await setup(t, {
    resolveOutputs: async (jobs) => {
      asked.push(jobs[0].output);
      return jobs.map((job) => ({ ...job, output: 'masks/renamed.png' }));
    },
  });
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  await complete(queue, folder, parent, 'masks/renamed.png');
  queue.db.prepare("UPDATE jobs SET output='masks/original.png' WHERE id=?").run(parent.id);
  await queue.tick();
  assert.deepEqual(asked, ['masks/original.png']);
  assert.equal(queue.get(child.id).request.referenceFrom.output, 'masks/renamed.png');
});

test('a failed or cancelled parent ends the render with a clear message', async (t) => {
  const { queue, projectId, folder } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  queue.db
    .prepare("UPDATE jobs SET status='failed',error='SAM ran out of memory' WHERE id=?")
    .run(parent.id);
  await queue.tick();
  const failed = queue.get(child.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'Dependency failed.');
  assert.match(failed.error, /cutout this render depends on failed: SAM ran out of memory/);
  assert.equal(failed.request.references.length, 0);

  // Retrying the parent also queues the render that failed only because of it.
  queue.retry(parent.id);
  assert.equal(queue.get(child.id).status, 'queued');
  assert.equal(queue.get(child.id).error, null);

  // A parent that completed without saving a file is a failure, not a hang.
  queue.db
    .prepare("UPDATE jobs SET status='completed',output=NULL,error=NULL WHERE id=?")
    .run(parent.id);
  await queue.tick();
  assert.match(queue.get(child.id).error, /did not save a file/);

  // A deleted output is reported with its path.
  queue.retry(child.id);
  await complete(queue, folder, parent, 'masks/gone.png');
  await fs.rm(path.join(folder, 'masks', 'gone.png'));
  await queue.tick();
  assert.match(queue.get(child.id).error, /Could not use the finished cutout \(masks\/gone\.png\)/);
});

test('cancelling a parent cancels the renders still waiting for it, but not finished ones', async (t) => {
  const { queue, projectId, folder } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  const grandchild = queue.enqueue({
    type: 'images',
    projectId,
    request: { prompt: 'again', referenceFrom: { jobId: parent.id } },
  });
  const unrelated = queue.enqueue(segmentation(projectId));
  // The child that already received its reference keeps its place.
  const kept = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  const request = {
    ...kept.request,
    references: [`${randomUUID()}.png`],
    referenceFrom: { jobId: parent.id, output: 'masks/x.png' },
  };
  queue.db.prepare('UPDATE jobs SET request=? WHERE id=?').run(JSON.stringify(request), kept.id);

  queue.cancel(parent.id);
  assert.equal(queue.get(child.id).status, 'cancelled');
  assert.match(queue.get(child.id).stage, /Cancelled because the render it depends on/);
  assert.equal(queue.get(grandchild.id).status, 'cancelled');
  assert.equal(queue.get(unrelated.id).status, 'queued');
  assert.equal(queue.get(kept.id).status, 'queued');

  // The same cascade runs when an interrupted parent is resolved as cancelled, and transitively.
  const second = queue.enqueue(segmentation(projectId));
  const mid = queue.enqueue({
    type: 'segmentation',
    projectId,
    request: { prompt: 'x', references: [], referenceFrom: { jobId: second.id } },
  });
  const leaf = queue.enqueue(model3d(projectId, { jobId: mid.id }));
  queue.db.prepare("UPDATE jobs SET status='interrupted' WHERE id=?").run(second.id);
  queue.resolve(second.id, true);
  assert.equal(queue.get(mid.id).status, 'cancelled');
  assert.equal(queue.get(leaf.id).status, 'cancelled');
  assert.ok(folder);
});

test('the dependency and the pending reference survive a restart', async (t) => {
  const { queue, open, folder, projectId } = await setup(t);
  const parent = queue.enqueue(segmentation(projectId));
  const child = queue.enqueue(model3d(projectId, { jobId: parent.id }));
  queue.stop();
  const reopened = open();
  const again = reopened.get(child.id);
  assert.equal(again.dependsOn, parent.id);
  assert.deepEqual(again.request.referenceFrom, { jobId: parent.id });
  await complete(reopened, folder, parent, 'masks/after-restart.png');
  await reopened.tick();
  assert.equal(reopened.get(child.id).request.referenceFrom.output, 'masks/after-restart.png');
});

test('a database from before chaining gains the column and keeps its rows', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-chain-legacy-'));
  const legacy = new DatabaseSync(path.join(dir, 'jobs.sqlite'));
  legacy.exec(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, stage TEXT, error TEXT, output TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  );
  const id = randomUUID();
  legacy
    .prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(
      id,
      'sfx',
      randomUUID(),
      '{"prompt":"x"}',
      'completed',
      null,
      null,
      null,
      'sfx/a.wav',
      'a',
      'a',
    );
  legacy.close();
  const queue = new JobQueue({ directory: dir, projects: dir, autoStart: false });
  t.after(async () => {
    queue.stop();
    await removeFolder(dir);
  });
  const row = queue.get(id);
  assert.equal(row.dependsOn, null);
  assert.equal(row.output, 'sfx/a.wav');
  assert.ok(
    queue.db
      .prepare('PRAGMA table_info(jobs)')
      .all()
      .some((column) => column.name === 'depends_on'),
  );
});

test('enqueueChain validates every step first and inserts them together', async (t) => {
  const { queue, projectId, otherId } = await setup(t);
  const cutout = { prompt: 'the main object', references: [`${randomUUID()}.png`] };
  const step = (extra) => ({
    type: 'trellis',
    projectId,
    request: { references: [], referenceFrom: { step: 0 }, ...extra },
  });
  const first = { type: 'segmentation', projectId, request: cutout };
  const before = queue.list().length;
  // A bad second step leaves nothing behind.
  assert.throws(() => queue.enqueueChain([first, step({ steps: 99 })]), /Invalid TRELLIS/);
  assert.throws(() => queue.enqueueChain([first]), /2 to 4/);
  assert.throws(
    () => queue.enqueueChain([first, { ...step(), request: { references: [] } }]),
    /must take its reference from an earlier step/,
  );
  assert.throws(
    () => queue.enqueueChain([first, step({ referenceFrom: { step: 1 } })]),
    /earlier step/,
  );
  assert.throws(
    () =>
      queue.enqueueChain([
        { ...first, request: { ...cutout, referenceFrom: { step: 0 } } },
        step(),
      ]),
    /first render in a chain/,
  );
  assert.throws(
    () => queue.enqueueChain([first, { ...step(), projectId: otherId }]),
    /same project/,
  );
  assert.throws(
    () => queue.enqueueChain([{ ...first, request: { ...cutout, output: 'mask' } }, step()]),
    /transparent cutout/,
  );
  assert.equal(queue.list().length, before);

  const [a, b] = queue.enqueueChain([first, step({ pipeline: '1024' })]);
  assert.equal(b.dependsOn, a.id);
  assert.deepEqual(b.request.referenceFrom, { jobId: a.id });
  assert.equal(b.request.pipeline, '1024');
  assert.equal(a.type, 'segmentation');
  assert.equal(queue.list().length, before + 2);
  // The earlier step is first in line, so it runs before the step that waits for it.
  const order = queue
    .list()
    .filter((job) => [a.id, b.id].includes(job.id))
    .map((job) => job.id);
  assert.deepEqual(order, [a.id, b.id]);
});

test('text-to-3D chains a transparent image into the 3D render', async (t) => {
  const { queue, projectId } = await setup(t);
  const [image, shape] = queue.enqueueChain([
    {
      type: 'images',
      projectId,
      request: {
        prompt: 'a wooden barrel',
        width: 1024,
        height: 1024,
        num_inference_steps: 25,
        transparent: true,
      },
    },
    {
      type: '3d',
      projectId,
      request: { references: [], referenceFrom: { step: 0 }, texture: true },
    },
  ]);
  assert.equal(image.request.transparent, true);
  assert.equal(typeof image.request.seed, 'number');
  assert.equal(shape.request.texture, true);
  assert.equal(shape.dependsOn, image.id);
});

test('timing keys count a waiting reference and separate TRELLIS pipelines', async (t) => {
  const { queue, projectId } = await setup(t);
  const done = (type, request, seconds) => {
    const id = randomUUID();
    queue.db
      .prepare(
        "INSERT INTO jobs(id,type,project_id,request,status,created_at,updated_at,started_at,finished_at) VALUES(?,?,?,?,'completed',?,?,?,?)",
      )
      .run(
        id,
        type,
        projectId,
        JSON.stringify(request),
        'a',
        'a',
        '2026-01-01T00:00:00.000Z',
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + seconds * 1000).toISOString(),
      );
  };
  const ref = `${randomUUID()}.png`;
  done(
    'images',
    { prompt: 'x', width: 1024, height: 1024, num_inference_steps: 25, references: [ref] },
    40,
  );
  const estimate = queue.estimate({
    type: 'images',
    projectId,
    request: {
      prompt: 'x',
      width: 1024,
      height: 1024,
      num_inference_steps: 25,
      referenceFrom: { jobId: randomUUID() },
    },
  });
  assert.equal(estimate.available, true);
  assert.equal(estimate.typicalSeconds, 40);

  done('trellis', { model: 'trellis', steps: 12, texture_size: 1024, target_faces: 100000 }, 120);
  const base = { references: [ref], steps: 12, texture_size: 1024, target_faces: 100000 };
  assert.equal(queue.estimate({ type: 'trellis', projectId, request: base }).sampleCount, 1);
  assert.equal(
    queue.estimate({ type: 'trellis', projectId, request: { ...base, pipeline: '512' } })
      .sampleCount,
    1,
  );
  assert.equal(
    queue.estimate({ type: 'trellis', projectId, request: { ...base, pipeline: '1024_cascade' } })
      .sampleCount,
    0,
  );
});

test('TRELLIS pipelines are validated and the default is omitted', async (t) => {
  const { queue, projectId } = await setup(t);
  const request = { references: [`${randomUUID()}.png`] };
  const plain = queue.enqueue({ type: 'trellis', projectId, request });
  assert.equal('pipeline' in plain.request, false);
  assert.equal(
    'pipeline' in
      queue.enqueue({ type: 'trellis', projectId, request: { ...request, pipeline: '512' } })
        .request,
    false,
  );
  for (const pipeline of ['1024', '1024_cascade', '1536_cascade']) {
    assert.equal(
      queue.enqueue({ type: 'trellis', projectId, request: { ...request, pipeline } }).request
        .pipeline,
      pipeline,
    );
  }
  for (const pipeline of ['2048', 1024, '', null]) {
    assert.throws(
      () => queue.enqueue({ type: 'trellis', projectId, request: { ...request, pipeline } }),
      /pipeline must be one of/,
    );
  }
});

test('the render budget check receives the TRELLIS request', async (t) => {
  const seen = [];
  const { queue, projectId, folder } = await setup(t, {
    prepareTrellisRender: async (request) => {
      seen.push(request.pipeline);
      return { status: 'waiting_memory', stage: 'Waiting for GPU memory.', details: {} };
    },
  });
  const server = (await import('node:http')).createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        engine: 'forge-trellis2-512-experimental-v1',
        phase: 'ready',
        loaded: true,
        model_downloaded: true,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = process.env.FORGE_TRELLIS_URL;
  process.env.FORGE_TRELLIS_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.FORGE_TRELLIS_URL;
    } else {
      process.env.FORGE_TRELLIS_URL = previous;
    }
    await new Promise((resolve) => server.close(resolve));
  });
  await fs.writeFile(path.join(folder, 'images', 'a.png'), PNG);
  const { stageProjectAsset } = await import('../runtime/references.js');
  const staged = await stageProjectAsset(folder, 'images/a.png');
  queue.enqueue({
    type: 'trellis',
    projectId,
    request: { references: [staged.id], pipeline: '1536_cascade' },
  });
  await queue.tick();
  assert.deepEqual(seen, ['1536_cascade']);
});
