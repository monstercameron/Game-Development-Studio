import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { readGlbStats } from '../runtime/glb-stats.js';
import { readAssetMeta } from '../runtime/asset-metadata.js';
import { vegetationVariations } from '../runtime/vegetation-request.js';
import { makeFakeSeedThree, useFakeSeedThree } from './fixtures/fake-seedthree-setup.js';

let fake;
let restoreEnvironment;
let runtimeDirectory;

before(async () => {
  fake = await makeFakeSeedThree();
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-veg-runtime-'));
  restoreEnvironment = useFakeSeedThree(fake, runtimeDirectory);
  // A short ceiling keeps the hang test quick; the runner reads it for every job.
  process.env.FORGE_VEGETATION_TIMEOUT_MS = '4000';
});

after(async () => {
  delete process.env.FORGE_VEGETATION_TIMEOUT_MS;
  restoreEnvironment();
  await fake.remove();
  await fs.rm(runtimeDirectory, { recursive: true, force: true });
});

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-veg-'));
  const projects = path.join(root, 'projects');
  const folder = path.join(projects, 'game');
  const projectId = randomUUID();
  await fs.mkdir(path.join(folder, '3d'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, intervalMs: 100 });
  return {
    root,
    projects,
    folder,
    projectId,
    queue,
    async dispose() {
      queue.stop();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function waitFor(queue, id, statuses, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = queue.get(id);
    if (statuses.includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Job stayed ${queue.get(id).status} (${queue.get(id).stage})`);
}

const request = (extra = {}) => ({ species: 'fakeTree', seed: 7, budget: 'high', ...extra });

test('vegetation jobs validate against the schema and reject unknown fields', async () => {
  const project = await makeProject();
  try {
    const enqueue = (value) =>
      project.queue.enqueue({ type: 'vegetation', projectId: project.projectId, request: value });
    assert.throws(() => enqueue({ species: 'oak' }), /available plant species/);
    assert.throws(() => enqueue(request({ seed: 0 })), /Seed must be a whole number/);
    assert.throws(() => enqueue(request({ seed: 1.5 })), /Seed must be a whole number/);
    assert.throws(() => enqueue(request({ budget: 'ultra' })), /low, medium or high/);
    assert.throws(() => enqueue(request({ colour: 'green' })), /Unknown vegetation setting/);
    assert.throws(() => enqueue(request({ params: { nope: 1 } })), /not a control/);
    assert.throws(() => enqueue(request({ params: { height: 99 } })), /from 2 to 30/);
    assert.throws(() => enqueue(request({ params: { branches: 2.5 } })), /whole number/);
    assert.throws(() => enqueue(request({ params: { crown: 7 } })), /must be one of/);
    assert.throws(() => enqueue(request({ params: { showLeaves: 'yes' } })), /true or false/);
    // SeedThree's own colour and tiling controls do not change the exported model: not offered.
    assert.throws(() => enqueue(request({ params: { barkTint: 1 } })), /not a control/);
    assert.throws(() => enqueue(request({ params: { tileWorldSize: 1 } })), /not a control/);
    assert.throws(() => enqueue(request({ params: { ['__proto__']: 1 } })), /not a control/);
    assert.throws(
      () =>
        project.queue.enqueue({ type: 'vegetation', projectId: randomUUID(), request: request() }),
      /Project was not found/,
    );
    assert.equal(project.queue.list().length, 0);
    const job = enqueue(
      request({ params: { height: 12, branches: 4, 'paramOverrides.angle.1': 55 } }),
    );
    // Values equal to the default are not stored, and the rest are stored sorted.
    assert.deepEqual(job.request.params, { height: 12, 'paramOverrides.angle.1': 55 });
    assert.equal(job.type, 'vegetation');
  } finally {
    await project.dispose();
  }
});

test('a vegetation job runs without an engine and saves a GLB, preset and provenance', async () => {
  const project = await makeProject();
  try {
    const queued = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ params: { branches: 6 } }),
    });
    const job = await waitFor(project.queue, queued.id, ['completed', 'failed']);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.output, `3d/forge-${job.id}.glb`);
    const glbPath = path.join(project.folder, ...job.output.split('/'));
    const stats = readGlbStats(glbPath);
    assert.ok(stats && stats.triangles > 0, 'the saved file is a readable GLB');
    const preset = JSON.parse(
      await fs.readFile(path.join(project.folder, '3d', `forge-${job.id}.preset.json`), 'utf8'),
    );
    assert.equal(preset.format, 'seedthree-preset/1');
    assert.equal(preset.controls.seed, 7);
    assert.equal(preset.controls.branches, 6);
    assert.equal(job.details.result.triangles, 1200, 'high budget exports the most detailed level');
    assert.ok(job.startedAt && job.finishedAt);
    // Staged files never remain next to the finished ones.
    const names = await fs.readdir(path.join(project.folder, '3d'));
    assert.deepEqual(names.sort(), [`forge-${job.id}.glb`, `forge-${job.id}.preset.json`].sort());
    const meta = readAssetMeta(project.folder, job.output);
    assert.equal(meta.asset.kind, '3d');
    assert.equal(meta.model.name, 'SeedThree');
    assert.match(meta.model.version, new RegExp(fake.commit.slice(0, 10)));
    assert.equal(meta.seed, 7);
    assert.equal(meta.settings.species, 'fakeTree');
    assert.equal(meta.settings.p_branches, 6);
    assert.equal(meta.settings.triangles, 1200);
    assert.equal(meta.prompt.title, 'Fake Tree · seed 7');
    assert.equal(meta.prompt.text, 'Fake Tree · seed 7', 'the library labels the file with it');
    const presetMeta = readAssetMeta(project.folder, `3d/forge-${job.id}.preset.json`);
    assert.equal(presetMeta.asset.kind, 'text');
  } finally {
    await project.dispose();
  }
});

test('the budget picks the level of detail and the same seed gives the same file', async () => {
  const project = await makeProject();
  try {
    const counts = {};
    const bytes = {};
    for (const budget of ['low', 'medium', 'high']) {
      const queued = project.queue.enqueue({
        type: 'vegetation',
        projectId: project.projectId,
        request: request({ budget }),
      });
      const job = await waitFor(project.queue, queued.id, ['completed', 'failed']);
      assert.equal(job.status, 'completed', job.error);
      counts[budget] = job.details.result.triangles;
      bytes[budget] = await fs.readFile(path.join(project.folder, ...job.output.split('/')));
    }
    assert.ok(counts.low < counts.medium && counts.medium < counts.high, JSON.stringify(counts));
    const again = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ budget: 'low' }),
    });
    const second = await waitFor(project.queue, again.id, ['completed']);
    const repeated = await fs.readFile(path.join(project.folder, ...second.output.split('/')));
    assert.ok(repeated.equals(bytes.low), 'same species, seed and settings give identical bytes');
  } finally {
    await project.dispose();
  }
});

test('variations are sibling jobs with consecutive seeds', async () => {
  const project = await makeProject();
  try {
    const requests = vegetationVariations(request({ seed: 100 }), 3, () => randomUUID());
    const ids = requests.map(
      (item) =>
        project.queue.enqueue({ type: 'vegetation', projectId: project.projectId, request: item })
          .id,
    );
    const jobs = [];
    for (const id of ids) {
      jobs.push(await waitFor(project.queue, id, ['completed', 'failed']));
    }
    assert.deepEqual(
      jobs.map((job) => [job.status, job.request.seed, job.request.variation_index]),
      [
        ['completed', 100, 1],
        ['completed', 101, 2],
        ['completed', 102, 3],
      ],
    );
    assert.equal(new Set(jobs.map((job) => job.request.variation_group)).size, 1);
    assert.throws(
      () =>
        project.queue.enqueue({
          type: 'vegetation',
          projectId: project.projectId,
          request: request({
            variation_index: 1,
            variation_count: 9,
            variation_group: randomUUID(),
          }),
        }),
      /Variation needs a group ID/,
    );
  } finally {
    await project.dispose();
  }
});

test('a crashing generator fails only that job and the queue keeps going', async () => {
  const project = await makeProject();
  try {
    const crash = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ species: 'crash' }),
    });
    const next = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request(),
    });
    const failed = await waitFor(project.queue, crash.id, ['failed', 'completed']);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /stopped unexpectedly \(exit code 3\)/);
    assert.equal(
      (await waitFor(project.queue, next.id, ['completed', 'failed'])).status,
      'completed',
    );
    assert.deepEqual(
      (await fs.readdir(path.join(project.folder, '3d'))).filter((name) => name.startsWith('.')),
      [],
    );
    // Retry is offered for a failed job and runs it again from the start.
    project.queue.retry(crash.id);
    assert.equal(project.queue.get(crash.id).status, 'queued');
  } finally {
    await project.dispose();
  }
});

test('a hung generator is stopped by the timeout', { timeout: 30000 }, async () => {
  const project = await makeProject();
  try {
    const queued = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ species: 'hang' }),
    });
    const job = await waitFor(project.queue, queued.id, ['failed', 'completed'], 25000);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /longer than 4 seconds/);
  } finally {
    await project.dispose();
  }
});

test('too many triangles and invalid exports are refused without saving anything', async () => {
  const project = await makeProject();
  try {
    const huge = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ species: 'huge' }),
    });
    const hugeJob = await waitFor(project.queue, huge.id, ['failed', 'completed']);
    assert.equal(hugeJob.status, 'failed');
    assert.match(hugeJob.error, /2,000,000 triangles.*limit is 1,500,000/);
    const bad = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ species: 'badglb' }),
    });
    const badJob = await waitFor(project.queue, bad.id, ['failed', 'completed']);
    assert.equal(badJob.status, 'failed');
    assert.match(badJob.error, /not a valid GLB/);
    assert.deepEqual(await fs.readdir(path.join(project.folder, '3d')), []);
  } finally {
    await project.dispose();
  }
});

test(
  'a queued job can be cancelled and a running one stops cleanly',
  { timeout: 30000 },
  async () => {
    const project = await makeProject();
    try {
      const slow = project.queue.enqueue({
        type: 'vegetation',
        projectId: project.projectId,
        request: request({ species: 'slow' }),
      });
      const waiting = project.queue.enqueue({
        type: 'vegetation',
        projectId: project.projectId,
        request: request({ seed: 9 }),
      });
      await waitFor(project.queue, slow.id, ['running']);
      assert.equal(project.queue.cancel(waiting.id).status, 'cancelled');
      assert.equal(project.queue.cancel(slow.id).status, 'cancelled');
      // Named apart from the imported `after` hook.
      const followUp = project.queue.enqueue({
        type: 'vegetation',
        projectId: project.projectId,
        request: request({ seed: 10 }),
      });
      assert.equal(
        (await waitFor(project.queue, followUp.id, ['completed', 'failed'])).status,
        'completed',
      );
      assert.equal(project.queue.get(slow.id).status, 'cancelled');
      assert.equal(project.queue.get(waiting.id).status, 'cancelled');
      const names = await fs.readdir(path.join(project.folder, '3d'));
      assert.ok(!names.some((name) => name.includes(slow.id)), 'a cancelled job leaves no files');
    } finally {
      await project.dispose();
    }
  },
);

test('a job left running by a stopped runtime is grown again after a restart', async () => {
  const project = await makeProject();
  try {
    project.queue.stop();
    const database = path.join(project.root, 'runtime', 'jobs.sqlite');
    const first = new JobQueue({
      directory: path.join(project.root, 'runtime'),
      projects: project.projects,
      autoStart: false,
    });
    const queued = first.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ seed: 21 }),
    });
    first.stop();
    const jobsDatabase = new DatabaseSync(database);
    jobsDatabase
      .prepare("UPDATE jobs SET status='running',started_at=?,stage='Growing' WHERE id=?")
      .run(new Date().toISOString(), queued.id);
    jobsDatabase.close();
    const restarted = new JobQueue({
      directory: path.join(project.root, 'runtime'),
      projects: project.projects,
      intervalMs: 100,
    });
    project.queue = restarted;
    const job = await waitFor(restarted, queued.id, ['completed', 'failed']);
    assert.equal(job.status, 'completed', job.error);
    assert.equal(job.request.seed, 21);
    restarted.stop();
  } finally {
    await fs.rm(project.root, { recursive: true, force: true });
  }
});

test('a missing checkout is reported with the Fetch instructions', async () => {
  const project = await makeProject();
  const previous = process.env.FORGE_SEEDTHREE_DIR;
  try {
    process.env.FORGE_SEEDTHREE_DIR = path.join(project.root, 'not-fetched');
    assert.throws(
      () =>
        project.queue.enqueue({
          type: 'vegetation',
          projectId: project.projectId,
          request: request(),
        }),
      /has not been fetched.*Fetch SeedThree/,
    );
    process.env.FORGE_SEEDTHREE_DIR = fake.directory;
    process.env.FORGE_SEEDTHREE_PIN = 'a'.repeat(40);
    assert.throws(
      () =>
        project.queue.enqueue({
          type: 'vegetation',
          projectId: project.projectId,
          request: request(),
        }),
      /not at the version Forge is tested with/,
    );
  } finally {
    process.env.FORGE_SEEDTHREE_DIR = previous;
    process.env.FORGE_SEEDTHREE_PIN = fake.commit;
    await project.dispose();
  }
});

test('the estimate groups renders by species and budget', async () => {
  const project = await makeProject();
  try {
    const before = project.queue.estimate({
      type: 'vegetation',
      projectId: project.projectId,
      request: request(),
    });
    assert.equal(before.available, false);
    const queued = project.queue.enqueue({
      type: 'vegetation',
      projectId: project.projectId,
      request: request(),
    });
    await waitFor(project.queue, queued.id, ['completed']);
    const estimateAfterRender = project.queue.estimate({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ seed: 99 }),
    });
    assert.equal(estimateAfterRender.available, true);
    assert.equal(estimateAfterRender.sampleCount, 1);
    const other = project.queue.estimate({
      type: 'vegetation',
      projectId: project.projectId,
      request: request({ budget: 'low' }),
    });
    assert.equal(other.available, false);
  } finally {
    await project.dispose();
  }
});
