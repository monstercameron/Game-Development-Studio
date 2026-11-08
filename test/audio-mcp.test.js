import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('music MCP forwards guidance and negative style to the durable queue API', async (t) => {
  const submissions = [];
  // Fake studio: records each queue submission so the test can inspect the payload.
  const server = createServer(async (incomingRequest, serverResponse) => {
    let body = '';
    for await (const chunk of incomingRequest) {
      body += chunk;
    }
    submissions.push({ path: incomingRequest.url, body: JSON.parse(body) });
    serverResponse.writeHead(201, { 'Content-Type': 'application/json' });
    serverResponse.end(JSON.stringify({ job: { id: 'test-job' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'audio-payload-test', version: '1.0.0' },
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
  const input = {
    projectId,
    style: 'piano',
    lyrics: '[Instrumental]',
    duration_seconds: 20,
    seed: 12,
    cot: 'full',
    ode_steps: 24,
    negative: 'brass',
    cfg_scale: 3,
  };
  const response = await client.callTool({ name: 'forge_queue_music', arguments: input });
  assert.equal(response.isError, false);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].path, '/api/runtime/jobs');
  const request = { ...input };
  delete request.projectId;
  assert.deepEqual(submissions[0].body, {
    type: 'music',
    projectId,
    request: { ...request, title: '' },
  });
  const advanced = await client.callTool({
    name: 'forge_queue_music',
    arguments: {
      projectId,
      style: 'piano',
      lyrics: '[Verse] la',
      abc: 'X:1\nK:C\nCDEF|',
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      repetition_penalty: 1.1,
    },
  });
  assert.equal(advanced.isError, false);
  const sent = submissions[1].body.request;
  assert.equal(sent.abc, 'X:1\nK:C\nCDEF|');
  assert.deepEqual(
    [sent.temperature, sent.top_p, sent.top_k, sent.repetition_penalty],
    [0.8, 0.9, 40, 1.1],
  );
  assert.equal(Object.hasOwn(sent, 'seed'), false, 'an omitted seed is chosen by the queue');
  const badSampling = await client.callTool({
    name: 'forge_queue_music',
    arguments: { projectId, style: 'piano', lyrics: 'la', top_p: 0 },
  });
  assert.equal(badSampling.isError, true);
  assert.equal(submissions.length, 2);
  const rejected = await client.callTool({
    name: 'forge_queue_music',
    arguments: { ...input, cfg_scale: 21 },
  });
  assert.equal(rejected.isError, true);
  assert.equal(submissions.length, 2);
});
