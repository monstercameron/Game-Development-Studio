import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLogLines } from '../src/diagnostics-filter.js';

test('error filtering keeps Python and JavaScript stack context for copying', () => {
  const lines = [
    '2026 INFO started',
    'Traceback (most recent call last):',
    '  File "worker.py", line 8, in run',
    '    load_model()',
    'RuntimeError: CUDA unavailable',
    '2026 INFO retrying',
    'Error: request failed',
    '    at submit (worker.js:42:9)',
    '2026 INFO idle',
  ];
  assert.deepEqual(
    filterLogLines(lines, { errorsOnly: true }),
    lines.slice(1, 5).concat(lines.slice(6, 8)),
  );
  assert.deepEqual(
    filterLogLines(lines, { errorsOnly: true, query: 'worker.py' }),
    lines.slice(1, 5),
  );
  assert.deepEqual(filterLogLines(lines, { query: 'retrying' }), ['2026 INFO retrying']);
  const logged = [
    '2026 ERROR model failed',
    'Traceback (most recent call last):',
    '  File "worker.py", line 8',
    'RuntimeError: CUDA unavailable',
    '2026 INFO retrying',
  ];
  assert.deepEqual(
    filterLogLines(logged, { errorsOnly: true, query: 'model failed' }),
    logged.slice(0, 4),
  );
});
