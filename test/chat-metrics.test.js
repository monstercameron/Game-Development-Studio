import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponseMetrics } from '../src/chat-metrics.js';

test('measures first thinking or text token and uses the server generation rate', () => {
  const m = createResponseMetrics(1000);
  m.observe({ choices: [{ delta: { role: 'assistant' } }] }, 1200);
  m.observe({ choices: [{ delta: { reasoning_content: 'thinking' } }] }, 1450);
  m.observe({ choices: [{ delta: { content: 'answer' } }] }, 2000);
  m.observe(
    { choices: [], usage: { completion_tokens: 24 }, timings: { predicted_per_second: 34.25 } },
    2050,
  );
  assert.deepEqual(m.finish(), {
    ttftMs: 450,
    outputTokens: 24,
    tokensPerSecond: 34.25,
    rateSource: 'server',
  });
});
test('uses real completion-token counts for an estimated streamed rate', () => {
  const m = createResponseMetrics(0);
  m.observe({ choices: [{ delta: { content: 'a' } }] }, 100);
  m.observe({ choices: [{ delta: { content: 'b' } }] }, 1100);
  m.observe({ usage: { completion_tokens: 11 } }, 1150);
  assert.deepEqual(m.finish(), {
    ttftMs: 100,
    outputTokens: 11,
    tokensPerSecond: 10,
    rateSource: 'client',
  });
});
test('does not invent token rates when token usage or usable duration is missing', () => {
  const m = createResponseMetrics(10);
  m.observe({ choices: [{ delta: { content: 'a' } }] }, 20);
  assert.deepEqual(m.finish(), {
    ttftMs: 10,
    outputTokens: null,
    tokensPerSecond: null,
    rateSource: null,
  });
  m.observe({ usage: { completion_tokens: 10 } }, 30);
  assert.equal(m.finish().tokensPerSecond, null);
});
