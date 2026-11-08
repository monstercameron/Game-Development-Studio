import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../runtime/jobs.js';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { GPU_RESERVE_MIB } from '../runtime/model-load.js';
import { createVideoPreparation } from '../runtime/video-preparation.js';
import { failureMessage } from '../runtime/video-failure.js';
import {
  DEFAULT_VIDEO_MAX_VRAM_GIB,
  REFERENCE_CLIP_MAX_VRAM_GIB,
  videoGpuBudget,
  videoMaxVramGiB,
  videoWarnings,
} from '../runtime/video-options.js';
import { describeSettings } from '../src/generation-details.js';
import { videoBudgetLabel } from '../src/imageVideoInputs.js';

const picture = '11111111-1111-4111-8111-111111111111.png';
const clip = '33333333-3333-4333-8333-333333333333.webm';

test('reference videos raise the engine budget to the measured 12 GiB unless one was chosen', () => {
  assert.equal(REFERENCE_CLIP_MAX_VRAM_GIB, 12);
  assert.equal(DEFAULT_VIDEO_MAX_VRAM_GIB, 6);
  assert.equal(
    videoMaxVramGiB({ references: [picture] }),
    null,
    'the engine default is left alone',
  );
  assert.equal(videoMaxVramGiB({ reference_videos: [clip] }), 12);
  assert.equal(videoMaxVramGiB({ reference_videos: [clip], use_clip_audio: true }), 12);
  assert.equal(videoMaxVramGiB({ reference_videos: [clip], max_vram: 8 }), 8);
  assert.equal(videoMaxVramGiB({ references: [picture], max_vram: 20 }), 20);
  assert.equal(videoMaxVramGiB({ reference_videos: [] }), null);
  assert.deepEqual(videoGpuBudget({ references: [picture] }), {
    gib: 6,
    explicit: false,
    reason: 'default',
  });
  assert.deepEqual(videoGpuBudget({ reference_videos: [clip] }), {
    gib: 12,
    explicit: false,
    reason: 'reference clips',
  });
  assert.deepEqual(videoGpuBudget({ reference_videos: [clip], max_vram: 5 }), {
    gib: 5,
    explicit: true,
    reason: 'chosen',
  });
});

test('memory admission waits for the budget the render will actually be given', async () => {
  let freeMiB = 11000;
  const prepare = createVideoPreparation({
    hardware: async () => ({ devices: [{ freeMiB }] }),
    services: async () => [],
  });
  assert.equal(await prepare({ references: [picture] }), null, '6 GiB plus the reserve fits');
  assert.equal(await prepare(), null, 'a call without a request keeps the 6 GiB threshold');
  const clipAdmission = await prepare({ references: [picture], reference_videos: [clip] });
  assert.equal(clipAdmission.status, 'waiting_memory');
  assert.equal(clipAdmission.details.requiredMiB, 12 * 1024 + GPU_RESERVE_MIB);
  assert.equal(
    await prepare({ reference_videos: [clip], max_vram: 8 }),
    null,
    'an explicit budget is not overridden',
  );
  assert.equal((await prepare({ references: [picture], max_vram: 12 })).status, 'waiting_memory');
  freeMiB = 20000;
  assert.equal(await prepare({ reference_videos: [clip] }), null);
});

test('the queue gives the video admission check the request of the job it is admitting', async (t) => {
  const engine = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: true, files: [], videos: [], job: null }));
  });
  engine.listen(0, '127.0.0.1');
  await once(engine, 'listening');
  t.after(() => engine.close());
  const previous = process.env.FORGE_VIDEO_URL;
  process.env.FORGE_VIDEO_URL = `http://127.0.0.1:${engine.address().port}`;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FORGE_VIDEO_URL;
    } else {
      process.env.FORGE_VIDEO_URL = previous;
    }
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-video-budget-'));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Example'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Example', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  const seen = [];
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    intervalMs: 50,
    prepareVideo: async (request) => {
      seen.push(request);
      return { status: 'waiting_memory', stage: 'Waiting for GPU memory for H3.', details: {} };
    },
  });
  t.after(() => queue.stop());
  const job = queue.enqueue({
    type: 'video',
    projectId,
    request: {
      prompt: 'follow <Video 1>',
      references: [picture],
      reference_videos: [clip],
      use_clip_audio: true,
      frames: 56,
      steps: 8,
    },
  });
  const deadline = Date.now() + 5000;
  while (!seen.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(seen[0]?.reference_videos?.[0], clip);
  assert.equal(queue.get(job.id).request.max_vram, undefined, 'the stored request is unchanged');
});

