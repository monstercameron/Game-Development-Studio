import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { buildModelCatalog } from '../runtime/model-catalog.js';
import { configuredServices, inspectService } from '../runtime/catalog.js';
import { createMcpServer } from '../runtime/mcp-server.js';

test('catalog keeps service and storage observations separate and removal eligibility authoritative', () => {
  const catalog = buildModelCatalog({
    services: [{ id: 'world', status: 'reachable', modelLoaded: false }],
    chatService: { id: 'chat', status: 'unavailable', modelLoaded: null },
    inventory: {
      state: 'partial',
      entries: [
        { id: 'tts', installed: true, bytes: 50, files: 2, removable: false },
        { id: 'images', installed: true, bytes: 100, files: 4, removable: true },
      ],
    },
    managedIds: ['3d-hunyuan', 'chat'],
  });
  const models = new Map(catalog.models.map((model) => [model.id, model]));

  assert.equal(catalog.runtimeAvailable, true);
  assert.deepEqual(models.get('worldgen').service, {
    id: 'world',
    status: 'reachable',
    modelLoaded: false,
  });
  assert.equal(models.get('hy-world').service.id, 'world');
  assert.equal(models.get('chat').service.status, 'unavailable');
  assert.equal(models.get('tts').storage.removable, false);
  assert.equal(models.get('images').storage.removable, false);
  assert.equal(models.get('3d-hunyuan').storage.managed, true);
  assert.equal(models.get('3d-hunyuan').storage.installed, null);
  assert.equal(models.get('music').storage.installed, null);
  assert.equal(catalog.storageScan.state, 'partial');
});

test('service inspection treats reachable but unrecognized or non-OK responses as unverified', async (t) => {
  const server = createServer((request, response) => {
    if (request.url === '/recognized') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          engine: 'forge-world-v1',
          ready: true,
          busy: false,
        }),
      );
      return;
    }
    if (request.url === '/spoofed') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true, busy: false }));
      return;
    }
    response.writeHead(503);
    response.end('temporarily unavailable');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const port = server.address().port;
  const base = { id: 'world', name: 'World', kind: 'world', port, host: '127.0.0.1' };
  const recognized = await inspectService({ ...base, endpoint: '/recognized' });
  const spoofed = await inspectService({ ...base, endpoint: '/spoofed' });
  const failed = await inspectService({ ...base, endpoint: '/error' });

  assert.equal(recognized.status, 'reachable');
  assert.equal(recognized.modelLoaded, false);
  assert.equal(spoofed.status, 'unverified');
  assert.equal(spoofed.modelLoaded, null);
  assert.equal(failed.status, 'unverified');
  assert.equal(failed.modelLoaded, null);
  assert.equal(recognized.canUnload, false);
});

test('service configuration accepts local origins only and marks malformed overrides unavailable', () => {
  const local = configuredServices({ FORGE_IMAGE_URL: 'http://localhost:9191' }).find(
    (service) => service.id === 'images',
  );
  const remote = configuredServices({ FORGE_IMAGE_URL: 'https://example.com' }).find(
    (service) => service.id === 'images',
  );
  const withPath = configuredServices({ FORGE_IMAGE_URL: 'http://127.0.0.1:9191/api' }).find(
    (service) => service.id === 'images',
  );
  const auth = configuredServices({ FORGE_IMAGE_URL: 'http://user:pass@localhost:9191' }).find(
    (service) => service.id === 'images',
  );

  assert.equal(local.port, 9191);
  assert.equal(local.host, 'localhost');
  for (const invalid of [remote, withPath, auth]) {
    assert.equal(invalid.port, null);
    assert.match(invalid.configurationError, /local HTTP origin/);
  }
});

test('MCP rejects non-local studio origins before connecting', () => {
  for (const origin of [
    'https://127.0.0.1',
    'http://example.com',
    'http://user:pass@localhost',
    'http://localhost/api',
  ]) {
    assert.throws(() => createMcpServer(origin), /local http/);
  }
});

test('MCP tools expose read-only catalog and reject invalid barrier confirmation without a request', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const client = new Client(
    { name: 'coverage-mcp-test', version: '1.0.0' },
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

  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.get('forge_models').annotations.readOnlyHint, true);
  assert.equal(tools.get('forge_models').annotations.destructiveHint, false);

  const invalid = await client.callTool({
    name: 'forge_clear_trellis_load_barrier',
    arguments: { confirmNotLoading: false },
  });
  assert.equal(invalid.isError, true);
  assert.deepEqual(requests, []);

  const valid = await client.callTool({
    name: 'forge_clear_trellis_load_barrier',
    arguments: { confirmNotLoading: true },
  });
  assert.equal(valid.isError, false);
  assert.deepEqual(requests, [
    { method: 'POST', url: '/api/runtime/models/3d-trellis/clear-load-barrier' },
  ]);
});
