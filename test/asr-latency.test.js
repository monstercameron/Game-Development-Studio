import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ASR_LATENCY_MODES,
  DEFAULT_ASR_LATENCY_MS,
  applyAsrLatency,
  asrLatencyArgs,
  readAsrLatency,
  validateAsrLatency,
  writeAsrLatency,
} from '../runtime/asr-latency.js';
import { engineDefinitions, engineStartArgs } from '../runtime/engines.js';

async function settingsFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-asr-latency-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'asr-latency.json');
}

test('latency modes map chunk size to the cache-aware right context', () => {
  assert.deepEqual(ASR_LATENCY_MODES, { 80: 0, 160: 1, 560: 6, 1120: 13 });
  for (const [milliseconds, rightContext] of Object.entries(ASR_LATENCY_MODES)) {
    assert.equal((rightContext + 1) * 80, Number(milliseconds));
  }
  for (const bad of [0, 100, '160', null, 2000]) {
    assert.throws(() => validateAsrLatency(bad), /one of 80, 160, 560, 1120/);
  }
});

test('the saved latency defaults safely and adds no engine argument at 160 ms', async (t) => {
  const file = await settingsFile(t);
  assert.equal(readAsrLatency(file), DEFAULT_ASR_LATENCY_MS, 'no file means the default');
  assert.deepEqual(asrLatencyArgs(file), []);
  await fs.writeFile(file, '{ not json');
  assert.equal(readAsrLatency(file), DEFAULT_ASR_LATENCY_MS, 'a damaged file means the default');
  await fs.writeFile(file, JSON.stringify({ latencyMs: 333 }));
  assert.equal(readAsrLatency(file), DEFAULT_ASR_LATENCY_MS, 'an unknown mode means the default');
  writeAsrLatency(560, file);
  assert.equal(readAsrLatency(file), 560);
  assert.deepEqual(asrLatencyArgs(file), ['--right-context', '6']);
  writeAsrLatency(80, file);
  assert.deepEqual(asrLatencyArgs(file), ['--right-context', '0']);
  writeAsrLatency(160, file);
  assert.deepEqual(asrLatencyArgs(file), []);
  assert.throws(() => writeAsrLatency(99, file), /one of/);
  assert.equal(readAsrLatency(file), 160, 'a rejected value changes nothing');
});

test('the speech engine start command is unchanged at the default and carries a saved latency', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-asr-start-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previous = process.env.FORGE_RUNTIME_DIR;
  process.env.FORGE_RUNTIME_DIR = directory;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FORGE_RUNTIME_DIR;
    } else {
      process.env.FORGE_RUNTIME_DIR = previous;
    }
  });
  const definition = engineDefinitions.find((item) => item.id === 'asr');
  assert.deepEqual(engineStartArgs(definition), definition.args);
  writeAsrLatency(1120);
  assert.deepEqual(engineStartArgs(definition), [...definition.args, '--right-context', '13']);
});

function harness({ running = true, owned = true, stopError = null, startStatus = 202 } = {}) {
  const calls = [];
  let saved = 160;
  return {
    calls,
    saved: () => saved,
    deps: {
      write: (value) => {
        calls.push(`write ${value}`);
        saved = value;
      },
      probe: async () => running,
      managed: async () => owned,
      stop: async () => {
        calls.push('stop');
        if (stopError) {
          throw Error(stopError);
        }
      },
      start: async () => {
        calls.push('start');
        return { status: startStatus, body: { message: 'Starting.' } };
      },
    },
  };
}

test('changing latency restarts an idle engine that Forge owns', async () => {
  const run = harness();
  const result = await applyAsrLatency(560, run.deps);
  assert.deepEqual(run.calls, ['write 560', 'stop', 'start']);
  assert.equal(result.applied, true);
  assert.equal(result.restarted, true);
  assert.equal(result.latencyMs, 560);
});

test('latency is saved without a restart when the engine is stopped', async () => {
  const stopped = harness({ running: false });
  const saved = await applyAsrLatency(80, stopped.deps);
  assert.deepEqual(stopped.calls, ['write 80']);
  assert.equal(saved.applied, true);
  assert.equal(saved.restarted, false);
  assert.match(saved.message, /next time it starts/);
});

test('an unchanged value restarts a running engine, which may still hold another mode', async () => {
  // Regression: after a refused change the saved value (160) differed from the running
  // engine (1120), so an early return reported a mode the engine did not use.
  const run = harness();
  const reapplied = await applyAsrLatency(160, run.deps);
  assert.deepEqual(run.calls, ['write 160', 'stop', 'start']);
  assert.equal(reapplied.restarted, true);
});

test('a busy or foreign engine is left running while the choice is kept', async () => {
  const busy = harness({ stopError: 'Speech sessions are still connected.' });
  const refused = await applyAsrLatency(1120, busy.deps);
  assert.deepEqual(busy.calls, ['write 1120', 'stop'], 'no start after a refused stop');
  assert.equal(refused.applied, false);
  assert.equal(refused.restarted, false);
  assert.match(refused.message, /still connected/);
  assert.equal(busy.saved(), 1120);

  const foreign = harness({ owned: false });
  const external = await applyAsrLatency(1120, foreign.deps);
  assert.deepEqual(foreign.calls, ['write 1120']);
  assert.equal(external.applied, false);
  assert.match(external.message, /not started by Forge/);

  const failed = harness({ startStatus: 409 });
  const notRestarted = await applyAsrLatency(80, failed.deps);
  assert.equal(notRestarted.applied, false);
  assert.equal(notRestarted.restarted, true);
  await assert.rejects(applyAsrLatency(99, harness().deps), /one of/);
});
