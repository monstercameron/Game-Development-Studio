import test from 'node:test';
import assert from 'node:assert/strict';
import { openTranscriptionStream } from '../runtime/asr-client.js';

class FakeSocket extends EventTarget {
  static instance;

  constructor(url) {
    super();
    this.url = String(url);
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeSocket.instance = this;
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  message(value) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  error() {
    this.dispatchEvent(new Event('error'));
  }
}

function installFakeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const active = new Map();
  let nextId = 1;
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    const id = nextId++;
    active.set(id, timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    for (const [id, activeTimer] of active) {
      if (activeTimer === timer) {
        active.delete(id);
        return;
      }
    }
  };

  return {
    active,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function configure(socket) {
  socket.message({ type: 'session.created' });
  socket.message({ type: 'session.updated' });
}

test('ASR stream clears readiness and completion timers after successful transcription', async () => {
  const timers = installFakeTimers();
  try {
    const stream = openTranscriptionStream({
      WebSocketImpl: FakeSocket,
      timeoutMs: 10,
      completionTimeoutMs: 20,
    });
    const socket = FakeSocket.instance;
    const readinessTimer = [...timers.active.values()][0];

    configure(socket);
    await stream.ready;
    assert.equal(timers.active.size, 0);

    stream.commit();
    assert.equal(timers.active.size, 1);
    const completionTimer = [...timers.active.values()][0];
    assert.equal(completionTimer.delay, 20);
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'done',
    });

    assert.equal((await stream.done).transcript, 'done');
    assert.equal(timers.active.size, 0);
    assert.ok(readinessTimer);
  } finally {
    timers.restore();
  }
});

test('ASR stream timeout and service errors reject both promises and clear timers', async () => {
  const timers = installFakeTimers();
  try {
    const waiting = openTranscriptionStream({ WebSocketImpl: FakeSocket, timeoutMs: 7 });
    const readinessTimer = [...timers.active.values()][0];
    readinessTimer.callback();
    await assert.rejects(waiting.ready, /did not become ready/);
    await assert.rejects(waiting.done, /did not become ready/);
    assert.equal(timers.active.size, 0);
    assert.equal(FakeSocket.instance.readyState, 3);

    const configured = openTranscriptionStream({ WebSocketImpl: FakeSocket });
    const socket = FakeSocket.instance;
    configure(socket);
    await configured.ready;
    configured.commit();
    assert.equal(timers.active.size, 1);
    socket.message({ type: 'error', message: 'backend unavailable' });
    await assert.rejects(configured.done, /backend unavailable/);
    assert.equal(timers.active.size, 0);
    assert.equal(socket.readyState, 3);
  } finally {
    timers.restore();
  }
});

test('ASR stream callback exceptions reject completion and close the socket', async () => {
  const stream = openTranscriptionStream({
    WebSocketImpl: FakeSocket,
    onEvent() {
      throw Error('consumer failed');
    },
  });
  const socket = FakeSocket.instance;
  configure(socket);
  await stream.ready;
  stream.commit();
  socket.message({ type: 'conversation.item.input_audio_transcription.delta', delta: 'x' });

  await assert.rejects(stream.done, /consumer failed/);
  assert.equal(socket.readyState, 3);
});

test('ASR socket errors reject readiness and completion', async () => {
  const stream = openTranscriptionStream({ WebSocketImpl: FakeSocket });
  FakeSocket.instance.error();

  await assert.rejects(stream.ready, /connection failed/);
  await assert.rejects(stream.done, /connection failed/);
});
