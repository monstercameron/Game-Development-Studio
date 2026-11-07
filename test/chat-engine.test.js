import test from 'node:test';
import assert from 'node:assert/strict';
import { engineDefinitions, engineStartArgs } from '../runtime/engines.js';
import { estimateChatMemory, validateChatContext } from '../runtime/chat-memory.js';
test('Qwen GPU startup enables MTP by default and disables it only on request', () => {
  const def = engineDefinitions.find((x) => x.id === 'chat');
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(value(engineStartArgs(def), '--spec-type'), 'draft-mtp');
  assert.equal(value(engineStartArgs(def, { speculative: false }), '--spec-type'), 'none');
  assert.equal(value(engineStartArgs(def, { speculative: false }), '--n-gpu-layers'), 'all');
  assert.equal(value(def.args, '--spec-type'), 'draft-mtp');
  assert.notEqual(
    def.recoverable,
    true,
    'An unguarded chat server must not be registered as a recoverable guarded engine',
  );
});

test('Qwen context setting reaches the CUDA server and memory estimate increases', () => {
  const def = engineDefinitions.find((x) => x.id === 'chat'),
    args = engineStartArgs(def, { contextSize: 32768 });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--ctx-size'), '32768');
  assert.equal(value('--parallel'), '1');
  assert.equal(value('--n-gpu-layers'), 'all');
  assert.equal(def.args[def.args.indexOf('--ctx-size') + 1], '4096');
  const base = estimateChatMemory(4096),
    large = estimateChatMemory(32768);
  assert.equal(base.contextMiB, 405);
  assert.equal(large.contextMiB, 2197);
  assert.ok(large.estimatedGpuMiB > base.estimatedGpuMiB);
  assert.ok(large.gpuBudgetMiB > base.gpuBudgetMiB);
  assert.throws(() => validateChatContext(99999), /supported/);
  assert.throws(() => engineStartArgs(def, { contextSize: -1 }), /supported/);
});
