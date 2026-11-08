import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearRecoveryNeeded,
  createCrashLoopGuard,
  readRecoveryNeeded,
} from '../runtime/crash-loop.js';
import { HostSupervisor } from '../runtime/host-supervisor.js';
import { RuntimeSupervisor } from '../runtime/supervisor.js';
import { startRecoveryNeededServer } from '../runtime/recovery-needed-server.js';
import { readRecoveryEvents } from '../runtime/recovery-events.js';

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-crash-loop-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Timed out waiting for the supervisor.');
}

test('the guard trips only when the limit falls inside the window', () => {
  let clock = 0;
  const guard = createCrashLoopGuard({ limit: 3, windowMs: 1000, now: () => clock });
  assert.equal(guard.record().tripped, false);
  clock = 600;
  assert.equal(guard.record().tripped, false);
  clock = 1500;
  // The first crash is now outside the window, so this is only the second inside it.
  assert.equal(guard.record().tripped, false);
  clock = 1550;
  assert.deepEqual(
    { tripped: guard.record().tripped, count: guard.count() },
    { tripped: true, count: 3 },
  );
  guard.reset();
  assert.equal(guard.count(), 0);
});

test('a host that keeps crashing stops being restarted and recovery is flagged', async (t) => {
  const directory = await temp(t);
  let forks = 0;
  const tripped = [];
  const supervisor = new HostSupervisor({
    port: 1,
    engines: {},
    log: () => {},
    restartDelay: 1,
    runtimeDirectory: directory,
    hostUrl: new URL('./fixtures/crashing-host.js', import.meta.url),
    crashLoop: createCrashLoopGuard({ limit: 4, windowMs: 60000 }),
    onCrashLoop: (loop) => tripped.push(loop),
    forkHost: (url, args, options) => {
      forks++;
      return fork(url, args, options);
    },
  });
  t.after(() => supervisor.stop());
  supervisor.start();
  await waitFor(() => tripped.length === 1);
  const forksAtTrip = forks;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(forks, forksAtTrip, 'no further host is started once the loop is detected');
  assert.equal(forks, 4);
  assert.equal(supervisor.child, null);
  assert.equal(readRecoveryNeeded(directory).component, 'host');
  const codes = readRecoveryEvents({ directory }).map((event) => event.code);
  assert.ok(codes.includes('supervisor.host_crashed'));
  assert.ok(codes.includes('supervisor.crash_loop'));

  // Trying again after the user fixed the cause starts a host once more.
  clearRecoveryNeeded(directory);
  assert.equal(readRecoveryNeeded(directory), null);
  supervisor.retryAfterCrashLoop();
  await waitFor(() => forks > forksAtTrip);
});

test('a host that stays up is not counted as a crash loop', async (t) => {
  const directory = await temp(t);
  let hosts = 0;
  const supervisor = new HostSupervisor({
    port: 1,
    engines: {},
    log: () => {},
    restartDelay: 1,
    runtimeDirectory: directory,
    hostUrl: new URL('./fixtures/host-stub.js', import.meta.url),
    crashLoop: createCrashLoopGuard({ limit: 3, windowMs: 60000 }),
    forkHost: (url, args, options) => {
      hosts++;
      return fork(url, args, options);
    },
  });
  t.after(() => supervisor.stop());
  supervisor.start();
  const firstChild = await waitFor(() => supervisor.child?.pid && supervisor.child);
  firstChild.kill();
  await waitFor(() => supervisor.child && supervisor.child !== firstChild && supervisor.child.pid);
  assert.equal(supervisor.crashLooped, false);
  assert.equal(hosts, 2);
});

test('the runtime worker supervisor also gives up after repeated crashes', async (t) => {
  const directory = await temp(t);
  let workers = 0;
  const logs = [];
  const forkWorker = () => {
    workers++;
    const child = new EventEmitter();
    child.pid = 1000 + workers;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.connected = true;
    child.kill = () => {};
    setImmediate(() => child.emit('exit', 1, null));
    return child;
  };
  const supervisor = new RuntimeSupervisor({
    forkWorker,
    restartDelay: 1,
    runtimeDirectory: directory,
    crashLoop: createCrashLoopGuard({ limit: 3, windowMs: 60000 }),
    log: (level, message) => logs.push(`${level} ${message}`),
  });
  supervisor.start();
  await waitFor(() => supervisor.status().crashLooped);
  const workersAtTrip = workers;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(workers, workersAtTrip);
  assert.equal(workersAtTrip, 3);
  assert.ok(logs.some((line) => line.includes('worker_crash_loop')));
  assert.equal(readRecoveryNeeded(directory).component, 'runtime worker');
  supervisor.stop();
});

test('the recovery-needed responder answers 503 with a clear message on the studio port', async (t) => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const server = await startRecoveryNeededServer({
    port,
    component: 'studio host',
    count: 5,
    windowMs: 600000,
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(pageResponse.status, 503);
  assert.match(await pageResponse.text(), /Recovery needed/);
  const apiResponse = await fetch(`http://127.0.0.1:${port}/api/runtime/jobs`);
  assert.equal(apiResponse.status, 503);
  const body = await apiResponse.json();
  assert.equal(body.error, 'recovery_needed');
  assert.match(body.message, /5 crashes in 10 minutes/);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: '/', headers: { Host: 'example.com' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(foreignHostStatus, 403);
});
