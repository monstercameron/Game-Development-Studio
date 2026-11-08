import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SAMPLING, SAMPLING_FIELDS, samplingFromForm } from '../src/chat-sampling-form.js';

test('blank sampling fields send nothing and report no errors', () => {
  assert.deepEqual(samplingFromForm(EMPTY_SAMPLING, 'compatible'), { options: {}, errors: {} });
});

test('filled fields become camelCase request options and stop lines are trimmed', () => {
  const result = samplingFromForm(
    { ...EMPTY_SAMPLING, topP: '0.9', topK: '40', stop: ' END \n\n User: ' },
    'compatible',
  );
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.options, { topP: 0.9, topK: 40, stop: ['END', 'User:'] });
});

test('one invalid field withholds all options and names the field', () => {
  const result = samplingFromForm({ ...EMPTY_SAMPLING, topP: '1.5', seed: '3' }, 'compatible');
  assert.deepEqual(result.options, {});
  assert.match(result.errors.topP, /Top-p must be above 0 up to 1/);
  assert.equal(result.errors.seed, undefined);
});

test('a half-typed number is reported as not a number', () => {
  const result = samplingFromForm({ ...EMPTY_SAMPLING, presencePenalty: '-' }, 'compatible');
  assert.equal(result.errors.presencePenalty, 'Presence penalty must be a number.');
});

test('top-k is flagged for OpenAI at the field, not silently dropped', () => {
  const result = samplingFromForm({ ...EMPTY_SAMPLING, topK: '20' }, 'openai');
  assert.match(result.errors.topK, /available only for local or compatible/);
});

test('every field has a label and help text for the form', () => {
  for (const field of SAMPLING_FIELDS) {
    assert.ok(field.label && field.help, field.key);
  }
});
