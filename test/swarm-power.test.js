import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLogger } from '../runtime/app-log.js';
import { powerService } from '../power.js';

test('server shutdown during helper startup does not leave keep-awake active', async () => {
  // The first emitted record installs the logger's own process exit hook. Emit one before the
  // listener snapshot so the assertion below counts only the keep-awake service's listener.
  createLogger('power').info('power.test.warmup');
  const helper = new EventEmitter();
  helper.stdout = new EventEmitter();
  helper.stderr = new EventEmitter();
  helper.killCount = 0;
  helper.kill = () => {
    helper.killCount += 1;
  };
  let handler;
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const httpServer = new EventEmitter();
  const exitListeners = process.listeners('exit');
  const service = powerService({
    platform: 'win32',
    spawnProcess: () => {
      markSpawned();
      return helper;
    },
  });
  service.configureServer({
    middlewares: {
      use: (_path, next) => {
        handler = next;
      },
    },
    httpServer,
  });

  const request = Readable.from(['{"enabled":true}']);
  request.method = 'POST';
  request.headers = {
    host: '127.0.0.1:5173',
    origin: 'http://127.0.0.1:5173',
    'x-forge-request': 'power',
  };
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
  const pending = handler(request, response);
  await spawned;
  httpServer.emit('close');
  helper.stdout.emit('data', Buffer.from('READY\n'));
  await pending;

  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).awake, undefined);
  assert.equal(helper.killCount, 1);
  assert.equal(
    process.listeners('exit').filter((listener) => !exitListeners.includes(listener)).length,
    1,
  );
  for (const listener of process.listeners('exit')) {
    if (!exitListeners.includes(listener)) {
      process.removeListener('exit', listener);
    }
  }
});
