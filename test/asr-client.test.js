import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localAsrUrl,
  openTranscriptionStream,
  recognitionOptions,
  transcribeWav,
} from '../runtime/asr-client.js';

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
}

test('ASR client limits endpoints and validates WAV responses', async () => {
  assert.throws(() => localAsrUrl('http://example.com:8282'), /local HTTP/);
  assert.throws(() => localAsrUrl('http://127.0.0.1:8282/path'), /local HTTP/);
  await assert.rejects(transcribeWav(Buffer.from('not a wave')), /RIFF\/WAVE/);
  const wav = Buffer.alloc(44);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  const result = await transcribeWav(wav, {
    fetcher: async (url, request) => {
      assert.equal(url.pathname, '/v1/audio/transcriptions');
      assert.equal(request.method, 'POST');
      assert.equal(request.body.get('file').type, 'audio/wav');
      return { ok: true, json: async () => ({ text: 'hello' }) };
    },
  });
  assert.equal(result.text, 'hello');
  await assert.rejects(
    transcribeWav(wav, { fetcher: async () => ({ ok: true, json: async () => ({}) }) }),
    /invalid transcript/,
  );
});

test('streaming speech sessions wait for configuration and distinguish partials from the final', async () => {
  const events = [];
  const stream = openTranscriptionStream({
    WebSocketImpl: FakeSocket,
    onEvent: (event) => events.push(event),
  });
  const socket = FakeSocket.instance;
  assert.throws(() => stream.send(Buffer.alloc(2)), /not accepting/);
  socket.message({ type: 'session.created' });
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'session.update',
    session: { sample_rate: 16000 },
  });
  socket.message({ type: 'session.updated' });
  await stream.ready;
  assert.throws(() => stream.send(Buffer.alloc(3)), /16-bit PCM/);
  stream.send(Buffer.alloc(320));
  socket.message({ type: 'conversation.item.input_audio_transcription.delta', delta: 'hello' });
  stream.commit();
  assert.throws(() => stream.send(Buffer.alloc(2)), /not accepting/);
  socket.message({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'hello world',
  });
  assert.equal((await stream.done).transcript, 'hello world');
  assert.equal(events.length, 2);
});

test('stream cancellation and early disconnect reject completion', async () => {
  const stream = openTranscriptionStream({ WebSocketImpl: FakeSocket });
  stream.close();
  await assert.rejects(stream.ready, /cancelled/);
  await assert.rejects(stream.done, /cancelled/);
  const second = openTranscriptionStream({ WebSocketImpl: FakeSocket });
  FakeSocket.instance.close();
  await assert.rejects(second.done, /closed before transcription/);
});

test('stream rejects stalled completion and applies backpressure', async () => {
  const stream = openTranscriptionStream({ WebSocketImpl: FakeSocket, completionTimeoutMs: 20 });
  const socket = FakeSocket.instance;
  socket.message({ type: 'session.created' });
  socket.message({ type: 'session.updated' });
  await stream.ready;
  socket.bufferedAmount = 2 * 1024 * 1024;
  assert.throws(() => stream.send(Buffer.alloc(2)), /not consuming/);
  stream.commit();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(stream.done, /did not finish/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('recognition options become request fields and word timings are returned', async () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF');
  wav.write('WAVE', 8);
  let form;
  const result = await transcribeWav(wav, {
    options: { punctuation: false, wordTimestamps: true },
    fetcher: async (_url, request) => {
      form = request.body;
      return {
        ok: true,
        json: async () => ({
          text: 'hello',
          duration: 1.23456,
          words: [{ word: 'hello', start: 0.08, end: 0.5 }, { nope: 1 }],
        }),
      };
    },
  });
  assert.equal(form.get('automatic_punctuation'), 'false');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.equal(form.get('speech_contexts'), null);
  assert.deepEqual(result, {
    text: 'hello',
    words: [{ word: 'hello', start: 0.08, end: 0.5 }],
    duration: 1.235,
  });
  assert.throws(() => recognitionOptions({ punctuation: 'no' }), /true or false/);
});
