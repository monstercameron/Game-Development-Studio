import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import express from 'express';
import { settingsService } from '../runtime/settings-service.js';

async function connect(t, studioPort) {
  const client = new Client(
    { name: 'settings-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: { ...process.env, FORGE_STUDIO_URL: `http://127.0.0.1:${studioPort}` },
      stderr: 'pipe',
    }),
  );
  return client;
}

async function fakeStudio(t, requests) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    requests.push({
      method: req.method,
      path: req.url,
      body: raw ? JSON.parse(raw) : null,
      headers: req.headers,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return connect(t, server.address().port);
}

const text = (result) => result.content.map((part) => part.text).join('');

test('the settings tools are registered with accurate annotations', async (t) => {
  const client = await fakeStudio(t, []);
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  const list = tools.get('forge_settings_list');
  const set = tools.get('forge_settings_set');
  const reset = tools.get('forge_settings_reset');
  assert.ok(list && set && reset);
  assert.equal(list.annotations.readOnlyHint, true);
  assert.equal(set.annotations.readOnlyHint, false);
  assert.equal(set.annotations.destructiveHint, false);
  assert.equal(reset.annotations.readOnlyHint, false);
  assert.deepEqual(list.inputSchema.properties.group.enum, [
    'engines',
    'memory',
    'queue',
    'speech',
    'ai',
    'interface',
    'app',
  ]);
  assert.equal(set.inputSchema.properties.changes.maxItems, 20);
  assert.match(set.description, /locked by an environment variable/);
  assert.match(set.description, /never pass secrets/i);
  // The older tools keep working next to the registry.
  assert.ok(tools.has('forge_set_keep_awake'));
  assert.ok(tools.has('forge_set_asr_latency'));
  assert.ok(tools.has('forge_asr_latency'));
  assert.ok(tools.has('forge_power_status'));
});

test('the tools send the settings requests the studio expects', async (t) => {
  const requests = [];
  const client = await fakeStudio(t, requests);
  await client.callTool({ name: 'forge_settings_list', arguments: {} });
  assert.deepEqual([requests.at(-1).method, requests.at(-1).path], ['GET', '/api/settings']);
  await client.callTool({ name: 'forge_settings_list', arguments: { group: 'memory' } });
  assert.equal(requests.at(-1).path, '/api/settings?group=memory');

  await client.callTool({
    name: 'forge_settings_set',
    arguments: { key: 'engines.autoStart.trellis', value: false },
  });
  const single = requests.at(-1);
  assert.equal(single.method, 'POST');
  assert.equal(single.path, '/api/settings');
  assert.deepEqual(single.body, {
    changes: [{ key: 'engines.autoStart.trellis', value: false }],
    via: 'mcp',
  });
  assert.equal(single.headers['x-forge-request'], 'settings');
  assert.match(single.headers.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  await client.callTool({
    name: 'forge_settings_set',
    arguments: {
      changes: [
        { key: 'memory.hostPolicy', value: 'strict' },
        { key: 'vegetation.timeoutMs', value: 30000 },
      ],
    },
  });
  assert.deepEqual(requests.at(-1).body.changes.length, 2);

  await client.callTool({ name: 'forge_settings_reset', arguments: { key: 'memory.hostPolicy' } });
  assert.equal(requests.at(-1).path, '/api/settings/reset');
  assert.deepEqual(requests.at(-1).body, { key: 'memory.hostPolicy', via: 'mcp' });
  await client.callTool({ name: 'forge_settings_reset', arguments: { group: 'engines' } });
  assert.deepEqual(requests.at(-1).body, { group: 'engines', via: 'mcp' });
});

test('malformed tool calls are refused before any request is sent', async (t) => {
  const requests = [];
  const client = await fakeStudio(t, requests);
  const calls = [
    ['forge_settings_set', {}],
    ['forge_settings_set', { key: 'queue.chainUnload' }],
    ['forge_settings_set', { value: true }],
    [
      'forge_settings_set',
      {
        key: 'queue.chainUnload',
        value: true,
        changes: [{ key: 'queue.chainUnload', value: true }],
      },
    ],
    ['forge_settings_set', { changes: [] }],
    [
      'forge_settings_set',
      { changes: Array.from({ length: 21 }, () => ({ key: 'queue.chainUnload', value: true })) },
    ],
    ['forge_settings_set', { changes: [{ key: 'queue.chainUnload', value: true, extra: 1 }] }],
    ['forge_settings_set', { key: '../etc/passwd', value: true }],
    ['forge_settings_set', { key: 'queue.chainUnload', value: { nested: true } }],
    ['forge_settings_set', { key: 'queue.chainUnload', value: 'x'.repeat(201) }],
    ['forge_settings_reset', {}],
    ['forge_settings_reset', { key: 'queue.chainUnload', group: 'queue' }],
    ['forge_settings_reset', { group: 'everything' }],
    ['forge_settings_list', { group: 'secrets' }],
  ];
  for (const [name, args] of calls) {
    const result = await client
      .callTool({ name, arguments: args })
      .catch((error) => ({ isError: true, error }));
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
  assert.equal(requests.length, 0, 'no request reached the studio');
});

test('the tools work end to end against the real settings routes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-settings-'));
  const service = settingsService({
    runtimeDir: directory,
    env: { FORGE_CHAIN_UNLOAD: '0' },
    power: { get: () => false, set: async () => {} },
  });
  const app = express();
  const server = createServer(app);
  service.configureServer({ middlewares: app, httpServer: server, config: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = await connect(t, server.address().port);
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const listed = JSON.parse(
    text(await client.callTool({ name: 'forge_settings_list', arguments: {} })),
  );
  const trellis = listed.settings.find((item) => item.key === 'engines.autoStart.trellis');
  assert.deepEqual(
    [trellis.value, trellis.default, trellis.source, trellis.effect, trellis.locked],
    [true, true, 'default', 'next-job', false],
  );
  const chain = listed.settings.find((item) => item.key === 'queue.chainUnload');
  assert.deepEqual(
    [chain.locked, chain.lockedBy, chain.source],
    [true, 'FORGE_CHAIN_UNLOAD', 'environment'],
  );
  assert.ok(listed.settings.every((item) => !/secret|token|password/i.test(item.key)));

  const changed = await client.callTool({
    name: 'forge_settings_set',
    arguments: { key: 'engines.autoStart.trellis', value: false },
  });
  assert.notEqual(changed.isError, true);
  const outcome = JSON.parse(text(changed));
  assert.deepEqual(outcome.results[0], {
    key: 'engines.autoStart.trellis',
    action: 'set',
    changed: true,
    old: true,
    new: false,
    effect: 'next-job',
    restartRequired: false,
    note: '',
  });
  assert.equal(outcome.recentChanges[0].via, 'mcp');

  const locked = await client.callTool({
    name: 'forge_settings_set',
    arguments: { key: 'queue.chainUnload', value: true },
  });
  assert.equal(locked.isError, true);
  assert.match(text(locked), /FORGE_CHAIN_UNLOAD/);

  const batch = await client.callTool({
    name: 'forge_settings_set',
    arguments: {
      changes: [
        { key: 'memory.hostPolicy', value: 'strict' },
        { key: 'asr.latencyMs', value: 7 },
      ],
    },
  });
  assert.equal(batch.isError, true);
  const afterBatch = JSON.parse(
    text(await client.callTool({ name: 'forge_settings_list', arguments: { group: 'memory' } })),
  );
  assert.equal(
    afterBatch.settings.find((item) => item.key === 'memory.hostPolicy').value,
    'soft',
    'the valid half of a refused batch was not applied',
  );

  const reset = await client.callTool({
    name: 'forge_settings_reset',
    arguments: { key: 'engines.autoStart.trellis' },
  });
  assert.equal(JSON.parse(text(reset)).results[0].new, true);
});
