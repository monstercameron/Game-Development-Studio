import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineRecovery } from '../runtime/engine-recovery.js';

const definition = { id: '3d-trellis', port: 8285, command: 'C:\\studio\\python.exe' };
const prepared = {
  id: '3d-trellis',
  state: 'prepared',
  nonce: 'a'.repeat(64),
  executables: ['C:\\studio\\python.exe'],
};
const running = { ...prepared, state: 'running', pid: 42, creationTicks: '1234567890123456' };
function fixture(record, { verified = { verified: false }, process = 'indeterminate' } = {}) {
  let current = record,
    cleared = 0,
    bound = 0;
  const journal = {
    read: async () => current,
    bind: async (_id, _nonce, found) => {
      bound++;
      current = {
        ...current,
        state: 'running',
        pid: found.pid,
        creationTicks: found.creationTicks,
      };
      return current;
    },
    clear: async () => {
      cleared++;
      current = null;
    },
  };
  const recovery = new EngineRecovery({
    journal,
    verify: async () => verified,
    probe: async () => ({ state: process }),
  });
  return { recovery, stats: () => ({ current, cleared, bound }) };
}

test('recovery binds a challenged prepared instance', async () => {
  const { recovery, stats } = fixture(prepared, {
    verified: { verified: true, pid: 42, creationTicks: '1234567890123456' },
  });
  const result = await recovery.reconcile(definition);
  assert.equal(result.state, 'recovered');
  assert.equal(result.record.state, 'running');
  assert.equal(stats().bound, 1);
});

test('uncertain processes and prepared records are never cleared', async () => {
  for (const record of [prepared, running]) {
    const { recovery, stats } = fixture(record);
    assert.equal((await recovery.reconcile(definition)).state, 'unresolved');
    assert.equal(stats().cleared, 0);
  }
});

test('only an OS-confirmed exited or reused process clears its bound record', async () => {
  const { recovery, stats } = fixture(running, { process: 'exited_or_reused' });
  assert.equal((await recovery.reconcile(definition)).state, 'none');
  assert.equal(stats().cleared, 1);
  const unknown = fixture(running, { process: 'indeterminate' });
  assert.equal(await unknown.recovery.clearIfExited(definition, running), false);
  assert.equal(unknown.stats().cleared, 0);
});
