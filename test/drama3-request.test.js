import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDrama3Request } from '../runtime/drama3-request.js';

test('Drama 3 requests preserve direction tags and use bounded sampling defaults', () => {
  assert.deepEqual(normalizeDrama3Request({ text: ' [whisper] Hello. ', seed: 7 }), {
    text: '[whisper] Hello.',
    seed: 7,
    max_tokens: 500,
    temperature: 1,
    top_p: 0.9,
  });
  assert.equal(
    normalizeDrama3Request({ text: 'Hi', seed: 7, max_tokens: 80, temperature: 0, top_p: 0.4 })
      .temperature,
    0,
  );
});

test('Drama 3 rejects empty dialogue, unsafe fields and invalid tuning values', () => {
  for (const request of [
    { text: '', seed: 1 },
    { text: 'x'.repeat(1001), seed: 1 },
    { text: 'Hi', seed: -1 },
    { text: 'Hi', seed: 1, max_tokens: 2049 },
    { text: 'Hi', seed: 1, top_p: 0 },
    { text: 'Hi', seed: 1, temperature: Infinity },
    { text: 'Hi', seed: 1, backend: 'cpu' },
  ]) {
    assert.throws(() => normalizeDrama3Request(request));
  }
});
