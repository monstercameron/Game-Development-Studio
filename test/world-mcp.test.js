import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildModelCatalog } from '../runtime/model-catalog.js';

test('world catalog entries share the world worker status', () => {
  const catalog = buildModelCatalog({ services: [{ id: 'world', status: 'reachable' }] });
  for (const id of ['worldgen', 'hy-world']) {
    assert.equal(catalog.models.find((model) => model.id === id).service.id, 'world');
  }
});
test('MCP queues a world with its selected model and staged references', async (t) => {
  let request;
  const server = createServer(async (req, res) => {
    let rawBody = '';
    for await (const chunk of req) {
      rawBody += chunk;
    }
    request = { path: req.url, body: JSON.parse(rawBody) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'world-mcp-test', version: '1.0.0' },
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
  const reference = `${randomUUID()}.png`;
  const result = await client.callTool({
    name: 'forge_queue_world',
    arguments: {
      projectId,
      model: 'hy-world',
      mode: 'image',
      resolution: 518,
      references: [reference],
    },
  });
  assert.notEqual(result.isError, true);
  assert.equal(request.path, '/api/runtime/jobs');
  assert.equal(request.body.type, 'world');
  assert.equal(request.body.request.model, 'hy-world');
  assert.deepEqual(request.body.request.references, [reference]);
  // The seed is optional so Forge can pick and record a random one.
  assert.equal('seed' in request.body.request, false);

  const tools = await client.listTools();
  const schema = tools.tools.find((tool) => tool.name === 'forge_queue_world').inputSchema;
  for (const option of [
    'guidance',
    'save_panorama',
    'splat_limit',
    'remove_sky',
    'confidence_percentile',
  ]) {
    assert.ok(schema.properties[option], `${option} is offered`);
    assert.equal(schema.required.includes(option), false);
  }
  assert.equal(schema.required.includes('seed'), false);
  assert.deepEqual(schema.properties.output.enum, ['splat', 'mesh', 'glb']);
  const tuned = await client.callTool({
    name: 'forge_queue_world',
    arguments: {
      projectId,
      model: 'worldgen',
      mode: 'text',
      prompt: 'a harbour',
      output: 'glb',
      resolution: 1024,
      guidance: 4,
      save_panorama: true,
    },
  });
  assert.notEqual(tuned.isError, true);
  assert.equal(request.body.request.guidance, 4);
  assert.equal(request.body.request.save_panorama, true);
  assert.equal(request.body.request.output, 'glb');
});
