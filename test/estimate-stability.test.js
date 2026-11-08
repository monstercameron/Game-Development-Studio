import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const effectStart = source.indexOf('const scopeKey = `${section}|');

test('the render estimate is cleared only when the page, project or model changes', () => {
  assert.ok(effectStart > 0, 'the estimate effect keeps a scope key');
  const effectHead = source.slice(effectStart - 400, effectStart + 400);
  assert.match(effectHead, /estimateScope\.current !== scopeKey/);
  // The estimate must not be reset on every dependency change: that flashed "Checking…" on
  // each keystroke and each queue poll.
  const beforeScope = source.slice(effectStart - 200, effectStart);
  assert.doesNotMatch(beforeScope, /setRenderEstimate\(null\)/);
});

test('an unchanged estimate request is not sent again and stale replies are ignored', () => {
  const effect = source.slice(effectStart, effectStart + 3000);
  assert.match(effect, /estimateRequestKey\.current === requestKey\) \{\s*return;/);
  assert.match(
    effect,
    /\.then\(\(result\) => \{\s*if \(estimateRequestKey\.current === requestKey\)/,
  );
});
