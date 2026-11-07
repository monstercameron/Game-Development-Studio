import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { diagnosticsService } from '../diagnostics.js';

test('log stream remains open after the GET request completes and closes with response', async () => {
  const handlers = new Map();
  const httpServer = new EventEmitter();
  httpServer.address = () => ({ port: 5173 });
  const logger = { info() {}, warn() {}, error() {} };
  diagnosticsService({ streamIntervalMs: 15 }).configureServer({
    middlewares: { use: (route, handler) => handlers.set(route, handler) },
    httpServer,
    config: { logger },
  });

  const request = new EventEmitter();
  request.method = 'GET';
  request.url = '/stream?source=studio';
  const response = new EventEmitter();
  const writes = [];
  response.writeHead = () => {};
  response.write = (chunk) => {
    writes.push(chunk);
    return true;
  };

  try {
    await handlers.get('/api/logs')(request, response);
    assert.equal(writes.length, 1);
    request.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(writes.length > 1);

    response.emit('close');
    const writesAfterClose = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writes.length, writesAfterClose);
  } finally {
    response.emit('close');
    httpServer.emit('close');
  }
});
