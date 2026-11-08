import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { audioPayload } from '../src/audio-payload.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';

async function makeQueue(t) {
  const holder = { queue: null };
  t.after(() => holder.queue?.stop());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-voice-sampling-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Fixture'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Fixture', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  holder.queue = new JobQueue({ directory: path.join(root, 'state'), projects, autoStart: false });
  return { queue: holder.queue, projectId };
}

test('voice jobs accept the sub-talker controls and greedy switches, and store only what was set', async (t) => {
  const { queue, projectId } = await makeQueue(t);
  const plain = queue.enqueue({ type: 'voices', projectId, request: { text: 'Hello there' } });
  for (const key of [
    'do_sample',
    'subtalker_dosample',
    'subtalker_temperature',
    'subtalker_top_p',
    'subtalker_top_k',
  ]) {
    assert.equal(Object.hasOwn(plain.request, key), false, `${key} is absent by default`);
  }
  const tuned = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello there',
      do_sample: false,
      subtalker_dosample: true,
      subtalker_temperature: 0.4,
      subtalker_top_p: 0.9,
      subtalker_top_k: 20,
    },
  });
  assert.equal(tuned.request.do_sample, false);
  assert.equal(tuned.request.subtalker_dosample, true);
  assert.equal(tuned.request.subtalker_temperature, 0.4);
  assert.equal(tuned.request.subtalker_top_p, 0.9);
  assert.equal(tuned.request.subtalker_top_k, 20);
  for (const bad of [
    { do_sample: 'yes' },
    { subtalker_dosample: 1 },
    { subtalker_temperature: 0 },
    { subtalker_temperature: 2.5 },
    { subtalker_top_p: 0 },
    { subtalker_top_p: 1.5 },
    { subtalker_top_k: 0 },
    { subtalker_top_k: 1001 },
    { subtalker_top_k: 2.5 },
  ]) {
    assert.throws(
      () => queue.enqueue({ type: 'voices', projectId, request: { text: 'Hello', ...bad } }),
      /sub-talker|sampling switch/,
      JSON.stringify(bad),
    );
  }
  assert.equal(queue.list().length, 2, 'rejected requests are not persisted');
});

test('the voice page builds the sub-talker request and Reuse settings restores it', () => {
  const projectId = randomUUID();
  const draft = {
    prompt: 'Hello there',
    options: ['Ryan', 'English'],
    seed: '5',
    voiceDoSample: 'off',
    voiceSubDoSample: 'on',
    voiceSubTemperature: '0.4',
    voiceSubTopP: '0.9',
    voiceSubTopK: '20',
  };
  const { request } = audioPayload('voices', projectId, draft);
  assert.equal(request.do_sample, false);
  assert.equal(request.subtalker_dosample, true);
  assert.equal(request.subtalker_temperature, 0.4);
  assert.equal(request.subtalker_top_p, 0.9);
  assert.equal(request.subtalker_top_k, 20);
  const blank = audioPayload('voices', projectId, { prompt: 'Hello', options: [] }).request;
  for (const key of ['do_sample', 'subtalker_dosample', 'subtalker_temperature']) {
    assert.equal(Object.hasOwn(blank, key), false);
  }
  assert.throws(
    () => audioPayload('voices', projectId, { ...draft, voiceSubTopK: '1.5' }),
    /Fine-detail top-k/,
  );
  assert.throws(
    () => audioPayload('voices', projectId, { ...draft, voiceSubTemperature: '3' }),
    /Fine-detail temperature/,
  );
  const meta = {
    type: 'voices',
    job: { type: 'voices' },
    prompt: { text: 'Hello there', secondary: '' },
    seed: 5,
    settings: { speaker: 'Ryan', language: 'English', ...request },
  };
  const plan = reusePlan(meta);
  assert.equal(plan.draft.voiceDoSample, 'off');
  assert.equal(plan.draft.voiceSubDoSample, 'on');
  assert.equal(plan.draft.voiceSubTemperature, '0.4');
  assert.equal(plan.draft.voiceSubTopK, '20');
  const rows = Object.fromEntries(describeSettings(meta).map((row) => [row.key, row.value]));
  assert.equal(rows.do_sample, 'Greedy');
  assert.equal(rows.subtalker_dosample, 'Sampling');
  assert.equal(rows.subtalker_temperature, '0.4');
});