test('the recorded details show the budget a reference-clip render was given', () => {
  const request = {
    prompt: 'a lake',
    references: [picture],
    reference_videos: [clip],
    use_clip_audio: true,
    frames: 56,
    steps: 8,
    seed: 3,
  };
  const job = { id: randomUUID(), type: 'video', request, projectId: randomUUID() };
  const meta = buildJobMetadata(job, 'video/forge-x.webm');
  assert.equal(meta.settings.max_vram, 12);
  assert.equal(meta.settings.max_vram_automatic, true);
  const rows = Object.fromEntries(
    describeSettings({ ...meta, type: 'video' }).map((row) => [row.label, row.value]),
  );
  assert.equal(rows['GPU memory budget (GiB)'], '12');
  assert.match(rows['GPU budget set by Forge for reference clips'], /On|Yes|true/i);
  // A chosen budget is recorded as chosen; a render without clips records nothing extra.
  const chosen = buildJobMetadata(
    { ...job, request: { ...request, max_vram: 9 } },
    'video/forge-y.webm',
  );
  assert.equal(chosen.settings.max_vram, 9);
  assert.equal('max_vram_automatic' in chosen.settings, false);
  const plain = buildJobMetadata(
    { ...job, request: { ...request, reference_videos: undefined, use_clip_audio: undefined } },
    'video/forge-z.webm',
  );
  assert.equal('max_vram' in plain.settings, false);
  // A record rebuilt for an older job must not claim a budget that job never had.
  const old = buildJobMetadata(job, 'video/forge-old.webm', { backfilled: true });
  assert.equal('max_vram' in old.settings, false);
});

test('the video page budget line follows the draft', () => {
  assert.match(videoBudgetLabel({}), /^~6 GiB render · ~12 GiB with reference clips$/);
  assert.equal(videoBudgetLabel({ videoClips: [{ path: 'a.webm' }] }), '~12 GiB (reference clips)');
  assert.equal(
    videoBudgetLabel({ videoClips: [{ path: 'a.webm' }], videoSource: 'frames' }),
    '~6 GiB render · ~12 GiB with reference clips',
    'clips are not used with first and last frames',
  );
  assert.equal(
    videoBudgetLabel({ videoClips: [{ path: 'a.webm' }], videoMaxVram: '9' }),
    '9 GiB (your setting)',
  );
  assert.equal(
    videoBudgetLabel({ videoMaxVram: 'abc' }),
    '~6 GiB render · ~12 GiB with reference clips',
  );
  const warnings = videoWarnings({ reference_videos: [clip] });
  assert.ok(warnings.some((line) => /12 GiB/.test(line)));
  assert.equal(
    videoWarnings({ reference_videos: [clip], max_vram: 8 }).some((line) => /12 GiB/.test(line)),
    false,
  );
});

test('the engine crash 0xC0000409 gets an actionable message and a memory failure keeps its own', () => {
  const crash = failureMessage({
    state: 'failed',
    message: 'Generation failed (engine exit 3221226505).',
  });
  assert.equal(
    crash,
    'The video engine crashed (0xC0000409), often under memory pressure. Retry; if it repeats, offload other models and lower max GPU memory/size.',
  );
  assert.equal(
    failureMessage({ message: 'Generation failed (engine exit 3221226505).', details: 'step 7/8' }),
    crash,
  );
  assert.equal(
    failureMessage({ message: 'Generation failed (engine exit 1).', details: 'ok' }),
    'Generation failed (engine exit 1).',
  );
  assert.match(
    failureMessage({
      message: 'Generation failed (engine exit 1).',
      details:
        'model manager cannot make enough memory ... failed to encode MiniMax-H3 reference video 1',
    }),
    /GPU memory budget/,
  );
  assert.equal(failureMessage({}), 'H3 Studio failed.');
});
