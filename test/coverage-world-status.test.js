import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';

const remoteId = '1234567890abcdef1234567890abcdef';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
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

test('an unknown world remote job stays interrupted until explicitly resolved and logs safely', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-world-status-'));
  const projects = path.join(root, 'projects');
  const projectId = randomUUID();
  const projectFolder = path.join(projects, 'game');
  await fs.mkdir(projectFolder, { recursive: true });
  await fs.writeFile(
    path.join(projectFolder, '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );

  let submissions = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') {
      res.end(JSON.stringify({ engine: 'forge-world-v1', ready: true, busy: false }));
      return;
    }
    if (req.url === '/api/generate') {
      submissions += 1;
      res.end(JSON.stringify({ id: remoteId }));
      return;
    }
    if (req.url === `/api/jobs/${remoteId}`) {
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'World job not found.' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: 'Not found.' }));
  });

  const oldUrl = process.env.FORGE_WORLD_URL;
  process.env.FORGE_WORLD_URL = await listen(server);
  const records = [];
  const directory = path.join(root, 'runtime');
  let queue = new JobQueue({
    directory,
    projects,
    intervalMs: 10,
    onQueueLog: (record) => records.push(record),
  });

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

  const prompt = 'WORLD_PROMPT_SHOULD_NOT_APPEAR_IN_LOGS';
  const created = queue.enqueue({
    type: 'world',
    projectId,
    request: {
      model: 'worldgen',
      mode: 'text',
      prompt,
      output: 'mesh',
      resolution: 1024,
      references: [],
      seed: 1,
      steps: 10,
    },
  });

  const interrupted = await waitFor(queue, created.id, ['interrupted', 'failed']);
  assert.equal(interrupted.status, 'interrupted', interrupted.error);
  assert.equal(interrupted.remoteId, remoteId);
  assert.match(interrupted.error, /no longer recognizes this job/);
  assert.equal(submissions, 1);
  assert.throws(() => queue.resolve(created.id, false), /Confirm that the remote engine job/);

  queue.stop();
  queue = new JobQueue({ directory, projects, autoStart: false });
  const recovered = queue.get(created.id);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.remoteId, remoteId);
  assert.equal(queue.resolve(created.id, true).status, 'cancelled');
  assert.equal(submissions, 1);

  assert.deepEqual(
    records.map(({ event, type, status }) => [event, type, status]),
    [
      ['enqueued', 'world', 'queued'],
      ['status_transition', 'world', 'submitting'],
      ['accepted', 'world', 'running'],
      ['interrupted', 'world', 'interrupted'],
    ],
  );
  for (const record of records) {
    assert.equal(record.jobId, created.id);
    assert.deepEqual(Object.keys(record).sort(), ['event', 'jobId', 'status', 'type']);
  }
  assert.equal(JSON.stringify(records).includes(prompt), false);
  assert.equal(JSON.stringify(records).includes(interrupted.error), false);
});
