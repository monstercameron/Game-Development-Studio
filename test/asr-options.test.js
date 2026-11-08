import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWordTimes } from '../src/asr-options.js';

test('word timings are listed with minute clocks', () => {
  assert.equal(
    formatWordTimes([{ word: 'Hello', start: 0.08 }, { word: 'again', start: 65.5 }, { bad: 1 }]),
    '0:00.08  Hello\n1:05.50  again',
  );
  assert.equal(formatWordTimes(null), '');
});
