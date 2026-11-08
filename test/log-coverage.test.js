// tools/log-coverage.mjs on small fixtures (test/fixtures/log-coverage/).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeFile, findBrowserBundledFiles, summarizeBands } from '../tools/log-coverage.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => path.join(repositoryRoot, 'test', 'fixtures', 'log-coverage', name);
const tool = path.join(repositoryRoot, 'tools', 'log-coverage.mjs');

function openKinds(result) {
  return result.signals
    .filter((signal) => !signal.logged && !signal.ignored)
    .map((signal) => `${signal.line}:${signal.kind}`);
}

test('an unlogged file lists every signal with its line', () => {
  const result = analyzeFile(fixture('missing.js'));
  assert.equal(result.logCalls, 0);
  assert.deepEqual(openKinds(result), [
    '6:fs-write',
    '7:empty-catch',
    '8:external-call',
    '9:state-transition',
    '10:process-spawn',
    '13:swallowed-catch',
    '21:fire-and-forget',
  ]);
  assert.equal(result.missingRequired, 5);
  assert.equal(result.gapScore, 5 * 3 + 2);
  const rethrow = result.signals.find((signal) => signal.kind === 'rethrow-catch');
  assert.equal(rethrow.logged, true);
});

test('logged signals, ignore comments and handler bodies count as covered', () => {
  const result = analyzeFile(fixture('logged.js'));
  assert.deepEqual(openKinds(result), []);
  assert.equal(result.gapScore, 0);
  assert.equal(result.signals.filter((signal) => signal.ignored).length, 2);
  assert.ok(
    result.signals
      .filter((signal) => signal.kind === 'process-handler')
      .every((signal) => signal.logged),
    'a handler that logs in its (named or inline) body is covered',
  );
});

test('Python heuristics find empty excepts, spawns and logged blocks', () => {
  const result = analyzeFile(fixture('worker.py'));
  assert.deepEqual(openKinds(result), ['10:fs-write', '11:empty-catch', '13:process-spawn']);
  assert.equal(result.logCalls, 2);
});

test('a pure helper needs no logging and --check passes', () => {
  assert.equal(analyzeFile(fixture('pure.js')).signals.length, 0);
  const pure = spawnSync(process.execPath, [tool, '--check', fixture('pure.js')], {
    encoding: 'utf8',
  });
  assert.equal(pure.status, 0, pure.stderr);
  const logged = spawnSync(process.execPath, [tool, '--check', fixture('logged.js')], {
    encoding: 'utf8',
  });
  assert.equal(logged.status, 0, logged.stderr);
  const missing = spawnSync(process.execPath, [tool, '--check', fixture('missing.js')], {
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /5 required signal/);
  const json = spawnSync(process.execPath, [tool, fixture('missing.js'), '--json'], {
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(json.stdout).file, 'test/fixtures/log-coverage/missing.js');
});

test('bands group files by gap score', () => {
  assert.deepEqual(
    summarizeBands([
      { gapScore: 0 },
      { gapScore: 3 },
      { gapScore: 9 },
      { gapScore: 20 },
      { gapScore: 99 },
    ]),
    { 0: 1, '1-5': 1, '6-15': 1, '16-40': 1, '41+': 1 },
  );
});

test('modules bundled into the browser never import the Node logger', () => {
  const bundled = findBrowserBundledFiles();
  assert.ok(bundled.has('runtime/queue-order.js'), 'src/ imports runtime/queue-order.js');
  assert.ok(bundled.has('runtime/log-fields.js'));
  const offenders = [...bundled]
    .map((file) => analyzeFile(path.join(repositoryRoot, file)))
    .filter((result) => result.signals.some((signal) => signal.kind === 'browser-node-logger'))
    .map((result) => result.file);
  assert.deepEqual(offenders, [], 'use runtime/shared-log.js in these files');
});
