import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelInventory } from '../runtime/model-inventory.js';
import { ModelRemoval } from '../runtime/model-removal.js';

test('inventory invalidation refreshes a completed snapshot immediately', async () => {
  let scans = 0;
  const inventory = new ModelInventory({
    root: 'fixture',
    models: [],
    ttlMs: 60_000,
    scan: async () => ({ root: 'fixture', entries: [{ files: ++scans }] }),
  });

  inventory.snapshot();
  await inventory.pending;
  assert.equal(inventory.snapshot().entries[0].files, 1);

  inventory.invalidate();
  assert.equal(inventory.snapshot().state, 'scanning');
  await inventory.pending;

  assert.equal(inventory.snapshot().state, 'ready');
  assert.equal(inventory.snapshot().entries[0].files, 2);
});

test('inventory ignores an obsolete scan that finishes after invalidation', async () => {
  const results = [];
  let scans = 0;
  const inventory = new ModelInventory({
    root: 'fixture',
    models: [],
    ttlMs: 60_000,
    scan: () => {
      scans++;
      return new Promise((resolve) => results.push(resolve));
    },
  });

  assert.equal(inventory.snapshot().state, 'scanning');
  inventory.invalidate();
  results[0]({ root: 'fixture', entries: [{ version: 'stale' }] });
  await inventory.pending;

  assert.equal(inventory.value, null);
  assert.equal(inventory.snapshot().state, 'scanning');
  assert.equal(scans, 2);
  results[1]({ root: 'fixture', entries: [{ version: 'current' }] });
  await inventory.pending;
  assert.equal(inventory.snapshot().entries[0].version, 'current');
});

test('managed removal rejects a model-folder link and preserves its target', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-model-guard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'models');
  const stateDir = path.join(dir, 'state');
  const external = path.join(dir, 'external');
  await fs.mkdir(root);
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'weights.bin'), 'preserve');
  try {
    await fs.symlink(external, path.join(root, 'fixture-model'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('Directory symlinks are unavailable in this environment.');
      return;
    }
    throw error;
  }

  const removal = new ModelRemoval({
    root,
    stateDir,
    models: [{ id: 'fixture-model', folder: 'fixture-model' }],
  });
  await removal.ready;

  await assert.rejects(removal.begin('fixture-model'), /link or unexpected directory/);
  assert.equal(await fs.readFile(path.join(external, 'weights.bin'), 'utf8'), 'preserve');
  assert.equal((await fs.lstat(path.join(root, 'fixture-model'))).isSymbolicLink(), true);
});
