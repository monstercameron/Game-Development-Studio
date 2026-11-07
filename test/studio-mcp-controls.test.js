import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { chatService } from '../chat-service.js';
import { createMcpServer } from '../runtime/mcp-server.js';

async function connect(t, origin) {
  const client = new Client(
    { name: 'studio-mcp-controls-test', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
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
  return client;
}

test('MCP exposes guarded queue, power, asset and engine controls with the correct routes', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({
      path: req.url,
      method: req.method,
      kind: req.headers['x-forge-request'],
      origin: req.headers.origin,
      body: body ? JSON.parse(body) : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = await connect(t, origin);
  const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.get('forge_force_stop_model').annotations.destructiveHint, true);
  assert.equal(tools.get('forge_power_status').annotations.readOnlyHint, true);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const id = randomUUID();
  for (const [name, args] of [
    ['forge_force_stop_model', { id: 'world', confirmation: 'no' }],
    ['forge_clear_waiting_jobs', { confirmation: 'no' }],
    ['forge_resolve_interrupted_job', { id, confirmRemoteNotRunning: false }],
    ['forge_load_chat_model', { contextSize: 1234 }],
  ]) {
    assert.equal((await call(name, args)).isError, true);
  }
  assert.equal(requests.length, 0);

  const cases = [
    [
      'forge_force_stop_model',
      { id: 'world', confirmation: 'force-stop-engine' },
      '/api/runtime/models/world/force-stop',
      'runtime',
    ],
    ['forge_close_model', { id: 'video' }, '/api/runtime/models/video/close', 'runtime'],
    [
      'forge_clear_waiting_jobs',
      { confirmation: 'cancel-waiting-renders' },
      '/api/runtime/jobs/clear-waiting',
      'runtime',
    ],
    [
      'forge_resolve_interrupted_job',
      { id, confirmRemoteNotRunning: true },
      `/api/runtime/jobs/${id}/resolve`,
      'runtime',
    ],
    [
      'forge_load_chat_model',
      { contextSize: 8192, speculative: false },
      '/api/runtime/models/chat/load',
      'runtime',
    ],
    ['forge_set_keep_awake', { enabled: true }, '/api/power', 'power'],
    [
      'forge_convert_asset',
      { projectId: id, path: 'images/a.png', format: 'webp' },
      `/api/projects/${id}/assets/convert`,
      'project',
    ],
    [
      'forge_save_text_asset',
      { projectId: id, kind: 'chat', content: 'hello' },
      `/api/projects/${id}/assets/create-text`,
      'project',
    ],
  ];
  for (const [name, args, route, kind] of cases) {
    assert.notEqual((await call(name, args)).isError, true, name);
    const request = requests.at(-1);
    assert.equal(request.path, route);
    assert.equal(request.kind, kind);
    assert.equal(request.origin, origin);
  }
  assert.deepEqual(requests.at(-2).body, {
    path: 'images/a.png',
    format: 'webp',
    quality: 90,
    background: '#ffffff',
  });
  const estimate = JSON.parse(
    (await call('forge_estimate_chat_memory', { contextSize: 8192 })).content[0].text,
  );
  assert.equal(estimate.contextSize, 8192);
  assert.ok(estimate.contextMiB > 0);
});

test('MCP chat uses the real chat bridge and reports a completed stream and structured settings', async (t) => {
  let sent;
  let complete = true;
  const app = express();
  chatService({
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith('/models')) {
        return Response.json({ data: [{ id: 'qwen' }] });
      }
      sent = JSON.parse(options.body);
      const events = [
        'data: {"choices":[{"delta":{"content":"hello "}}]}\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"world"}}],"usage":{"completion_tokens":2}}\r\n\r\n',
        ...(complete ? ['data: [DONE]\r\n\r\n'] : []),
      ];
      return new Response(events.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  }).configureServer({ middlewares: app });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = await connect(t, `http://127.0.0.1:${server.address().port}`);
  const models = await client.callTool({ name: 'forge_chat_models', arguments: {} });
  assert.deepEqual(JSON.parse(models.content[0].text).models, ['qwen']);
  const args = {
    model: 'qwen',
    messages: [{ role: 'user', content: 'hello' }],
    format: 'schema',
    schema: { type: 'object' },
    effort: 'high',
    maxTokens: 128,
  };
  const result = await client.callTool({ name: 'forge_chat', arguments: args });
  assert.notEqual(result.isError, true);
  const response = JSON.parse(result.content[0].text);
  assert.equal(response.text, 'hello world');
  assert.equal(response.usage.completion_tokens, 2);
  assert.ok(response.firstTokenMs >= 0);
  assert.equal(sent.max_tokens, 128);
  assert.equal(sent.reasoning_effort, 'high');
  assert.deepEqual(sent.response_format.json_schema.schema, { type: 'object' });
  complete = false;
  const interrupted = await client.callTool({ name: 'forge_chat', arguments: args });
  assert.equal(interrupted.isError, true);
  assert.match(interrupted.content[0].text, /before completion/);
});

test('MCP queue forecast uses runtime estimates and reports blocked queues honestly', async (t) => {
  const id = randomUUID();
  const projectId = randomUUID();
  let status = 'queued';
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/runtime/jobs') {
      res.end(
        JSON.stringify({
          jobs: [{ id, projectId, type: 'sfx', status, request: { duration: 5, steps: 8 } }],
        }),
      );
    } else {
      res.end(JSON.stringify({ available: true, typicalSeconds: 12, sampleCount: 3 }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = await connect(t, `http://127.0.0.1:${server.address().port}`);
  const forecast = async () =>
    JSON.parse(
      (await client.callTool({ name: 'forge_estimate_queue', arguments: {} })).content[0].text,
    );
  assert.equal((await forecast()).seconds, 12);
  status = 'waiting_memory';
  const blocked = await forecast();
  assert.equal(blocked.seconds, null);
  assert.equal(blocked.blocked, true);
});

test('Streamable HTTP exposes the same controls under the current MCP protocol', async (t) => {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handler = createMcpHandler(() => createMcpServer(origin), { legacy: 'reject' });
  app.all('/mcp', toNodeHandler(handler, { maxRequestBodySize: 256 * 1024 }));
  t.after(async () => {
    await handler.close();
    server.close();
  });
  const client = new Client(
    { name: 'http-controls-test', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of [
    'forge_chat',
    'forge_convert_asset',
    'forge_force_stop_model',
    'forge_view_thumbnail',
  ]) {
    assert.ok(names.has(name), name);
  }
  const result = await client.callTool({
    name: 'forge_estimate_chat_memory',
    arguments: { contextSize: 4096 },
  });
  assert.equal(JSON.parse(result.content[0].text).contextSize, 4096);
});
