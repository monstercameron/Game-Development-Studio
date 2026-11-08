import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatSampling } from '../runtime/chat-sampling.js';

test('unset sampling options add nothing to the upstream request', () => {
  assert.deepEqual(parseChatSampling({}), {});
  assert.deepEqual(parseChatSampling({ topP: null, stop: undefined }), {});
});

test('valid sampling options map to OpenAI-compatible field names', () => {
  assert.deepEqual(
    parseChatSampling({
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      presencePenalty: 0.5,
      frequencyPenalty: -0.5,
      seed: 7,
      stop: ['\nUser:'],
    }),
    {
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
      seed: 7,
      stop: ['\nUser:'],
    },
  );
});

test('out-of-range and wrong-type values are rejected with a readable message', () => {
  assert.throws(() => parseChatSampling({ topP: 0 }), /Top-p must be above 0 up to 1/);
  assert.throws(() => parseChatSampling({ topP: 1.5 }), /Top-p must be above 0 up to 1/);
  assert.throws(() => parseChatSampling({ topK: 0 }), /Top-k must be from 1 up to 1000/);
  assert.throws(() => parseChatSampling({ topK: 2.5 }), /whole number/);
  assert.throws(() => parseChatSampling({ minP: -0.1 }), /Min-p must be from 0 up to 1/);
  assert.throws(() => parseChatSampling({ presencePenalty: 3 }), /Presence penalty/);
  assert.throws(() => parseChatSampling({ seed: -1 }), /Seed must be from 0/);
  assert.throws(() => parseChatSampling({ topP: '0.5' }), /must be a number/);
  assert.throws(() => parseChatSampling({ topP: NaN }), /must be a number/);
});

test('stop sequences are limited in count, length and content', () => {
  assert.throws(() => parseChatSampling({ stop: 'x' }), /list of text values/);
  assert.throws(() => parseChatSampling({ stop: ['a', 'b', 'c', 'd', 'e'] }), /at most 4/);
  assert.throws(() => parseChatSampling({ stop: [''] }), /non-empty text/);
  assert.throws(() => parseChatSampling({ stop: ['x'.repeat(101)] }), /100 characters/);
  assert.deepEqual(parseChatSampling({ stop: [] }), {});
});

test('top-k and min-p are refused for OpenAI but accepted for compatible servers', () => {
  assert.throws(
    () => parseChatSampling({ topK: 40 }, { provider: 'openai' }),
    /available only for local or compatible/,
  );
  assert.throws(
    () => parseChatSampling({ minP: 0.1 }, { provider: 'openai' }),
    /available only for local or compatible/,
  );
  assert.deepEqual(parseChatSampling({ topP: 0.8 }, { provider: 'openai' }), { top_p: 0.8 });
  assert.deepEqual(parseChatSampling({ minP: 0.1 }, { provider: 'compatible' }), { min_p: 0.1 });
});
