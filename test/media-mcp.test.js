import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function connect(t, reply, status) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(status ? status(calls.length) : 201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply ? reply(req.url, calls.length) : { job: { id: 'test-job' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'media-mcp-test', version: '1.0.0' },
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
  return { client, calls };
}

test('image MCP queues one job per variation, with distinct seeds in one group', async (t) => {
  const { client, calls } = await connect(t);
  const projectId = randomUUID();
  const response = await client.callTool({
    name: 'forge_queue_image',
    arguments: { projectId, prompt: 'a fox', variations: 3, seed: 100, num_inference_steps: 20 },
  });
  assert.equal(response.isError, false);
  assert.equal(calls.length, 3);
  const requests = calls.map((call) => call.body.request);
  assert.deepEqual(
    requests.map((request) => [request.seed, request.variation_index, request.variation_count]),
    [
      [100, 1, 3],
      [101, 2, 3],
      [102, 3, 3],
    ],
  );
  assert.equal(new Set(requests.map((request) => request.variation_group)).size, 1);
  assert.equal(
    Object.hasOwn(requests[0], 'variations'),
    false,
    'variations is not an engine field',
  );
  const summary = JSON.parse(response.content[0].text);
  assert.equal(summary.queued, 3);

  calls.length = 0;
  await client.callTool({
    name: 'forge_queue_image',
    arguments: { projectId, prompt: 'a fox' },
  });
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].body.request, 'variation_group'), false);

  calls.length = 0;
  await client.callTool({
    name: 'forge_queue_image',
    arguments: {
      projectId,
      prompt: 'a fox',
      sigmas: [1, 0.5, 0.2],
      lora: 'pixel-art.safetensors',
      lora_scale: 0.8,
      use_kv_cache: false,
      size_from_reference: true,
      references: ['00000000-0000-0000-0000-000000000000.png'],
      output_resolution: 1536,
    },
  });
  const request = calls[0].body.request;
  assert.equal(request.sigma_schedule, '1, 0.5, 0.2');
  assert.equal(request.num_inference_steps, 3);
  assert.equal(request.lora, 'pixel-art.safetensors');
  assert.equal(request.lora_scale, 0.8);
  assert.equal(request.use_kv_cache, false);
  assert.equal(request.output_resolution, 1536);
  assert.equal(Object.hasOwn(request, 'sigmas'), false);

  const tooMany = await client.callTool({
    name: 'forge_queue_image',
    arguments: { projectId, prompt: 'a fox', variations: 5 },
  });
  assert.equal(tooMany.isError, true);
  assert.equal(calls.length, 1, 'a rejected request queues nothing');
});

test('a failed variation stops the set and reports what was queued', async (t) => {
  const { client, calls } = await connect(t, undefined, (call) => (call === 2 ? 400 : 201));
  const response = await client.callTool({
    name: 'forge_queue_image',
    arguments: { projectId: randomUUID(), prompt: 'a fox', variations: 3 },
  });
  assert.equal(response.isError, true);
  assert.equal(calls.length, 2, 'the third render is not attempted');
  const summary = JSON.parse(response.content[0].text);
  assert.equal(summary.queued, 1);
  assert.equal(summary.requested, 3);
});

test('music MCP extends and re-synthesizes a track by project path', async (t) => {
  const { client, calls } = await connect(t);
  const projectId = randomUUID();
  await client.callTool({
    name: 'forge_extend_music',
    arguments: {
      projectId,
      source: 'music/forge-a.flac',
      add_seconds: 45,
      lyrics_addition: '[Outro]\nla',
      seed: 7,
    },
  });
  assert.deepEqual(calls[0].body, {
    type: 'music',
    projectId,
    request: {
      operation: 'extend',
      source: 'music/forge-a.flac',
      add_seconds: 45,
      lyrics_addition: '[Outro]\nla',
      seed: 7,
    },
  });
  await client.callTool({
    name: 'forge_resynth_music',
    arguments: { projectId, source: 'music/forge-a.flac', ode_steps: 16 },
  });
  assert.deepEqual(calls[1].body.request, {
    operation: 'resynth',
    source: 'music/forge-a.flac',
    ode_steps: 16,
  });
  for (const bad of [{ add_seconds: 301 }, { add_seconds: 0 }, { seed: -1 }]) {
    const rejected = await client.callTool({
      name: 'forge_extend_music',
      arguments: { projectId, source: 'music/a.flac', ...bad },
    });
    assert.equal(rejected.isError, true);
  }
  assert.equal(calls.length, 2);
});

