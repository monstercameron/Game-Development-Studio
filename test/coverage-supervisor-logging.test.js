import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeSupervisor } from '../runtime/supervisor.js';
import { HostSupervisor } from '../runtime/host-supervisor.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 123;
    this.connected = true;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.sendError = null;
    this.sent = [];
  }

  send(message, callback = () => {}) {
    this.sent.push(message);
    callback(this.sendError);
  }

  kill() {
    this.connected = false;
    this.emit('exit', 0, null);
  }
}

test('runtime supervisor logs fixed lifecycle and RPC failure fields without request data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entries = [];
  const child = new FakeChild();
  const supervisor = new RuntimeSupervisor({
    forkWorker: () => child,
    restartDelay: 10000,
    log: (level, message) => entries.push(`${level} ${message}`),
  });
  t.after(() => supervisor.stop());

  supervisor.start();
  child.emit('message', { type: 'ready' });
  const timedOut = assert.rejects(
    supervisor.call('enqueue', { prompt: 'private prompt marker' }, 5),
    /timed out/,
  );
  await t.mock.timers.tick(5);
  await timedOut;

  child.sendError = new Error('private path marker');
  await assert.rejects(
    supervisor.call('health', { token: 'private key marker' }),
    /private path marker/,
  );

  const output = entries.join('\n');
  assert.match(output, /event=worker_starting/);
  assert.match(output, /event=worker_ready/);
  assert.match(output, /event=rpc_timeout operation=enqueue reason=timeout/);
  assert.match(output, /event=rpc_send_failed operation=health reason=send_failed/);
  assert.doesNotMatch(output, /private prompt marker|private key marker|private path marker/);
});

test('host supervisor logs broker failures and restart escalation with fixed fields', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entries = [];
  const child = new FakeChild();
  const supervisor = new HostSupervisor({
    port: 1,
    engines: {
      status: async () => {
        throw new Error('private path marker');
      },
    },
    forkHost: () => child,
    restartDelay: 10000,
    log: (message) => entries.push(message),
  });
  t.after(() => supervisor.stop());

  supervisor.start();
  child.emit('message', { type: 'engine_request', id: 1, method: 'status', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  child.sendError = new Error('private path marker');
  child.emit('message', { type: 'engine_request', id: 2, method: 'status', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('exit', 1, null);

  const output = entries.join('\n');
  assert.match(output, /event=host_starting/);
  assert.match(output, /event=host_broker_call_failed operation=status reason=broker_error/);
  assert.match(output, /event=host_broker_reply_failed operation=status reason=send_failed/);
  assert.match(output, /event=host_stopped reason=process_exit/);
  assert.match(output, /event=host_restart_scheduled reason=process_exit attempt=1 delay_ms=10000/);
  assert.doesNotMatch(output, /private path marker/);
});

test('host supervisor reports bounded restart delay escalation after repeated spawn failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entries = [];
  let attempts = 0;
  const supervisor = new HostSupervisor({
    port: 1,
    engines: {},
    forkHost: () => {
      attempts++;
      throw new Error('private path marker');
    },
    restartDelay: 10,
    log: (message) => entries.push(message),
  });
  t.after(() => supervisor.stop());

  supervisor.start();
  await t.mock.timers.tick(10);

  assert.equal(attempts, 2);
  assert.ok(entries.some((entry) => /event=host_start_failed reason=spawn_failed/.test(entry)));
  assert.ok(
    entries.some((entry) =>
      /event=host_restart_scheduled reason=spawn_failed attempt=1 delay_ms=10/.test(entry),
    ),
  );
  assert.ok(
    entries.some((entry) =>
      /event=host_restart_scheduled reason=spawn_failed attempt=2 delay_ms=20/.test(entry),
    ),
  );
  assert.doesNotMatch(entries.join('\n'), /private path marker/);
});
