import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function connectToFakeStudio(t, requests) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'engine-control-mcp-test', version: '1.0.0' },
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
  return client;
}

test('forge_start_engine starts exactly one engine and rejects unsafe ids', async (t) => {
  const requests = [];
  const client = await connectToFakeStudio(t, requests);
  const tools = (await client.listTools()).tools;
  const startOne = tools.find((tool) => tool.name === 'forge_start_engine');
  assert.ok(startOne, 'the single-engine start tool is registered');
  assert.ok(
    tools.some((tool) => tool.name === 'forge_start_engines'),
    'the start-all tool remains',
  );
  assert.match(startOne.description, /ONE Forge-managed engine/);

  await client.callTool({ name: 'forge_start_engine', arguments: { id: 'motion-hy' } });
  assert.deepEqual(requests.at(-1), { path: '/api/runtime/engines/motion-hy/start', body: {} });

  const before = requests.length;
  for (const id of ['../x', 'Motion-HY', 'a/b', '', '-bad', 'x'.repeat(41)]) {
    const result = await client
      .callTool({ name: 'forge_start_engine', arguments: { id } })
      .catch((error) => ({ isError: true, error }));
    assert.equal(result.isError, true, `id "${id}" is refused before any request`);
  }
  assert.equal(requests.length, before, 'no request was sent for a refused id');
});

test('forge_estimate_render accepts the vegetation job type', async (t) => {
  const requests = [];
  const client = await connectToFakeStudio(t, requests);
  const tools = (await client.listTools()).tools;
  const estimate = tools.find((tool) => tool.name === 'forge_estimate_render');
  assert.ok(estimate.inputSchema.properties.type.enum.includes('vegetation'));
  await client.callTool({
    name: 'forge_estimate_render',
    arguments: { type: 'vegetation', projectId: randomUUID(), request: { species: 'whiteOak' } },
  });
  assert.equal(requests.at(-1).path, '/api/runtime/estimate');
  assert.equal(requests.at(-1).body.type, 'vegetation');
});
