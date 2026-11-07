import test from 'node:test';
import assert from 'node:assert/strict';
import { audioPayload } from '../src/audio-payload.js';

test('music payload rejects seeds above the durable queue limit', () => {
  const payload = (seed) =>
    audioPayload('music', 'project', {
      prompt: 'ambient',
      options: [],
      seed: String(seed),
    });

  assert.equal(payload(2147483647).request.seed, 2147483647);
  assert.throws(() => payload(2147483648), /Seed must be a whole number/);
});
