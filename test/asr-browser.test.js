import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { openAsrStream } from '../src/asr-stream.js';

class FakeSocket extends EventTarget {
  static instance;
  constructor() {
    super();
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
}
test('browser stream waits for configuration, forwards partials and commits the final transcript', async () => {
  const partials = [],
    finals = [],
    session = openAsrStream({
      url: 'ws://127.0.0.1:5173/api/asr/realtime',
      sampleRate: 48000,
      WebSocketImpl: FakeSocket,
      onDelta: (value) => partials.push(value),
      onFinal: (value) => finals.push(value),
    }),
    socket = FakeSocket.instance;
  assert.throws(() => session.send(new ArrayBuffer(2)), /not accepting/);
  socket.message({ type: 'session.created' });
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'session.update',
    session: { sample_rate: 48000 },
  });
  socket.message({ type: 'session.updated' });
  await session.ready;
  session.send(new ArrayBuffer(4));
  socket.message({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hello' });
  session.commit();
  assert.throws(() => session.send(new ArrayBuffer(2)), /not accepting/);
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'hello world',
  });
  await session.done;
  assert.deepEqual(partials, ['hello']);
  assert.deepEqual(finals, ['hello world']);
  assert.deepEqual(JSON.parse(socket.sent[2]), { type: 'input_audio_buffer.commit' });
});
test('browser stream refuses backpressure and reports an unexpected disconnect', async () => {
  const session = openAsrStream({
    url: 'ws://127.0.0.1',
    sampleRate: 16000,
    WebSocketImpl: FakeSocket,
  });
  const socket = FakeSocket.instance;
  socket.message({ type: 'session.created' });
  socket.message({ type: 'session.updated' });
  await session.ready;
  socket.bufferedAmount = 2 * 1024 * 1024;
  assert.throws(() => session.send(new ArrayBuffer(2)), /not consuming/);
  socket.close();
  await assert.rejects(session.done, /disconnected/);
});
test('audio worklet averages channels, encodes PCM16 little endian, and flushes the tail', async () => {
  const script = await fs.readFile(new URL('../public/pcm16-worklet.js', import.meta.url), 'utf8');
  let Processor;
  const messages = [];
  class Base {
    constructor() {
      this.port = { postMessage: (message) => messages.push(message) };
    }
  }
  vm.runInNewContext(script, {
    AudioWorkletProcessor: Base,
    registerProcessor: (name, value) => {
      assert.equal(name, 'forge-pcm16');
      Processor = value;
    },
    Int16Array,
    ArrayBuffer,
    DataView,
    Math,
  });
  const processor = new Processor();
  assert.equal(
    processor.process([[Float32Array.from([1, -1, 0.5]), Float32Array.from([1, -1, -0.5])]]),
    true,
  );
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages[0].type, 'audio');
  const pcm = new DataView(messages[0].buffer);
  assert.deepEqual(
    [pcm.getInt16(0, true), pcm.getInt16(2, true), pcm.getInt16(4, true)],
    [32767, -32768, 0],
  );
  assert.equal(messages[1].type, 'flushed');
  assert.equal(processor.process([]), false);
});
