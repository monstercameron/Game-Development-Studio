import assert from 'node:assert/strict';
import test from 'node:test';
import { aceStepAcceptedTask, aceStepTaskState } from '../runtime/acestep-protocol.js';

const wrap = (status, result) => ({
  code: 200,
  data: [{ task_id: 'task-1', status, result: JSON.stringify(result) }],
});

test('ACE-Step acceptance requires a recoverable task identifier', () => {
  assert.equal(aceStepAcceptedTask({ code: 200, data: { task_id: 'task-1' } }), 'task-1');
  assert.throws(() => aceStepAcceptedTask({ code: 200, data: {} }), /unknown/);
});

test('ACE-Step unknown and timed-out tasks are never mistaken for safe retries', () => {
  assert.deepEqual(aceStepTaskState(wrap(0, []), 'task-1'), { status: 'unknown' });
  assert.deepEqual(aceStepTaskState(wrap(2, [{ status: 0 }]), 'task-1'), { status: 'unknown' });
  assert.deepEqual(aceStepTaskState(wrap(0, [{ status: 0 }]), 'task-1'), { status: 'running' });
  assert.deepEqual(aceStepTaskState(wrap(2, [{ status: 2, error: 'failed' }]), 'task-1'), {
    status: 'failed',
  });
});

test('ACE-Step success accepts only one local audio endpoint', () => {
  assert.deepEqual(
    aceStepTaskState(wrap(1, [{ status: 1, file: '/v1/audio?path=output.wav' }]), 'task-1'),
    {
      status: 'succeeded',
      audioPath: '/v1/audio?path=output.wav',
    },
  );
  for (const file of [
    'https://example.com/v1/audio?path=x',
    '//example.com/v1/audio?path=x',
    '/v1/audio?path=x&other=y',
  ]) {
    assert.deepEqual(aceStepTaskState(wrap(1, [{ status: 1, file }]), 'task-1'), {
      status: 'unknown',
    });
  }
});
