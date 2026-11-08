import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// MCP tools for the image-first 3D recipes and the TRELLIS.2 pipelines. A substitute studio
// records every request; nothing is rendered.
test('3D MCP tools chain background removal and text-to-3D and pass pipelines', async (t) => {
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
    { name: 'three-d-mcp-test', version: '1.0.0' },
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
  const projectId = randomUUID(),
    reference = `${randomUUID()}.png`;
  const call = (name, args) => client.callTool({ name, arguments: args });
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('forge_queue_text_to_3d'));

  // A pipeline is forwarded only when chosen, so the default request is unchanged.
  assert.notEqual(
    (await call('forge_queue_trellis', { projectId, reference, pipeline: '1024_cascade' })).isError,
    true,
  );
  assert.equal(requests.at(-1).path, '/api/runtime/jobs');
  assert.equal(requests.at(-1).body.request.pipeline, '1024_cascade');
  assert.equal(
    (await call('forge_queue_trellis', { projectId, reference, pipeline: '2048' })).isError,
    true,
  );

  // removeBackground queues a SAM 3.1 cutout and a 3D render chained to it, in one request.
  assert.notEqual(
    (
      await call('forge_queue_trellis', {
        projectId,
        reference,
        seed: 3,
        pipeline: '1024',
        removeBackground: { prompt: 'the dragon' },
      })
    ).isError,
    true,
  );
  let chain = requests.at(-1);
  assert.equal(chain.path, '/api/runtime/jobs/chain');
  assert.deepEqual(chain.body.steps[0], {
    type: 'segmentation',
    projectId,
    request: {
      prompt: 'the dragon',
      references: [reference],
      output: 'transparent',
      confidence: 0.5,
    },
  });
  assert.equal(chain.body.steps[1].type, 'trellis');
  assert.deepEqual(chain.body.steps[1].request.references, []);
  assert.deepEqual(chain.body.steps[1].request.referenceFrom, { step: 0 });
  assert.equal(chain.body.steps[1].request.pipeline, '1024');
  assert.equal(chain.body.steps[1].request.seed, 3);

  assert.notEqual(
    (
      await call('forge_queue_hunyuan_shape', {
        projectId,
        reference,
        texture: true,
        removeBackground: {},
      })
    ).isError,
    true,
  );
  chain = requests.at(-1);
  assert.equal(chain.path, '/api/runtime/jobs/chain');
  assert.equal(chain.body.steps[0].request.prompt, 'the main object');
  assert.equal(chain.body.steps[1].type, '3d');
  assert.equal(chain.body.steps[1].request.texture, true);
  assert.equal(chain.body.steps[1].request.model, 'hunyuan');

  // Without removeBackground the Hunyuan tool still sends one plain job.
  await call('forge_queue_hunyuan_shape', { projectId, reference });
  assert.equal(requests.at(-1).path, '/api/runtime/jobs');
  assert.deepEqual(requests.at(-1).body.request.references, [reference]);

  // Text to 3D: a transparent 1024 square Qwen image at 25 steps, then the chosen 3D model.
  assert.notEqual(
    (await call('forge_queue_text_to_3d', { projectId, prompt: 'a wooden barrel' })).isError,
    true,
  );
  chain = requests.at(-1);
  assert.equal(chain.path, '/api/runtime/jobs/chain');
  assert.deepEqual(chain.body.steps[0], {
    type: 'images',
    projectId,
    request: {
      prompt: 'a wooden barrel',
      width: 1024,
      height: 1024,
      num_inference_steps: 25,
      references: [],
      transparent: true,
    },
  });
  assert.equal(chain.body.steps[1].type, '3d');
  assert.deepEqual(chain.body.steps[1].request, {
    model: 'hunyuan',
    references: [],
    referenceFrom: { step: 0 },
  });

  assert.notEqual(
    (
      await call('forge_queue_text_to_3d', {
        projectId,
        prompt: 'a lantern',
        model: 'trellis',
        image: { steps: 30, seed: 11 },
        options: { seed: 9, pipeline: '1024', target_faces: 50000 },
      })
    ).isError,
    true,
  );
  chain = requests.at(-1);
  assert.equal(chain.body.steps[0].request.num_inference_steps, 30);
  assert.equal(chain.body.steps[0].request.seed, 11);
  assert.deepEqual(chain.body.steps[1].request, {
    model: 'trellis',
    seed: 9,
    pipeline: '1024',
    target_faces: 50000,
    references: [],
    referenceFrom: { step: 0 },
  });

  // The converter tool accepts the 3D formats.
  for (const format of ['glb', 'gltf', 'obj', 'ply', 'stl']) {
    const response = await call('forge_convert_asset', {
      projectId,
      path: '3d/forge-model.glb',
      format,
    });
    assert.notEqual(response.isError, true);
    assert.equal(requests.at(-1).path, `/api/projects/${projectId}/assets/convert`);
    assert.equal(requests.at(-1).body.format, format);
  }
  assert.equal(
    (await call('forge_convert_asset', { projectId, path: '3d/a.glb', format: 'fbx' })).isError,
    true,
  );

  // Input limits are enforced before anything is sent.
  const sent = requests.length;
  for (const bad of [
    { projectId, prompt: '' },
    { projectId, prompt: 'x', model: 'other' },
    { projectId, prompt: 'x', image: { steps: 0 } },
    { projectId, prompt: 'x', image: { width: 1000 } },
  ]) {
    assert.equal((await call('forge_queue_text_to_3d', bad)).isError, true);
  }
  assert.equal(requests.length, sent);
});
