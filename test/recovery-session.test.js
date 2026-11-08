import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginSession, watchForSuspend } from '../runtime/session-state.js';
import { createStudioLifecycle, stopRequestFile } from '../runtime/studio-lifecycle.js';
import { readRecoveryEvents } from '../runtime/recovery-events.js';
import { startCrashWorker } from './fixtures/start-crash-worker.js';

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-session-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the first start has no previous session and an orderly stop is recorded as clean', async (t) => {
  const directory = await temp(t);
  const first = beginSession({ directory });
  assert.equal(first.previous.state, 'none');
  first.end('stopped');
  const second = beginSession({ directory });
  assert.equal(second.previous.state, 'clean');
  assert.equal(second.previous.endReason, 'stopped');
  assert.equal(second.previous.sessionId, first.sessionId);
  second.end();
});

test('a session killed without an orderly stop is reported as unclean with its last heartbeat', async (t) => {
  const directory = await temp(t);
  const { child, ready } = startCrashWorker(t, 'session', directory);
  await ready;
  // Let at least one heartbeat land after the start.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;

  const next = beginSession({ directory });
  assert.equal(next.previous.state, 'unclean');
  assert.ok(Date.parse(next.previous.lastAliveAt) > Date.parse(next.previous.startedAt));
  next.end();
});

test('a stop that missed its deadline is also unclean, with the reason', async (t) => {
  const directory = await temp(t);
  const session = beginSession({ directory });
  session.end('deadline', { clean: false });
  const next = beginSession({ directory });
  assert.equal(next.previous.state, 'unclean');
  assert.equal(next.previous.endReason, 'deadline');
  next.end();
});

test('a damaged marker file counts as no marker, not as a crash of the reader', async (t) => {
  const directory = await temp(t);
  await fs.writeFile(path.join(directory, 'session-state.json'), '{"state":"runn');
  const session = beginSession({ directory });
  assert.equal(session.previous.state, 'none');
  session.end();
});

test('a wall-clock gap is reported as a resume from sleep', async (t) => {
  const gaps = [];
  const stop = watchForSuspend((gap) => gaps.push(gap.gapMs), { intervalMs: 20, gapMs: 60 });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.deepEqual(gaps, []);
  // Block the loop the way a suspended machine stops it: the next tick sees a large gap.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(gaps.length >= 1 && gaps[0] >= 150, JSON.stringify(gaps));
});

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.env = {};
  return proc;
}

function lifecycleFixture(directory, overrides = {}) {
  const proc = fakeProcess();
  const calls = { stop: 0, trayStop: 0, exits: [] };
  const supervisor = { stop: () => calls.stop++ };
  const lifecycle = createStudioLifecycle({
    port: 5199,
    supervisor,
    tray: { stop: () => calls.trayStop++ },
    runtimeDirectory: directory,
    proc,
    exit: (code) => calls.exits.push(code),
    pollMs: 20,
    deadlineMs: 80,
    ...overrides,
  });
  return { proc, calls, lifecycle };
}

test('each stop signal starts one orderly shutdown and the clean marker follows the host stopping', async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    const directory = await temp(t);
    const { proc, calls, lifecycle } = lifecycleFixture(directory);
    lifecycle.start();
    proc.emit(signal);
    proc.emit(signal);
    assert.equal(calls.stop, 1, `${signal} must stop the supervisor exactly once`);
    assert.equal(calls.trayStop, 1);
    lifecycle.stopped();
    assert.deepEqual(calls.exits, [0]);
    lifecycle.dispose();
    const next = beginSession({ directory });
    assert.equal(next.previous.state, 'clean', signal);
    next.end();
  }
});

test('a shutdown that does not finish is cut off at the deadline and marked forced', async (t) => {
  const directory = await temp(t);
  const { proc, calls, lifecycle } = lifecycleFixture(directory);
  lifecycle.start();
  proc.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(calls.exits, [0]);
  lifecycle.dispose();
  const next = beginSession({ directory });
  assert.equal(next.previous.state, 'unclean');
  assert.equal(next.previous.endReason, 'deadline');
  next.end();
});

test('a start after an unclean exit tells children and writes the recovery event', async (t) => {
  const directory = await temp(t);
  const crashed = beginSession({ directory });
  assert.equal(crashed.previous.state, 'none');
  const { proc, lifecycle } = lifecycleFixture(directory);
  lifecycle.start();
  assert.equal(proc.env.FORGE_PREVIOUS_UNCLEAN, '1');
  const startup = JSON.parse(
    await fs.readFile(path.join(directory, 'recovery-startup.json'), 'utf8'),
  );
  assert.equal(startup.previous.state, 'unclean');
  assert.ok(
    readRecoveryEvents({ directory }).some((event) => event.code === 'session.unclean_exit'),
  );
  lifecycle.stopped();
  lifecycle.dispose();

  const again = lifecycleFixture(directory);
  again.proc.env.FORGE_PREVIOUS_UNCLEAN = '1';
  again.lifecycle.start();
  assert.equal(
    again.proc.env.FORGE_PREVIOUS_UNCLEAN,
    undefined,
    'a clean previous session clears it',
  );
  again.lifecycle.stopped();
  again.lifecycle.dispose();
});

test('a stop request file stops the studio only for this process and only when fresh', async (t) => {
  const directory = await temp(t);
  const { calls, lifecycle } = lifecycleFixture(directory);
  lifecycle.start();
  const file = stopRequestFile(directory, 5199);

  await fs.writeFile(
    file,
    JSON.stringify({ pid: 1, requestedAt: new Date().toISOString(), reason: 'stop-server' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.stop, 0, 'a request for another process is ignored');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }, 'and it is consumed');

  await fs.writeFile(
    file,
    JSON.stringify({ pid: 4242, requestedAt: '2020-01-01T00:00:00.000Z', reason: 'stop-server' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.stop, 0, 'a stale request is ignored');

  await fs.writeFile(
    file,
    JSON.stringify({ pid: 4242, requestedAt: new Date().toISOString(), reason: 'session-ending' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.stop, 1);
  lifecycle.stopped();
  lifecycle.dispose();
});
