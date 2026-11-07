import test from 'node:test';
import assert from 'node:assert/strict';
import { gameDecisionRequest, presentGameDecision } from '../src/game-decision-input.js';

test('Mammoth decision UI maps choice, score and yes/no into supported request shapes', () => {
  const draft = {
    prompt: 'Player is near a gate.',
    second: 'What should the guard do?\n1. Challenge\n2. Let them pass',
    options: ['Choice', 'Structured'],
  };
  assert.deepEqual(gameDecisionRequest(draft).questions.decision, {
    type: 'choice',
    instructions: 'What should the guard do?',
    criteria: { option_1: 'Challenge', option_2: 'Let them pass' },
  });
  assert.deepEqual(gameDecisionRequest({ ...draft, options: ['Score'] }).questions.decision, {
    type: 'score',
    instructions: 'What should the guard do?',
    criteria: ['Challenge', 'Let them pass'],
  });
  assert.deepEqual(
    gameDecisionRequest({
      ...draft,
      second: 'Should the guard let them pass?',
      options: ['Yes / No'],
    }).questions.decision,
    { type: 'noul', instructions: 'Should the guard let them pass?' },
  );
});

test('Mammoth UI rejects empty and unsupported decision inputs', () => {
  const draft = { prompt: 'state', second: 'Question\nOne\nTwo', options: ['Choice'] };
  assert.throws(() => gameDecisionRequest({ ...draft, prompt: ' ' }), /game state/);
  assert.throws(() => gameDecisionRequest({ ...draft, second: ' ' }), /question/i);
  assert.throws(() => gameDecisionRequest({ ...draft, second: 'Question\nOne' }), /at least two/);
  assert.throws(
    () => gameDecisionRequest({ ...draft, second: 'Question\n1.\n2. One' }),
    /description/,
  );
  assert.throws(
    () =>
      gameDecisionRequest({
        ...draft,
        options: ['Score'],
        second: ['Q', ...Array.from({ length: 11 }, (_, i) => `level ${i}`)].join('\n'),
      }),
    /10 levels/,
  );
  assert.throws(
    () => gameDecisionRequest({ ...draft, options: ['unknown'] }),
    /supported question/,
  );
});

test('compact response changes presentation only and preserves the source', () => {
  const response = {
    answers: { decision: { type: 'noul', noul: 0.7 } },
    metrics: { decision_ms: 20 },
  };
  assert.equal(presentGameDecision(response, 'Compact'), response.answers);
  assert.equal(presentGameDecision(response, 'Structured'), response);
  assert.equal(response.metrics.decision_ms, 20);
});
