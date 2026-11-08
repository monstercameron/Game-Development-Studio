import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { estimateFromJobs } from '../runtime/jobs.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';
import { videoRequest, videoFormatSummary } from '../src/imageVideoInputs.js';
import { work } from '../runtime/queue-timing.js';

test('video MCP tools stage clips and forward every H3 option', async (t) => {
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
    { name: 'video-mcp-test', version: '1.0.0' },
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
  const tools = (await client.listTools()).tools;
  const queue = tools.find((tool) => tool.name === 'forge_queue_video');
  assert.ok(tools.some((tool) => tool.name === 'forge_stage_video_clip'));
  assert.match(queue.description, /17 x n \+ 5/);
  assert.match(queue.description, /Restart the video engine/);
  assert.deepEqual(queue.inputSchema.properties.aspect.enum, [
    'landscape',
    'square',
    'portrait',
    'photo',
    'photo-portrait',
    'cinema',
  ]);
  assert.deepEqual(queue.inputSchema.properties.source.enum, ['references', 'frames', 'text']);
  assert.equal(queue.inputSchema.required?.includes('references'), false);
  const projectId = randomUUID(),
    first = `${randomUUID()}.png`,
    last = `${randomUUID()}.png`;
  await client.callTool({
    name: 'forge_stage_video_clip',
    arguments: { projectId, path: 'video/motion.webm' },
  });
  assert.deepEqual(requests[0], {
    path: `/api/projects/${projectId}/clips/from-asset`,
    body: { path: 'video/motion.webm' },
  });
  const result = await client.callTool({
    name: 'forge_queue_video',
    arguments: {
      projectId,
      prompt: 'she turns',
      source: 'frames',
      first_frame: first,
      last_frame: last,
      aspect: 'cinema',
      resolution: 'medium',
      frames: 311,
      steps: 8,
      turbo: true,
      also_mp4: true,
    },
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(requests[1], {
    path: '/api/runtime/jobs',
    body: {
      type: 'video',
      projectId,
      request: {
        prompt: 'she turns',
        references: [],
        source: 'frames',
        first_frame: first,
        last_frame: last,
        aspect: 'cinema',
        resolution: 'medium',
        frames: 311,
        steps: 8,
        turbo: true,
        also_mp4: true,
      },
    },
  });
  for (const bad of [{ frames: 100 }, { frames: 400 }, { max_vram: 2 }, { sampler: 'ddim' }]) {
    const rejected = await client.callTool({
      name: 'forge_queue_video',
      arguments: { projectId, prompt: 'x', references: [first], ...bad },
    });
    assert.equal(rejected.isError, true, JSON.stringify(bad));
  }
  assert.equal(requests.length, 2, 'invalid requests never reach the queue');
});

const projectId = '77777777-7777-4777-8777-777777777777';
const first = '11111111-1111-4111-8111-111111111111.png';
const clip = '33333333-3333-4333-8333-333333333333.webm';
const jobRequest = {
  prompt: 'she turns',
  references: [],
  aspect: 'cinema',
  frames: 311,
  steps: 8,
  seed: 5,
  source: 'frames',
  first_frame: first,
  reference_videos: [clip],
  resolution: 'medium',
  cfg_scale: 2,
  negative_prompt: 'blurry',
  turbo: false,
  sampler: 'euler',
  max_vram: 12,
  also_mp4: true,
};

// What the asset-details API returns: the stored record with the prompt grouped.
const readShape = (meta) => ({
  ...meta,
  prompt: { text: meta.prompt, negative: meta.negative },
  job: { type: 'video' },
});

test('generation details record the new video settings, references and negative prompt', () => {
  const meta = buildJobMetadata(
    { id: randomUUID(), type: 'video', request: jobRequest, projectId },
    'video/forge-x.webm',
  );
  assert.equal(meta.negative, 'blurry');
  assert.deepEqual(
    meta.references.map((item) => item.name),
    [`First frame · ${first}`, `Reference video · ${clip}`],
  );
  assert.equal(meta.references[1].mime, 'video/webm');
  for (const left of ['first_frame', 'reference_videos', 'negative_prompt', 'references']) {
    assert.equal(left in meta.settings, false, left);
  }
  assert.equal(meta.settings.source, 'frames');
  const rows = Object.fromEntries(
    describeSettings({ ...meta, type: 'video' }).map((row) => [row.label, row.value]),
  );
  assert.equal(rows.Aspect, 'Cinema · 21:9');
  assert.equal(rows.Resolution, 'Medium (about 0.3 megapixels)');
  assert.equal(rows['Starts from'], 'First and last frame');
  assert.equal(rows.Guidance, '2');
  assert.equal(rows['GPU memory budget (GiB)'], '12');
  assert.equal(rows['MP4 copy saved'], 'On');
});

test('reusing a video render refills the new controls but never attaches files', () => {
  const meta = buildJobMetadata(
    { id: randomUUID(), type: 'video', request: jobRequest, projectId },
    'video/forge-x.webm',
  );
  const plan = reusePlan(readShape(meta));
  assert.equal(plan.section, 'video');
  assert.deepEqual(plan.draft.options, ['Cinema · 21:9', 'About 13 seconds']);
  assert.deepEqual(
    {
      videoSource: plan.draft.videoSource,
      videoResolution: plan.draft.videoResolution,
      videoSteps: plan.draft.videoSteps,
      videoNegative: plan.draft.videoNegative,
      videoCfg: plan.draft.videoCfg,
      videoSampler: plan.draft.videoSampler,
      videoMaxVram: plan.draft.videoMaxVram,
      videoAlsoMp4: plan.draft.videoAlsoMp4,
      videoTurbo: plan.draft.videoTurbo,
    },
    {
      videoSource: 'frames',
      videoResolution: 'medium',
      videoSteps: '8',
      videoNegative: 'blurry',
      videoCfg: '2',
      videoSampler: 'euler',
      videoMaxVram: '12',
      videoAlsoMp4: true,
      videoTurbo: false,
    },
  );
  assert.equal(plan.draft.firstFrameId, undefined);
  assert.equal(plan.draft.videoFirstFrame, undefined);
  // The reused draft turns back into the same request apart from the staged files.
  const draft = { ...plan.draft, videoFirstFrame: { name: 'a.png', size: 1 } };
  const again = videoRequest({ ...draft, prompt: 'she turns', seed: '5' });
  for (const key of [
    'aspect',
    'frames',
    'steps',
    'resolution',
    'cfg_scale',
    'negative_prompt',
    'sampler',
    'max_vram',
    'also_mp4',
    'source',
  ]) {
    assert.deepEqual(again[key], jobRequest[key], key);
  }
  // A frame count between the presets reuses the nearest one.
  const odd = reusePlan(readShape({ ...meta, settings: { ...meta.settings, frames: 260 } }));
  assert.equal(odd.draft.options[1], 'About 10 seconds');
});

test('the summary and time estimates follow the picture size and guidance', () => {
  assert.match(
    videoFormatSummary(['Landscape · 16:9', 'About 5 seconds'], {}),
    /^608 × 352 pixels · 124 frames/,
  );
  assert.match(
    videoFormatSummary(['Cinema · 21:9', 'About 15 seconds'], { videoResolution: 'large' }),
    /^1120 × 480 pixels · 362 frames at 24 fps \(15\.0 s\)/,
  );
  const base = { aspect: 'landscape', frames: 124, steps: 12 };
  assert.equal(work('video', base), 124 * 12);
  assert.equal(work('video', { ...base, cfg_scale: 2 }), 124 * 12 * 2);
  assert.ok(work('video', { ...base, resolution: 'hd' }) > work('video', base) * 4.5);
  assert.equal(work('video', { ...base, aspect: 'portrait' }), work('video', base));
  // Renders at another size or with guidance never share timing history with the default.
  const completedJob = (request) => ({
    type: 'video',
    status: 'completed',
    request,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:05:00Z',
  });
  const history = [completedJob({ ...base, references: ['a'] })];
  assert.equal(
    estimateFromJobs(history, { type: 'video', request: { ...base, references: ['a'] } })
      .sampleCount,
    1,
  );
  for (const other of [
    { resolution: 'large' },
    { cfg_scale: 2 },
    { turbo: true },
    { source: 'frames' },
  ]) {
    assert.equal(
      estimateFromJobs(history, {
        type: 'video',
        request: { ...base, references: ['a'], ...other },
      }).sampleCount,
      0,
      JSON.stringify(other),
    );
  }
});
