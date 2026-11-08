import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { clearMemoryLogRecords, readMemoryLogRecords } from '../runtime/app-log.js';

test('queue transitions and admission waits are logged with ids, reasons and MiB only', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-queue-events-'));
  const projects = path.join(directory, 'projects');
  const projectId = randomUUID();
  const project = path.join(projects, 'Example');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({
    directory: path.join(directory, 'runtime'),
    projects,
    autoStart: false,
  });
  t.after(() => {
    queue.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  clearMemoryLogRecords();
  const job = queue.enqueue({
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
  });
  assert.equal(queue.lease(), true);
  const token = { owner: queue.owner, epoch: queue.epoch };
  const details = JSON.stringify({ requiredMiB: 24000, device: { freeMiB: 9000 } });
  assert.equal(queue.updatePending(job.id, { status: 'waiting_memory', details }, token), true);
  assert.equal(queue.cancel(job.id).status, 'cancelled');

  const records = readMemoryLogRecords();
  const waited = records.find((record) => record.event === 'queue.admission.waited');
  assert.equal(waited.jobId, job.id);
  assert.equal(waited.fields.reason, 'waiting_memory');
  assert.equal(waited.fields.requiredMiB, 24000);
  assert.equal(waited.fields.freeMiB, 9000);

  const transitions = records
    .filter((record) => record.event === 'job.state.changed')
    .map((record) => `${record.fields.from ?? '-'}>${record.fields.to}:${record.fields.reason}`);
  assert.deepEqual(transitions, [
    '->queued:enqueued',
    'queued>waiting_memory:status_transition',
    '->cancelled:cancelled_by_user',
  ]);
  assert.ok(records.some((record) => record.event === 'queue.lease.acquired'));
  assert.doesNotMatch(JSON.stringify(records), /PROMPT_SECRET|PARAM_SECRET/);
});
