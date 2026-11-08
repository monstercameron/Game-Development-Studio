import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { diagnosticsService } from '../runtime/diagnostics.js';

test('a slow log-stream client does not accumulate snapshots and resumes after draining', async (t) => {
  const handlers = new Map();
  const httpServer = new EventEmitter();
  httpServer.address = () => ({ port: 5173 });
  const logger = { info() {}, warn() {}, error() {} };
  diagnosticsService({ streamIntervalMs: 25 }).configureServer({
    middlewares: { use: (path, handler) => handlers.set(path, handler) },
    httpServer,
    config: { logger },
  });
  const request = new EventEmitter();
  request.method = 'GET';
  request.url = '/stream?source=studio';
  const writes = [];
  const response = {
    writableNeedDrain: false,
    writeHead() {},
    write(data) {
      writes.push(data);
      this.writableNeedDrain = true;
      return false;
    },
  };
  t.after(() => {
    request.emit('close');
    httpServer.emit('close');
  });
  await handlers.get('/api/logs')(request, response);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /event: logs/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes.length, 1);
  response.writableNeedDrain = false;
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(writes.length, 2);
  assert.match(writes[1], /keepalive/);
});
