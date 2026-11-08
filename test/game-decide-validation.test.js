import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../runtime/game.js';

const question = { decision: { type: 'noul', instructions: 'Is it yes?' } };

test('a decision request without a text state is refused before Mammoth is called', async () => {
  for (const input of [{ questions: question }, { state: '  ', questions: question }, { state: 3, questions: question }]) {
    await assert.rejects(() => decide(input), /Provide a game state as text/);
  }
});

