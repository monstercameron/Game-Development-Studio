import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { JobQueue } from '../runtime/jobs.js';
import { VIDEO_REQUEST_FIELDS, normalizeVideoRequest } from '../runtime/video-options.js';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';
import { rerunRequest } from '../src/rerun-request.js';
import { videoRequest } from '../src/imageVideoInputs.js';

const picture = '11111111-1111-4111-8111-111111111111.png';
const lastPicture = '22222222-2222-4222-8222-222222222222.png';
const clip = '33333333-3333-4333-8333-333333333333.webm';
const sound = '44444444-4444-4444-8444-444444444444.wav';
const normalize = (request) => normalizeVideoRequest(request, () => 99);

test('a video request with an unknown field is rejected and the message names it', () => {
  assert.throws(
    () => normalize({ prompt: 'a lake', references: [picture], fps: 30 }),
    /Unknown video setting "fps".*fixed at 24 fps/,
  );
  for (const [field, hint] of [
    ['width', /aspect and size with resolution/],
    ['duration', /frames \(17 × n \+ 5/],
    ['model', /Remove it/],
  ]) {
    assert.throws(
      () => normalize({ prompt: 'a lake', references: [picture], [field]: 1 }),
      (error) => error.message.includes(`"${field}"`) && hint.test(error.message),
      field,
    );
  }
  // A long made-up name cannot flood the message.
  const long = 'x'.repeat(500);
  assert.throws(
    () => normalize({ prompt: 'a lake', references: [picture], [long]: 1 }),
    (error) => error.message.length < 200,
  );
  for (const bad of [null, undefined, 'text', [], 7]) {
    assert.throws(() => normalize(bad), /Video settings must be an object/);
  }
});

test('every setting the studio, the API and older jobs use is still accepted', () => {
  // Queued by the first Forge versions: five fields only.
  const legacy = {
    prompt: 'a lake',
    references: [picture],
    aspect: 'portrait',
    frames: 56,
    steps: 8,
  };
  assert.deepEqual(normalize(legacy), { ...legacy, seed: 99 });
  // Every documented field, in two requests (guidance needs references; frames cannot have them).
  const frames = {
    prompt: 'a lake',
    references: [],
    aspect: 'cinema',
    frames: 311,
    steps: 8,
    seed: 5,
    source: 'frames',
    first_frame: picture,
    last_frame: lastPicture,
    resolution: 'medium',
    turbo: true,
    sampler: 'euler',
    scheduler: 'beta',
    max_vram: 12,
    reference_detail: 'max',
    also_mp4: true,
  };
  const referenced = {
    prompt: 'a lake',
    references: [picture],
    reference_videos: [clip],
    reference_audios: [sound],
    use_clip_audio: true,
    cfg_scale: 2,
    negative_prompt: 'blurry',
  };
  assert.ok(normalize(frames));
  assert.ok(normalize(referenced));
  for (const key of [...Object.keys(frames), ...Object.keys(referenced)]) {
    assert.ok(VIDEO_REQUEST_FIELDS.has(key), key);
  }
});

test('everything the normalizer stores is accepted again, so reruns and retries still work', () => {
  const stored = normalize({
    prompt: 'a lake',
    references: [picture],
    reference_videos: [clip],
    reference_audios: [sound],
    use_clip_audio: true,
    cfg_scale: 3,
    negative_prompt: 'blurry',
    resolution: 'large',
    max_vram: 10,
    also_mp4: true,
  });
  for (const key of Object.keys(stored)) {
    assert.ok(VIDEO_REQUEST_FIELDS.has(key), `${key} is stored but would be rejected`);
  }
  assert.deepEqual(normalize(stored), stored);
  // The studio's Rerun button sends the stored request back with a new prompt.
  const job = { type: 'video', request: { ...stored, referenceFrom: { jobId: randomUUID() } } };
  const rerun = rerunRequest(job, 'a new lake');
  assert.equal('referenceFrom' in rerun, false);
  assert.equal(normalize(rerun).prompt, 'a new lake');
});

test('Reuse settings builds a request the queue accepts', () => {
  const request = normalize({
    prompt: 'a lake',
    references: [picture],
    reference_videos: [clip],
    use_clip_audio: true,
    turbo: true,
    steps: 4,
    resolution: 'medium',
    sampler: 'res_multistep',
    also_mp4: true,
  });
  const meta = buildJobMetadata(
    { id: randomUUID(), type: 'video', request, projectId: randomUUID() },
    'video/forge-x.webm',
  );
  const plan = reusePlan({
    ...meta,
    prompt: { text: meta.prompt, negative: meta.negative },
    job: { type: 'video' },
  });
  const draft = {
    ...plan.draft,
    prompt: 'again',
    referenceIds: [picture],
    clipIds: [clip],
    videoClips: [{ path: 'video/a.webm' }],
    videoClipAudio: true,
  };
  const again = videoRequest(draft);
  for (const key of Object.keys(again)) {
    assert.ok(VIDEO_REQUEST_FIELDS.has(key), key);
  }
  assert.ok(normalize(again));
  // The details page still lists the stored settings by name.
  const rows = describeSettings({ ...meta, type: 'video' }).map((row) => row.label);
  assert.ok(rows.includes('Resolution'));
});

async function queueWithProject(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-video-fields-'));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Example'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Example', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    autoStart: false,
  });
  t.after(() => queue.stop());
  return { queue, projectId };
}

test('the queue refuses a video job with an unknown field instead of rendering without it', async (t) => {
  const { queue, projectId } = await queueWithProject(t);
  const request = { prompt: 'a lake', references: [picture], frames: 56, steps: 8 };
  assert.throws(
    () => queue.enqueue({ type: 'video', projectId, request: { ...request, fps: 30 } }),
    /Unknown video setting "fps".*24 fps/,
  );
  assert.throws(
    () => queue.estimate({ type: 'video', projectId, request: { ...request, fps: 30 } }),
    /Unknown video setting "fps"/,
  );
  assert.equal(queue.list().length, 0, 'nothing was queued');
  const accepted = queue.enqueue({ type: 'video', projectId, request });
  assert.equal(accepted.request.frames, 56);
  assert.throws(
    () =>
      queue.enqueue({
        type: 'video',
        projectId,
        request: { ...request, referenceFrom: { jobId: accepted.id }, fps: 24 },
      }),
    /Unknown video setting "fps"/,
  );
});

test('the video MCP tool rejects an unknown field and never queues the job', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'video-fields-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: { ...process.env, FORGE_STUDIO_URL: `http://127.0.0.1:${server.address().port}` },
      stderr: 'pipe',
    }),
  );
  const projectId = randomUUID();
  const rejected = await client.callTool({
    name: 'forge_queue_video',
    arguments: { projectId, prompt: 'a lake', references: [picture], fps: 30 },
  });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /fps/);
  assert.equal(requests.length, 0, 'the unknown field never reaches the queue');
  const accepted = await client.callTool({
    name: 'forge_queue_video',
    arguments: { projectId, prompt: 'a lake', references: [picture] },
  });
  assert.notEqual(accepted.isError, true);
  assert.equal(requests.length, 1);
});
