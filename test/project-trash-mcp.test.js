import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('trash MCP tools forward operations and require explicit permanent-clear confirmation', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({
      path: req.url,
      body: body ? JSON.parse(body) : null,
      origin: req.headers.origin,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client(
    { name: 'trash-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: { ...process.env, FORGE_STUDIO_URL: origin },
      stderr: 'pipe',
    }),
  );
  const projectId = randomUUID(),
    trashId = randomUUID();
  for (const [name, args] of [
    ['forge_project_trash', { projectId }],
    ['forge_trash_asset', { projectId, path: 'images/example.png' }],
    ['forge_restore_asset', { projectId, trashId }],
    ['forge_clear_project_trash', { projectId, confirmation: 'permanently-delete-trash' }],
  ]) {
    assert.notEqual((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.deepEqual(
    requests.map((item) => item.path),
    ['trash', 'trash', 'restore', 'clear-trash'].map(
      (action) => `/api/projects/${projectId}/assets/${action}`,
    ),
  );
  assert.equal(requests[3].origin, origin);
  assert.deepEqual(requests[3].body, { confirmation: 'permanently-delete-trash' });
  assert.equal(
    (await client.callTool({ name: 'forge_clear_project_trash', arguments: { projectId } }))
      .isError,
    true,
  );
  assert.equal(requests.length, 4);
});
