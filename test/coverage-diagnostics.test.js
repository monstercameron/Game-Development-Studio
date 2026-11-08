import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

// diagnostics.js reads FORGE_RUNTIME_DIR when it loads, so the variable is set before the
// dynamic import and restored right after it.
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-diagnostics-'));
const previousRuntimeDir = process.env.FORGE_RUNTIME_DIR;
process.env.FORGE_RUNTIME_DIR = runtimeDir;
const { diagnosticsService } = await import('../runtime/diagnostics.js?coverage-diagnostics');
if (previousRuntimeDir === undefined) {
  delete process.env.FORGE_RUNTIME_DIR;
} else {
  process.env.FORGE_RUNTIME_DIR = previousRuntimeDir;
}

test.after(async () => {
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

function createService(t, options = {}) {
  const handlers = new Map();
  const httpServer = new EventEmitter();
  const originalCalls = [];
  const logger = Object.fromEntries(
    ['info', 'warn', 'error'].map((level) => [
      level,
      function (message, ...args) {
        originalCalls.push({ level, message, args, receiver: this });
      },
    ]),
  );
  const originals = { ...logger };
  const server = {
    middlewares: { use: (route, handler) => handlers.set(route, handler) },
    httpServer,
    config: { logger },
  };
  diagnosticsService(options).configureServer(server);
  t.after(() => httpServer.emit('close'));
  return { handlers, httpServer, logger, originals, originalCalls };
}

function createResponse() {
  const response = new EventEmitter();
  response.headers = {};
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers;
  };
  response.setHeader = (name, value) => {
    response.headers[name] = value;
  };
  response.end = (body) => {
    response.body = body;
  };
  return response;
}

function createRequest({ method = 'GET', url = '/', body = '', headers = {} } = {}) {
  const request = Readable.from(body ? [body] : []);
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

// Log lines are redacted in the logger wrapper, and closing the server must put the original
// logger back.
test('logger wrappers redact captured messages and restore original methods on close', (t) => {
  const service = createService(t);
  const receiver = { name: 'logger receiver' };
  const token = 'hf_abcdefghijklmnop';
  const args = [{ detail: 'kept for the original logger' }];
  service.logger.error.call(receiver, `request failed api_key=${token}`, ...args);
  assert.equal(service.originalCalls.length, 1);
  assert.equal(service.originalCalls[0].receiver, receiver);
  assert.deepEqual(service.originalCalls[0].args, args);
  const snapshot = createResponse();
  return service.handlers
    .get('/api/logs')(createRequest({ url: '/?source=studio' }), snapshot)
    .then(() => {
      assert.match(snapshot.body, /\[REDACTED\]/);
      assert.doesNotMatch(snapshot.body, new RegExp(token));
      service.httpServer.emit('close');
      assert.deepEqual(service.logger, service.originals);
    });
});

test('client log endpoint validates local request headers and redacts accepted messages', async (t) => {
  const service = createService(t);
  const token = 'sk-abcdefghijklmnop';
  const accepted = createResponse();
  await service.handlers.get('/api/client-logs')(
    createRequest({
      method: 'POST',
      body: JSON.stringify({ message: `client failure authorization: Bearer ${token}` }),
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'x-forge-request': 'client-log',
      },
    }),
    accepted,
  );
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(accepted.body), { ok: true });
  const snapshot = createResponse();
  await service.handlers.get('/api/logs')(createRequest({ url: '/?source=studio' }), snapshot);
  assert.match(snapshot.body, /\[REDACTED\]/);
  assert.doesNotMatch(snapshot.body, new RegExp(token));
  const rejected = createResponse();
  await service.handlers.get('/api/client-logs')(
    createRequest({ method: 'POST', body: '{"message":"no headers"}' }),
    rejected,
  );
  assert.equal(rejected.statusCode, 403);
  assert.deepEqual(JSON.parse(rejected.body), { error: 'Local studio requests only.' });
  const malformed = createResponse();
  await service.handlers.get('/api/client-logs')(
    createRequest({
      method: 'POST',
      body: '{invalid',
      headers: { host: 'localhost', origin: 'http://localhost', 'x-forge-request': 'client-log' },
    }),
    malformed,
  );
  assert.equal(malformed.statusCode, 400);
  assert.match(JSON.parse(malformed.body).error, /JSON/);
});

// A closed log view must stop receiving writes, or its polling timer would outlive the response.
test('log stream stops polling after the response closes', async (t) => {
  const logPath = path.join(runtimeDir, 'runtime-worker.log');
  await fs.writeFile(logPath, 'first line\n', 'utf8');
  const service = createService(t, { streamIntervalMs: 20 });
  const response = createResponse();
  t.after(() => response.emit('close'));
  const writes = [];
  response.write = (chunk) => {
    writes.push(chunk);
    return true;
  };
  await service.handlers.get('/api/logs')(
    createRequest({ url: '/stream?source=runtime-worker' }),
    response,
  );
  assert.equal(writes.length, 1);
  assert.match(writes[0], /first line/);
  await fs.writeFile(logPath, 'second line\n', 'utf8');
  const deadline = Date.now() + 2000;
  while (!writes.some((chunk) => /second line/.test(chunk)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(
    writes.some((chunk) => /second line/.test(chunk)),
    'updated log should be streamed',
  );
  response.emit('close');
  const writesAfterClose = writes.length;
  await fs.writeFile(logPath, 'third line\n', 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(writes.length, writesAfterClose);
});
