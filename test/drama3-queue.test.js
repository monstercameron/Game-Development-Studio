import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-drama-queue-'));
  const projects = path.join(root, 'projects'),
    folder = path.join(projects, 'test');
  const projectId = randomUUID();
  await fs.mkdir(path.join(folder, 'voices'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, autoStart: false });
  t.after(async () => {
    queue.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { queue, projectId };
}
test('Drama 3 jobs validate requests before they enter the durable queue', async (t) => {
  const { queue, projectId } = await project(t);
  assert.throws(
    () =>
      queue.enqueue({
        type: 'drama3',
        projectId,
        request: { text: 'Hi', seed: 3, backend: 'cpu' },
      }),
    /Unsupported Drama 3 setting/,
  );
  assert.throws(
    () =>
      queue.enqueue({ type: 'drama3', projectId: randomUUID(), request: { text: 'Hi', seed: 3 } }),
    /Project was not found/,
  );
  const job = queue.enqueue({
    type: 'drama3',
    projectId,
    request: { text: '[laughs] Hello!', seed: 3 },
  });
  assert.equal(job.status, 'queued');
  assert.equal(job.type, 'drama3');
  assert.equal(queue.get(job.id).request.seed, 3);
  assert.equal(queue.get(job.id).request.max_tokens, 500);
});
