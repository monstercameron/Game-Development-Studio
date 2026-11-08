import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { powerService } from '../runtime/power.js';

function createHelper() {
  const helper = new EventEmitter();
  helper.stdout = new EventEmitter();
  helper.stderr = new EventEmitter();
  helper.killCount = 0;
  helper.kill = () => {
    helper.killCount += 1;
  };
  return helper;
}

function createService(spawnProcess) {
  let handler;
  const httpServer = new EventEmitter();
  const originalExitListeners = process.listeners('exit');
  const service = powerService({ platform: 'win32', spawnProcess });
  service.configureServer({
    middlewares: {
      use: (_path, middleware) => {
        handler = middleware;
      },
    },
    httpServer,
  });

  return {
    close() {
      httpServer.emit('close');
      // powerService registers a process exit hook. Remove it so each test
      // leaves no process listener behind.
      for (const listener of process.listeners('exit')) {
        if (!originalExitListeners.includes(listener)) {
          process.removeListener('exit', listener);
        }
      }
    },
    handler: (...args) => handler(...args),
  };
}

function createRequest(method, body = '') {
  const request = Readable.from(body ? [body] : []);
  request.method = method;
  request.headers = {
    host: '127.0.0.1:5173',
    origin: 'http://127.0.0.1:5173',
    'x-forge-request': 'power',
  };
  return request;
}

function createResponse() {
  return {
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
}

test('concurrent enable requests share one helper startup', async (t) => {
  const helper = createHelper();
  let spawnCount = 0;
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const service = createService(() => {
    spawnCount += 1;
    markSpawned();
    return helper;
  });
  t.after(() => service.close());

  const firstResponse = createResponse();
  const secondResponse = createResponse();
  const first = service.handler(createRequest('POST', '{"enabled":true}'), firstResponse);
  const second = service.handler(createRequest('POST', '{"enabled":true}'), secondResponse);

  await spawned;
  assert.equal(spawnCount, 1);
  helper.stdout.emit('data', Buffer.from('READY\n'));
  await Promise.all([first, second]);

  assert.deepEqual(JSON.parse(firstResponse.body), { awake: true, error: null });
  assert.deepEqual(JSON.parse(secondResponse.body), { awake: true, error: null });
  assert.equal(spawnCount, 1);
});

test('unexpected helper exit clears awake state and preserves the failure', async (t) => {
  const helper = createHelper();
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const service = createService(() => {
    markSpawned();
    return helper;
  });
  t.after(() => service.close());

  const enableResponse = createResponse();
  const enabling = service.handler(createRequest('POST', '{"enabled":true}'), enableResponse);
  await spawned;
  helper.stdout.emit('data', Buffer.from('READY\n'));
  await enabling;
  helper.stderr.emit('data', Buffer.from('helper failed'));
  helper.emit('exit', 1);

  const statusResponse = createResponse();
  await service.handler(createRequest('GET'), statusResponse);
  assert.deepEqual(JSON.parse(statusResponse.body), {
    awake: false,
    error: 'helper failed',
  });
});

test('startup error rejects enable and a later request can start a fresh helper', async (t) => {
  const firstHelper = createHelper();
  const secondHelper = createHelper();
  let spawnCount = 0;
  let markFirstSpawned;
  const firstSpawned = new Promise((resolve) => {
    markFirstSpawned = resolve;
  });
  let markSecondSpawned;
  const secondSpawned = new Promise((resolve) => {
    markSecondSpawned = resolve;
  });
  const service = createService(() => {
    spawnCount += 1;
    if (spawnCount === 1) {
      markFirstSpawned();
    } else {
      markSecondSpawned();
    }
    return spawnCount === 1 ? firstHelper : secondHelper;
  });
  t.after(() => service.close());

  const failedResponse = createResponse();
  const failedStart = service.handler(createRequest('POST', '{"enabled":true}'), failedResponse);
  await firstSpawned;
  firstHelper.emit('error', new Error('spawn failed'));
  await failedStart;

  assert.equal(failedResponse.statusCode, 500);
  assert.deepEqual(JSON.parse(failedResponse.body), { error: 'spawn failed' });
  assert.equal(firstHelper.killCount, 1);

  const successResponse = createResponse();
  const successfulStart = service.handler(
    createRequest('POST', '{"enabled":true}'),
    successResponse,
  );
  await secondSpawned;
  secondHelper.stdout.emit('data', Buffer.from('READY\n'));
  await successfulStart;

  assert.equal(spawnCount, 2);
  assert.deepEqual(JSON.parse(successResponse.body), { awake: true, error: null });
});
