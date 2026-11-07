import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';

test('durable queue lifecycle records are structured and exclude job payload data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-queue-logging-'));
  const projects = path.join(directory, 'projects');
  const projectId = randomUUID();
  const project = path.join(projects, 'Example');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const records = [];
  const queue = new JobQueue({
    directory: path.join(directory, 'runtime'),
    projects,
    autoStart: false,
    onQueueLog: (record) => records.push(record),
  });

  t.after(() => {
    queue.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const input = {
    type: 'images',
    projectId,
    request: {
      prompt: 'PROMPT_SECRET',
      width: 512,
      height: 512,
      num_inference_steps: 12,
      negative_prompt: 'PARAM_SECRET',
      true_cfg_scale: 2,
    },
  };
  const cancelled = queue.enqueue(input);
  assert.equal(queue.cancel(cancelled.id).status, 'cancelled');

  const retried = queue.enqueue(input);
  assert.equal(queue.lease(), true);
  const token = { owner: queue.owner, epoch: queue.epoch };
  assert.equal(
    queue.update(retried.id, { status: 'failed', error: 'RAW_ERROR_SECRET' }, token, 'failed'),
    true,
  );
  assert.equal(queue.retry(retried.id).status, 'queued');

  const completed = queue.enqueue(input);
  assert.equal(queue.update(completed.id, { status: 'running' }, token, 'accepted'), true);
  assert.equal(
    queue.update(
      completed.id,
      { status: 'completed', output: 'PATH_SECRET/output.png' },
      token,
      'completed',
    ),
    true,
  );

  const interrupted = queue.enqueue(input);
  assert.equal(
    queue.update(
      interrupted.id,
      { status: 'interrupted', error: 'RAW_ERROR_SECRET' },
      token,
      'uncertain_recovery',
    ),
    true,
  );

  assert.deepEqual(
    records.map(({ event, status }) => [event, status]),
    [
      ['enqueued', 'queued'],
      ['cancelled', 'cancelled'],
      ['enqueued', 'queued'],
      ['failed', 'failed'],
      ['retry_queued', 'queued'],
      ['enqueued', 'queued'],
      ['accepted', 'running'],
      ['completed', 'completed'],
      ['enqueued', 'queued'],
      ['uncertain_recovery', 'interrupted'],
    ],
  );
  for (const record of records) {
    assert.equal(record.source, undefined);
    assert.equal(record.type, 'images');
    assert.match(record.jobId, /^[a-f0-9-]{36}$/i);
    assert.deepEqual(Object.keys(record).sort(), ['event', 'jobId', 'status', 'type']);
  }
  const serialized = JSON.stringify(records);
  for (const secret of ['PROMPT_SECRET', 'PARAM_SECRET', 'RAW_ERROR_SECRET', 'PATH_SECRET']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
