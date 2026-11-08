import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const PROJECT_ID = '0f6bd0a2-5d35-4ef9-a6a0-6a6a3f6d1f11';
const SCHEMA = {
  schema: {
    seedthree: { version: '0.1.0-alpha', commit: 'a'.repeat(40) },
    seed: { min: 1, max: 9999, default: 1 },
    budgets: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
    limits: { maxTriangles: 1500000 },
    species: [
      {
        key: 'whiteOak',
        name: 'White Oak',
        latin: 'Quercus alba',
        biome: 'temperate',
        generator: 'weber-penn',
        controls: [
          { id: 'height', name: 'Height', type: 'number', min: 4, max: 26, step: 0.5, default: 13 },
        ],
      },
    ],
  },
  measured: { whiteOak: { low: 9450, medium: 28104, high: 56208 } },
};

async function connect(t, { failJobAt = 0 } = {}) {
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
    const jobCalls = calls.filter((call) => call.path === '/api/runtime/jobs').length;
    if (req.url === '/api/vegetation/schema') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(SCHEMA));
    }
    if (req.url === '/api/runtime/jobs' && jobCalls === failJobAt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Seed must be a whole number from 1 to 9999.' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: `job-${jobCalls}` }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const client = new Client(
    { name: 'vegetation-mcp-test', version: '1.0.0' },
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

test('the vegetation tools exist, and none of them downloads anything', async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).filter((name) => name.includes('vegetation'));
  assert.deepEqual(names.sort(), [
    'forge_queue_vegetation',
    'forge_vegetation_schema',
    'forge_vegetation_status',
  ]);
  assert.ok(!tools.some((tool) => /fetch.*seedthree|seedthree.*fetch/i.test(tool.name)));
});

test('forge_vegetation_schema lists species, or opens one with its controls', async (t) => {
  const { client, calls } = await connect(t);
  const list = JSON.parse(
    (await client.callTool({ name: 'forge_vegetation_schema', arguments: {} })).content[0].text,
  );
  assert.equal(list.species[0].key, 'whiteOak');
  assert.equal(list.species[0].controlCount, 1);
  assert.deepEqual(list.species[0].measuredTriangles, { low: 9450, medium: 28104, high: 56208 });
  assert.equal(list.species[0].controls, undefined, 'the list stays small');
  const one = JSON.parse(
    (await client.callTool({ name: 'forge_vegetation_schema', arguments: { species: 'whiteOak' } }))
      .content[0].text,
  );
  assert.equal(one.species.controls[0].id, 'height');
  const unknown = await client.callTool({
    name: 'forge_vegetation_schema',
    arguments: { species: 'plastic' },
  });
  assert.equal(unknown.isError, true);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('forge_queue_vegetation queues sibling jobs with consecutive seeds', async (t) => {
  const { client, calls } = await connect(t);
  const single = await client.callTool({
    name: 'forge_queue_vegetation',
    arguments: { projectId: PROJECT_ID, species: 'whiteOak', seed: 50, params: { height: 20 } },
  });
  assert.equal(single.isError, false);
  assert.deepEqual(calls[0].body, {
    type: 'vegetation',
    projectId: PROJECT_ID,
    request: { species: 'whiteOak', budget: 'medium', params: { height: 20 }, seed: 50 },
  });
  assert.equal(calls[0].kind, 'runtime');
  calls.length = 0;
  const several = await client.callTool({
    name: 'forge_queue_vegetation',
    arguments: {
      projectId: PROJECT_ID,
      species: 'whiteOak',
      seed: 9997,
      variations: 3,
      budget: 'low',
    },
  });
  assert.equal(several.isError, false);
  const requests = calls.map((call) => call.body.request);
  assert.deepEqual(
    requests.map((request) => request.seed),
    [9997, 9998, 9999],
  );
  assert.deepEqual(
    requests.map((request) => request.variation_index),
    [1, 2, 3],
  );
  assert.equal(new Set(requests.map((request) => request.variation_group)).size, 1);
  assert.ok(requests.every((request) => request.variation_count === 3 && request.budget === 'low'));
  assert.equal(JSON.parse(several.content[0].text).queued, 3);
  calls.length = 0;
  const tooHigh = await client.callTool({
    name: 'forge_queue_vegetation',
    arguments: { projectId: PROJECT_ID, species: 'whiteOak', seed: 9999, variations: 2 },
  });
  assert.equal(tooHigh.isError, true);
  assert.equal(calls.length, 0, 'nothing is queued when the seeds would run past 9999');
});

test('a failure stops further variations and the reply says how many were queued', async (t) => {
  const { client, calls } = await connect(t, { failJobAt: 2 });
  const reply = await client.callTool({
    name: 'forge_queue_vegetation',
    arguments: { projectId: PROJECT_ID, species: 'whiteOak', seed: 5, variations: 4 },
  });
  assert.equal(reply.isError, true);
  assert.equal(calls.length, 2);
  const summary = JSON.parse(reply.content[0].text);
  assert.equal(summary.queued, 1);
  assert.equal(summary.requested, 4);
});

test('invalid input never reaches the studio', async (t) => {
  const { client, calls } = await connect(t);
  for (const bad of [
    { projectId: 'nope', species: 'whiteOak' },
    { projectId: PROJECT_ID, species: 'whiteOak', seed: 0 },
    { projectId: PROJECT_ID, species: 'whiteOak', variations: 9 },
    { projectId: PROJECT_ID, species: 'whiteOak', budget: 'ultra' },
    { projectId: PROJECT_ID, species: 'whiteOak', params: { height: 'tall' } },
  ]) {
    const reply = await client.callTool({ name: 'forge_queue_vegetation', arguments: bad });
    assert.equal(reply.isError, true);
  }
  assert.equal(calls.length, 0);
});
