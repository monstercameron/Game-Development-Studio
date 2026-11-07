import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { HostSupervisor } from '../runtime/host-supervisor.js';

async function waitFor(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Timed out waiting for HTTP supervisor');
}

test('HTTP supervisor recovers from spawn errors and a host crash while retaining engine access', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-host-retry-'));
  let attempts = 0,
    stopped = 0;
  const forkHost = (url, args, options) => {
    attempts++;
    if (attempts === 1) {
      throw Error('Simulated resource exhaustion');
    }
    if (attempts === 2) {
      return fork(url, args, { ...options, execPath: path.join(dir, 'missing-node-executable') });
    }
    return fork(url, args, options);
  };
  const engines = { status: () => ({ images: { managed: true } }) };
  const supervisor = new HostSupervisor({
    port: 1,
    engines,
    log: () => {},
    forkHost,
    restartDelay: 25,
    hostUrl: new URL('./fixtures/host-stub.js', import.meta.url),
    onStopped: () => {
      stopped++;
    },
  });
  t.after(() => supervisor.stop());
  supervisor.start();
  const host = await waitFor(() => supervisor.child?.pid && supervisor.child);
  assert.equal(attempts, 3);
  const reply = new Promise((resolve) =>
    host.on('message', (message) => {
      if (message?.type === 'test_reply') {
        resolve(message);
      }
    }),
  );
  host.send({ type: 'test_request', id: 7, method: 'status' });
  assert.deepEqual((await reply).result, { images: { managed: true } });
  const oldPid = host.pid;
  host.kill();
  const replacement = await waitFor(
    () => supervisor.child?.pid && supervisor.child.pid !== oldPid && supervisor.child,
  );
  assert.notEqual(replacement.pid, oldPid);
  assert.equal(attempts, 4);
  const exited = once(replacement, 'exit');
  supervisor.stop();
  await exited;
  assert.equal(stopped, 1);
  assert.equal(supervisor.child, null);
});

test('HTTP supervisor cancels pending restart on shutdown', async () => {
  let attempts = 0,
    stopped = 0;
  const supervisor = new HostSupervisor({
    port: 1,
    engines: {},
    log: () => {},
    restartDelay: 25,
    onStopped: () => {
      stopped++;
    },
    forkHost: () => {
      attempts++;
      throw Error('Simulated resource exhaustion');
    },
  });
  supervisor.start();
  supervisor.stop();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, 1);
  assert.equal(stopped, 1);
});

test('HTTP supervisor does not loop on a fatal host configuration error', async (t) => {
  let attempts = 0,
    fatal = 0;
  const supervisor = new HostSupervisor({
    port: 1,
    engines: {},
    log: () => {},
    restartDelay: 25,
    onFatal: () => {
      fatal++;
    },
    forkHost: (url, args, options) => {
      attempts++;
      return fork(url, args, options);
    },
    hostUrl: new URL('./fixtures/fatal-host.js', import.meta.url),
  });
  t.after(() => supervisor.stop());
  supervisor.start();
  await waitFor(() => fatal === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, 1);
  assert.equal(supervisor.child, null);
});
