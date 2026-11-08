import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { readReferences, stageProjectAsset } from '../runtime/references.js';

const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('private-free fixture bytes'),
]);

async function makeProject(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'Fixture');
  const projectId = randomUUID();
  await fs.mkdir(path.join(project, 'images'), { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  return { root, projects, project, projectId };
}

async function waitFor(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw Error('Timed out waiting for image job.');
}

test('image request validation rejects malformed options without persisting jobs', async (t) => {
  const cleanup = { queue: null };
  t.after(() => cleanup.queue?.stop());
  const { root, projects, projectId } = await makeProject(t, 'forge-image-validation-');
  const queue = new JobQueue({
    directory: path.join(root, 'state'),
    projects,
    autoStart: false,
  });
  cleanup.queue = queue;

  const base = { type: 'images', projectId, request: { prompt: 'a tree' } };
  for (const [change, pattern] of [
    [{ width: 513 }, /Invalid image dimensions/],
    [{ num_inference_steps: 101 }, /Invalid image dimensions/],
    [{ seed: Number.MAX_SAFE_INTEGER + 1 }, /Invalid image dimensions/],
    [{ references: ['../outside.png'] }, /staged reference image IDs/],
    [{ negative_prompt: 'blurred' }, /Negative prompt guidance/],
    [{ negative_prompt: 'blurred', true_cfg_scale: 1 }, /Negative prompt guidance/],
    [{ width: 2784 }, /Invalid image dimensions/],
    [{ transparent: 'yes' }, /true or false/],
    [{ size_from_reference: true }, /needs at least one reference/],
  ]) {
    assert.throws(
      () => queue.enqueue({ ...base, request: { ...base.request, ...change } }),
      pattern,
    );
  }
  assert.equal(queue.db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);

  const queued = queue.enqueue({
    ...base,
    request: {
      prompt: '  a tree  ',
      width: 512,
      height: 768,
      num_inference_steps: 30,
      negative_prompt: '  blur  ',
      true_cfg_scale: 2,
    },
  });
  // A blank seed is chosen when the job is queued, so the render is reproducible and its seed is recorded.
  const { seed, ...rest } = queued.request;
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 2147483647);
  assert.deepEqual(rest, {
    prompt: '  a tree  ',
    width: 512,
    height: 768,
    num_inference_steps: 30,
    references: [],
    negative_prompt: 'blur',
    true_cfg_scale: 2,
  });
  const fixed = queue.enqueue({ ...base, request: { prompt: 'a tree', seed: 7 } });
  assert.equal(fixed.request.seed, 7, 'an explicit seed is kept');
  const large = queue.enqueue({
    ...base,
    request: { prompt: 'a tree', width: 2752, height: 1536, transparent: true, seed: 1 },
  });
  assert.equal(large.request.width, 2752);
  assert.equal(large.request.transparent, true);
  const matched = queue.enqueue({
    ...base,
    request: {
      prompt: 'a tree',
      width: 512,
      references: ['00000000-0000-0000-0000-000000000000.png'],
      size_from_reference: true,
      seed: 1,
    },
  });
  assert.equal(matched.request.size_from_reference, true);
  assert.equal(matched.request.width, undefined, 'a matched size drops width and height');
});

test('staged image references remain immutable and corrupted snapshots fail at read time', async (t) => {
  const { project } = await makeProject(t, 'forge-image-staging-');
  const source = path.join(project, 'images', 'reference.png');
  await fs.writeFile(source, png);
  const staged = await stageProjectAsset(project, 'images/reference.png');

  await fs.writeFile(source, 'changed source after staging');
  assert.equal(
    (await readReferences(project, [staged.id], { max: 10 }))[0],
    `data:image/png;base64,${png.toString('base64')}`,
  );

  const snapshot = path.join(project, '.forge-inputs', staged.id);
  await fs.writeFile(snapshot, 'tampered staged bytes');
  await assert.rejects(readReferences(project, [staged.id], { max: 10 }), /PNG, JPEG, or WebP/);
  await assert.rejects(
    readReferences(project, ['not-a-staged-reference.png'], { max: 10 }),
    /staged reference image IDs/,
  );
});

test(
  'a recovered image job checks its known remote result without resubmitting',
  { timeout: 10000 },
  async (t) => {
    const cleanup = { queue: null };
    t.after(() => cleanup.queue?.stop());
    const { root, projects, project, projectId } = await makeProject(t, 'forge-image-recovery-');
    const remoteId = 'already-accepted-image';
    let submissions = 0;
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/generate') {
        submissions++;
        res.end(JSON.stringify({ id: 'unexpected-new-job' }));
      } else if (req.url === `/api/jobs/${remoteId}`) {
        res.end(JSON.stringify({ status: 'completed', images: ['/outputs/recovered.png'] }));
      } else if (req.url === '/outputs/recovered.png') {
        res.end('recovered image fixture');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const previousUrl = process.env.FORGE_IMAGE_URL;
    process.env.FORGE_IMAGE_URL = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
      if (previousUrl === undefined) {
        delete process.env.FORGE_IMAGE_URL;
      } else {
        process.env.FORGE_IMAGE_URL = previousUrl;
      }
    });

    const queue = new JobQueue({
      directory: path.join(root, 'state'),
      projects,
      autoStart: false,
      recoverService: async () => null,
    });
    cleanup.queue = queue;
    const job = queue.enqueue({
      type: 'images',
      projectId,
      request: { prompt: 'recover this image' },
    });
    queue.db
      .prepare("UPDATE jobs SET status='running',remote_id=? WHERE id=?")
      .run(remoteId, job.id);

    await queue.tick();
    await waitFor(() => queue.get(job.id)?.status === 'completed');
    assert.equal(submissions, 0);
    assert.equal(queue.get(job.id).output, `images/forge-${job.id}.png`);
    assert.equal(
      await fs.readFile(path.join(project, ...queue.get(job.id).output.split('/')), 'utf8'),
      'recovered image fixture',
    );
  },
);
