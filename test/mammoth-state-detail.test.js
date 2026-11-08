import test from 'node:test';
import assert from 'node:assert/strict';
import { mammothStateDetail } from '../src/game-decision-input.js';

test('a stopped Mammoth service is not described as started outside Forge', () => {
  const text = mammothStateDetail({ status: 'unavailable', managed: false, modelLoaded: null });
  assert.equal(text, 'Start or load Mammoth before running a decision.');
  assert.doesNotMatch(text, /outside Forge/);
});

test('a reachable service Forge did not start is reported as external', () => {
  const text = mammothStateDetail({ status: 'reachable', managed: false, modelLoaded: true });
  assert.match(text, /Started outside Forge/);
});

test('managed and error states keep their specific guidance', () => {
  assert.match(mammothStateDetail({ status: 'reachable', managed: true }), /Managed by Forge/);
  assert.match(
    mammothStateDetail({ status: 'reachable', managed: true, state: 'error' }),
    /start Mammoth again/,
  );
  assert.match(
    mammothStateDetail({ status: 'reachable', managed: false, state: 'error' }),
    /Forge cannot manage/,
  );
});

test('a status-check failure takes precedence over service detail', () => {
  assert.equal(
    mammothStateDetail(null, 'Could not check Mammoth status.'),
    'Could not check Mammoth status.',
  );
});