test('sound and voice MCP forward source-sound and sub-talker options', async (t) => {
  const { client, calls } = await connect(t, (url) =>
    url.endsWith('/clips/from-asset')
      ? { reference: { id: '11111111-2222-3333-4444-555555555555.wav', kind: 'audio', size: 1 } }
      : { job: { id: 'j' } },
  );
  const projectId = randomUUID();
  const staged = await client.callTool({
    name: 'forge_stage_audio_source',
    arguments: { projectId, path: 'sfx/hit.wav' },
  });
  assert.equal(staged.isError, false);
  assert.equal(calls[0].path, `/api/projects/${projectId}/clips/from-asset`);
  assert.deepEqual(calls[0].body, { path: 'sfx/hit.wav' });
  await client.callTool({
    name: 'forge_queue_sound',
    arguments: {
      projectId,
      prompt: 'a door',
      duration: 6,
      source_audio: '11111111-2222-3333-4444-555555555555.wav',
      edit_mode: 'replace',
      inpaint_start: 2,
      inpaint_end: 4,
    },
  });
  assert.equal(calls[1].body.request.edit_mode, 'replace');
  assert.equal(calls[1].body.request.inpaint_end, 4);
  const badMode = await client.callTool({
    name: 'forge_queue_sound',
    arguments: { projectId, prompt: 'a door', edit_mode: 'loop' },
  });
  assert.equal(badMode.isError, true);
  await client.callTool({
    name: 'forge_queue_voice',
    arguments: {
      projectId,
      text: 'Hello',
      do_sample: false,
      subtalker_dosample: true,
      subtalker_temperature: 0.5,
      subtalker_top_p: 0.8,
      subtalker_top_k: 30,
    },
  });
  const voice = calls.at(-1).body.request;
  assert.equal(voice.do_sample, false);
  assert.equal(voice.subtalker_dosample, true);
  assert.deepEqual(
    [voice.subtalker_temperature, voice.subtalker_top_p, voice.subtalker_top_k],
    [0.5, 0.8, 30],
  );
  const badVoice = await client.callTool({
    name: 'forge_queue_voice',
    arguments: { projectId, text: 'Hello', subtalker_top_k: 0 },
  });
  assert.equal(badVoice.isError, true);
});

test('LoRA listing and speech latency MCP tools use the runtime routes', async (t) => {
  const { client, calls } = await connect(t, () => ({ ok: true }));
  await client.callTool({ name: 'forge_image_loras', arguments: {} });
  assert.deepEqual([calls[0].method, calls[0].path], ['GET', '/api/runtime/image-loras']);
  await client.callTool({ name: 'forge_asr_latency', arguments: {} });
  assert.deepEqual([calls[1].method, calls[1].path], ['GET', '/api/runtime/asr/latency']);
  await client.callTool({ name: 'forge_set_asr_latency', arguments: { latencyMs: 560 } });
  assert.deepEqual(
    [calls[2].method, calls[2].path, calls[2].body],
    ['POST', '/api/runtime/asr/latency', { latencyMs: 560 }],
  );
  const rejected = await client.callTool({
    name: 'forge_set_asr_latency',
    arguments: { latencyMs: 100 },
  });
  assert.equal(rejected.isError, true);
  assert.equal(calls.length, 3);
});

test('Drama 3 MCP queues validated CUDA voice settings', async (t) => {
  const { client, calls } = await connect(t);
  const projectId = randomUUID();
  const result = await client.callTool({
    name: 'forge_queue_drama3',
    arguments: {
      projectId,
      text: '[whisper] Hello',
      seed: 42,
      max_tokens: 600,
      temperature: 0.8,
      top_p: 0.9,
    },
  });
  assert.notEqual(result.isError, true);
  assert.equal(calls[0].path, '/api/runtime/jobs');
  assert.deepEqual(calls[0].body, {
    type: 'drama3',
    projectId,
    request: { text: '[whisper] Hello', seed: 42, max_tokens: 600, temperature: 0.8, top_p: 0.9 },
  });
  const invalid = await client.callTool({
    name: 'forge_queue_drama3',
    arguments: { projectId, text: 'Hello', max_tokens: 2049 },
  });
  assert.equal(invalid.isError, true);
  assert.equal(calls.length, 1);
});
