// forge_logs_query and forge_logs_summary over the real stdio MCP bridge (runtime/mcp.js),
// against a loopback host running the real logs service with a temporary runtime folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import express from 'express';
import { configureAppLog, createLogger, resetAppLogForTests } from '../runtime/app-log.js';
import { logsService } from '../runtime/logs-service.js';

async function connect(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-logs-'));
  resetAppLogForTests();
  configureAppLog({ runtimeDirectory: directory, sink: 'spool' });
  const app = express();
  const httpServer = http.createServer(app);
  const service = logsService({
    runtimeDir: directory,
    ingestIntervalMs: 0,
    retentionIntervalMs: 0,
  });
  service.configureServer({ middlewares: app, httpServer });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const client = new Client(
    { name: 'logs-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => httpServer.close(resolve));
    service.close();
    resetAppLogForTests();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: {
        ...process.env,
        FORGE_STUDIO_URL: `http://127.0.0.1:${httpServer.address().port}`,
      },
      stderr: 'pipe',
    }),
  );
  return client;
}

const text = (result) => result.content.map((part) => part.text).join('\n');

test('forge_logs_query and forge_logs_summary read the structured log', async (t) => {
  const client = await connect(t);
  const tools = (await client.listTools()).tools;
  const query = tools.find((tool) => tool.name === 'forge_logs_query');
  const summary = tools.find((tool) => tool.name === 'forge_logs_summary');
  assert.ok(query && summary);
  assert.equal(query.annotations.readOnlyHint, true);
  assert.ok(
    tools.some((tool) => tool.name === 'forge_logs'),
    'the file-log tool remains',
  );

  const log = createLogger('queue');
  log.info('job.state.changed', { jobId: 'job-1', from: 'queued', to: 'running' });
  log.warn('queue.admission.waited', { jobId: 'job-2', reason: 'waiting_memory' });
  createLogger('engine').error('engine.start.failed', { engineId: 'images' });

  // The service itself logs log.service.started on attach, so there are four records.
  const all = text(await client.callTool({ name: 'forge_logs_query', arguments: {} }));
  assert.match(all, /4 record\(s\)/);
  assert.match(all, /ERROR engine engine\.start\.failed/);
  const filtered = text(
    await client.callTool({
      name: 'forge_logs_query',
      arguments: { components: ['queue'], level: 'warn', sinceMinutes: 5 },
    }),
  );
  assert.match(filtered, /1 record\(s\)/);
  assert.match(filtered, /job=job-2/);
  const paged = text(await client.callTool({ name: 'forge_logs_query', arguments: { limit: 1 } }));
  assert.match(paged, /older: cursor=\d+_\d+/);

  const refused = await client
    .callTool({ name: 'forge_logs_query', arguments: { components: ['nope'] } })
    .catch((error) => ({ isError: true, error }));
  assert.equal(refused.isError, true);

  const stats = JSON.parse(
    text(await client.callTool({ name: 'forge_logs_summary', arguments: {} })),
  );
  assert.equal(stats.rows, 4);
  assert.equal(stats.byLevel.error, 1);
  assert.ok(stats.fileBytes > 0);
});
