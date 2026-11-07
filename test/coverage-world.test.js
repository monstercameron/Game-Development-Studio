import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { stageProjectAsset } from '../runtime/references.js';

const ply =
  'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n';
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

async function createProject(root) {
  const projects = path.join(root, 'projects'),
    folder = path.join(projects, 'game'),
    projectId = randomUUID();
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  return { projects, folder, projectId };
}

function waitFor(queue, id, statuses) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      const job = queue.get(id);
      if (statuses.includes(job.status)) {
        resolve(job);
      } else if (Date.now() >= deadline) {
        reject(Error(`World job stayed ${job.status}: ${job.stage}`));
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('world validation rejects mode, resolution, reference-count, and numeric boundary errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-world-validation-'));
  const { projects, projectId } = await createProject(root);
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, autoStart: false });
  t.after(async () => {
    queue.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  const enqueue = (request) => queue.enqueue({ type: 'world', projectId, request });

  assert.throws(
    () => enqueue({ model: 'worldgen', mode: 'text', prompt: 'forest', resolution: 900 }),
    /WorldGen requires/,
  );
  assert.throws(
    () => enqueue({ model: 'worldgen', mode: 'image', resolution: 1024, references: [] }),
    /WorldGen requires/,
  );
  assert.throws(
    () =>
      enqueue({
        model: 'hy-world',
        mode: 'text',
        resolution: 518,
        references: [randomUUID() + '.png'],
      }),
    /HY-World/,
  );
  assert.throws(
    () =>
      enqueue({
        model: 'hy-world',
        mode: 'image',
        resolution: 518,
        references: Array.from({ length: 9 }, () => `${randomUUID()}.png`),
      }),
    /up to 8/,
  );
  assert.throws(
    () =>
      enqueue({
        model: 'worldgen',
        mode: 'text',
        prompt: 'forest',
        resolution: 1024,
        seed: 2147483648,
      }),
    /seed from 0 to 2147483647/,
  );
  assert.throws(
    () =>
      enqueue({
        model: 'worldgen',
        mode: 'text',
        prompt: 'forest',
        resolution: 1024,
        steps: 60.5,
      }),
    /10–60 steps/,
  );
  assert.equal(queue.list({}).length, 0);
});

test('world jobs route selected project assets and retry an accepted remote job without resubmitting', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-world-routing-'));
  const { projects, folder, projectId } = await createProject(root);
  await fs.writeFile(path.join(folder, 'images', 'reference.png'), png);
  const staged = await stageProjectAsset(folder, 'images/reference.png');
  assert.match(staged.id, /^[a-f0-9-]{36}\.png$/i);

  let submissions = 0,
    statusChecks = 0,
    submittedPayload;
  const remoteId = '1234567890abcdef1234567890abcdef';
  const server = createServer(async (req, res) => {
    const json = (value) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/status') {
      return json({ engine: 'forge-world-v1', ready: true, busy: false });
    }
    if (req.url === '/api/generate') {
      submissions += 1;
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      submittedPayload = JSON.parse(body);
      return json({ id: remoteId });
    }
    if (req.url === `/api/jobs/${remoteId}`) {
      statusChecks += 1;
      return json({ status: statusChecks === 1 ? 'failed' : 'completed' });
    }
    if (req.url === `/api/jobs/${remoteId}/world`) {
      res.end(ply);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const oldUrl = process.env.FORGE_WORLD_URL;
  process.env.FORGE_WORLD_URL = await listen(server);
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, intervalMs: 20 });
  t.after(async () => {
    queue.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (oldUrl === undefined) {
      delete process.env.FORGE_WORLD_URL;
    } else {
      process.env.FORGE_WORLD_URL = oldUrl;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const created = queue.enqueue({
    type: 'world',
    projectId,
    request: {
      model: 'worldgen',
      mode: 'image',
      prompt: '',
      output: 'mesh',
      resolution: 1600,
      references: [staged.id],
      seed: 5,
      steps: 20,
    },
  });
  const failed = await waitFor(queue, created.id, ['failed', 'interrupted']);
  assert.equal(failed.status, 'failed', failed.error);
  assert.equal(failed.remoteId, remoteId);

  const retry = queue.retry(created.id);
  assert.equal(retry.status, 'running');
  assert.equal(retry.stage, 'Rechecking the existing engine job.');
  const completed = await waitFor(queue, created.id, ['completed', 'failed', 'interrupted']);
  assert.equal(completed.status, 'completed', completed.error || completed.stage);
  assert.equal(submissions, 1);
  assert.equal(submittedPayload.mode, 'image');
  assert.equal(submittedPayload.output, 'mesh');
  assert.deepEqual(submittedPayload.images, [`data:image/png;base64,${png.toString('base64')}`]);
  assert.equal(await fs.readFile(path.join(folder, ...completed.output.split('/')), 'utf8'), ply);
  assert.match(completed.output, /^3d\/forge-.*\.ply$/);
});
