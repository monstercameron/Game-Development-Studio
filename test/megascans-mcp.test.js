import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const LISTING_ID = '854ffc09-e07f-45c2-9569-37cb7c4ab9c2';
const PROJECT_ID = '0f6bd0a2-5d35-4ef9-a6a0-6a6a3f6d1f11';
const IMPORT_ID = '3e2d4d09-65f0-4f1a-b81b-c5ac01920a04';

async function connect(t) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    calls.push({
      method: req.method,
      path: req.url,
      kind: req.headers['x-forge-request'],
      body: body ? JSON.parse(body) : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'megascans-mcp-test', version: '1.0.0' },
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

test('Megascans MCP tools use only local routes and offer no download tool', async (t) => {
  const { client, calls } = await connect(t);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).filter((name) => name.includes('megascans'));
  assert.deepEqual(names.sort(), [
    'forge_megascans_add_listing',
    'forge_megascans_download',
    'forge_megascans_downloads',
    'forge_megascans_listing',
    'forge_megascans_refresh',
    'forge_megascans_scan',
    'forge_megascans_search',
  ]);

  await client.callTool({
    name: 'forge_megascans_search',
    arguments: { query: 'wood crate', tag: 'wood', sort: 'title', page: 2 },
  });
  assert.equal(calls[0].method, 'GET');
  const search = new URL(calls[0].path, 'http://127.0.0.1');
  assert.equal(search.pathname, '/api/megascans/listings');
  assert.equal(search.searchParams.get('q'), 'wood crate');
  assert.equal(search.searchParams.get('page'), '2');

  await client.callTool({ name: 'forge_megascans_listing', arguments: { id: LISTING_ID } });
  assert.equal(calls[1].path, `/api/megascans/listings/${LISTING_ID}`);

  const added = await client.callTool({
    name: 'forge_megascans_add_listing',
    arguments: { url: `https://www.fab.com/listings/${LISTING_ID}`, title: 'Old Crate' },
  });
  assert.equal(added.isError, false);
  assert.equal(calls[2].method, 'POST');
  assert.equal(calls[2].kind, 'megascans');
  assert.equal(calls[2].body.title, 'Old Crate');

  await client.callTool({ name: 'forge_megascans_downloads', arguments: {} });
  await client.callTool({ name: 'forge_megascans_downloads', arguments: { id: IMPORT_ID } });
  assert.equal(calls[3].path, '/api/megascans/imports');
  assert.equal(calls[4].path, `/api/megascans/imports/${IMPORT_ID}`);

  await client.callTool({ name: 'forge_megascans_refresh', arguments: {} });
  assert.equal(calls[5].path, '/api/megascans/refresh');
  assert.equal(calls[5].kind, 'megascans');
  await client.callTool({ name: 'forge_megascans_refresh', arguments: { id: LISTING_ID } });
  assert.equal(calls[6].path, `/api/megascans/listings/${LISTING_ID}/refresh`);
  await client.callTool({ name: 'forge_megascans_scan', arguments: { action: 'status' } });
  await client.callTool({ name: 'forge_megascans_scan', arguments: { action: 'resume' } });
  assert.equal(calls[7].path, '/api/megascans/scan');
  assert.deepEqual(calls[8].body, { action: 'resume' });
  calls.length = 5;

  const queued = await client.callTool({
    name: 'forge_megascans_download',
    arguments: { projectId: PROJECT_ID, listingId: LISTING_ID, format: 'glb', quality: 'mid' },
  });
  assert.equal(queued.isError, false);
  assert.equal(calls[5].method, 'POST');
  assert.equal(calls[5].path, '/api/megascans/downloads');
  assert.equal(calls[5].kind, 'megascans');
  assert.deepEqual(calls[5].body, {
    project: PROJECT_ID,
    listing: LISTING_ID,
    format: 'glb',
    quality: 'mid',
    confirmLarge: false,
  });
  const noConfirmTool = tools
    .map((tool) => tool.name)
    .filter((name) => /confirm|accept|eula/i.test(name));
  assert.deepEqual(noConfirmTool, [], 'agents cannot confirm the license agreement');
  calls.length = 5;

  const rejected = await client.callTool({
    name: 'forge_megascans_listing',
    arguments: { id: '../../etc/passwd' },
  });
  assert.equal(rejected.isError, true);
  assert.equal(calls.length, 5, 'invalid input never reaches the studio');
});
