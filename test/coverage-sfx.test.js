import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSoundPreparation } from '../runtime/sound-preparation.js';

const sfxJobPath = fileURLToPath(new URL('../runtime/sfx-job.js', import.meta.url));

function nextMessage(child, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage);
      reject(new Error('Timed out waiting for SFX worker message.'));
    }, timeoutMs);
    function onMessage(message) {
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    }
    child.on('message', onMessage);
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('SFX worker reports session failures without submitting a render', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = 503;
    response.end('{}');
  });
  const baseUrl = await listen(server);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sfx-error-'));
  const child = fork(sfxJobPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.connected) {
      child.disconnect();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const failed = nextMessage(child, (message) => message.type === 'failed');
  child.send({
    job: { id: 'session-error', request: { prompt: 'Fixture only' } },
    projectFolder: directory,
    baseUrl,
  });

  assert.deepEqual(await failed, {
    jobId: 'session-error',
    type: 'failed',
    error: 'Could not obtain a Stable Audio session. No job was submitted.',
  });
  await once(child, 'exit');
  assert.deepEqual(requests, ['/api/session']);
});

test('disconnecting an SFX worker cancels polling without saving a partial output', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/session') {
      response.end(JSON.stringify({ session: 'fixture-session' }));
    } else if (request.url === '/api/generate') {
      request.resume();
      response.end(JSON.stringify({ job_id: 'fixture-job' }));
    } else if (request.url === '/api/jobs/fixture-job') {
      response.end(JSON.stringify({ status: 'rendering' }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  const baseUrl = await listen(server);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sfx-cancel-'));
  await fs.mkdir(path.join(directory, 'sfx'));
  const child = fork(sfxJobPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.connected) {
      child.disconnect();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const progress = nextMessage(
    child,
    (message) => message.type === 'progress' && message.stage === 'rendering',
  );
  child.send({
    job: { id: 'cancel-me', request: { prompt: 'Fixture only' } },
    projectFolder: directory,
    baseUrl,
  });
  assert.deepEqual(await nextMessage(child, (message) => message.type === 'accepted'), {
    jobId: 'cancel-me',
    type: 'accepted',
    remoteId: 'fixture-job',
  });
  await progress;

  const exited = once(child, 'exit');
  child.disconnect();
  await exited;

  assert.deepEqual(requests, ['/api/session', '/api/generate', '/api/jobs/fixture-job']);
  assert.deepEqual(await fs.readdir(path.join(directory, 'sfx')), []);
});

test('sound preparation does not start a load after cancellation drops its claim', async () => {
  let loads = 0;
  const prepare = createSoundPreparation({
    startEngine: async () => ({ status: 'started' }),
    loadModel: async () => {
      loads++;
      return { status: 202, body: { code: 'load_requested' } };
    },
  });

  assert.equal(
    await prepare({ health: { phase: 'idle' }, reachable: true, claimLoad: () => false }),
    null,
  );
  assert.equal(loads, 0);
});

test('sound preparation preserves an uncertain load barrier and exposes retryable load errors', async () => {
  let loads = 0;
  const prepare = createSoundPreparation({
    startEngine: async () => ({ status: 'started' }),
    loadModel: async () => {
      loads++;
      return {
        status: 503,
        body: { code: 'load_unknown', message: 'Worker outcome needs review.' },
      };
    },
  });
  const claimLoad = () => true;

  const errored = await prepare({
    health: { phase: 'error' },
    reachable: true,
    claimLoad,
  });
  assert.equal(errored.status, 'needs_attention');
  assert.equal(loads, 0);

  const retried = await prepare({
    health: { phase: 'error' },
    reachable: true,
    claimLoad,
    retryModel: true,
  });
  assert.deepEqual(retried, {
    status: 'needs_attention',
    stage: 'Stable Audio load request needs review.',
    error: 'Worker outcome needs review.',
    loadBarrier: true,
  });
  assert.equal(loads, 1);
});
