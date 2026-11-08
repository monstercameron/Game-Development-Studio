import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionSummaries,
  gameDecisionRequest,
  MAX_GAME_QUESTIONS,
} from '../src/game-decision-input.js';

const draft = {
  prompt: 'The guard heard a noise at the gate.',
  second: 'Should the guard investigate?\nYes\nNo',
  options: ['Choice', 'Structured'],
};

test('extra questions are added under their own names beside the main question', () => {
  const request = gameDecisionRequest(draft, [
    { mode: 'Yes / No', text: 'Is the gate open?' },
    { mode: 'Score', text: 'How urgent is it?\nCalm\nAlarm' },
  ]);
  assert.deepEqual(Object.keys(request.questions), ['decision', 'decision_2', 'decision_3']);
  assert.deepEqual(request.questions.decision_2, {
    type: 'noul',
    instructions: 'Is the gate open?',
  });
  assert.equal(request.questions.decision_3.type, 'score');
  assert.equal(request.state, draft.prompt);
});

test('a request holds at most 16 questions in total', () => {
  const extras = Array.from({ length: MAX_GAME_QUESTIONS }, () => ({
    mode: 'Yes / No',
    text: 'Is it?',
  }));
  assert.throws(() => gameDecisionRequest(draft, extras), /Use at most 16 questions/);
  assert.equal(
    Object.keys(gameDecisionRequest(draft, extras.slice(0, 15)).questions).length,
    MAX_GAME_QUESTIONS,
  );
});

test('an invalid extra question is named in its error', () => {
  assert.throws(
    () => gameDecisionRequest(draft, [{ mode: 'Yes / No', text: '   ' }]),
    /Question 2: Enter a question\./,
  );
  assert.throws(
    () => gameDecisionRequest(draft, [{ mode: 'Choice', text: 'Only one line' }]),
    /Question 2: Enter a question followed by at least two choices/,
  );
  assert.throws(
    () => gameDecisionRequest(draft, [{ mode: 'Ranking', text: 'x' }]),
    /Question 2: Choose a supported question type/,
  );
});

test('the main question error is unchanged when no extra questions are added', () => {
  assert.throws(() => gameDecisionRequest({ ...draft, second: '' }), /Enter a question\./);
});

test('summaries follow request order and keep each answer separate', () => {
  const request = gameDecisionRequest(draft, [{ mode: 'Yes / No', text: 'Is it open?' }]);
  const result = {
    answers: {
      decision: {
        type: 'choice',
        choice: 'option_1',
        probabilities: { option_1: 0.8, option_2: 0.2 },
        confidence: 0.7,
      },
      decision_2: { type: 'noul', noul: 0.25 },
    },
  };
  const summaries = decisionSummaries(result, request);
  assert.deepEqual(
    summaries.map((item) => item.name),
    ['decision', 'decision_2'],
  );
  assert.equal(summaries[0].summary.title, 'Selected: Yes');
  assert.equal(summaries[1].summary.title, 'Yes: 25%');
});

test('a missing answer yields no summary instead of a guessed one', () => {
  const request = gameDecisionRequest(draft, [{ mode: 'Yes / No', text: 'Is it open?' }]);
  const summaries = decisionSummaries(
    { answers: { decision: { type: 'noul', noul: 0.5 } } },
    request,
  );
  assert.equal(summaries[1].summary, null);
});
