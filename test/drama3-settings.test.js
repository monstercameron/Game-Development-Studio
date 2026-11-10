import test from 'node:test';
import assert from 'node:assert/strict';
import { drama3Request } from '../src/drama3-settings.js';

test('Drama 3 settings preserve dialogue and only choose random seeds for renders', () => {
  const draft = {
    prompt: '[laughs] Hello',
    dramaMaxTokens: '700',
    dramaTemperature: '0.8',
    dramaTopP: '0.9',
    dramaSeed: '',
  };
  assert.deepEqual(drama3Request(draft, { seedGenerator: () => 42 }), {
    text: '[laughs] Hello',
    seed: 42,
    max_tokens: 700,
    temperature: 0.8,
    top_p: 0.9,
  });
  assert.equal(
    drama3Request(draft, {
      estimate: true,
      seedGenerator: () => {
        throw Error('estimate chose a random seed');
      },
    }).seed,
    0,
  );
  assert.equal(drama3Request({ ...draft, dramaSeed: '0' }, { seedGenerator: () => 42 }).seed, 0);
  assert.throws(() => drama3Request({ ...draft, dramaMaxTokens: '9999' }), /Maximum audio tokens/);
});
