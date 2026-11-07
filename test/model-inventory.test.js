import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectModelInventory,
  ModelInventory,
  managedModels,
} from '../runtime/model-inventory.js';
import { ModelRemoval } from '../runtime/model-removal.js';

test('inventory measures only managed folders and reports missing folders and links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-model-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'model', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'model', 'a'), 'abc');
  await fs.writeFile(path.join(root, 'model', 'nested', 'b'), '12345');
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-model-external-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, 'outside'), 'outside must not be counted');
  let linked = false;
  try {
    await fs.symlink(external, path.join(root, 'model', 'linked'), 'junction');
    linked = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      throw error;
    }
  }
  const result = await inspectModelInventory({
    root,
    models: [
      { id: 'test', folder: 'model' },
      { id: 'absent', folder: 'missing' },
    ],
  });
  assert.equal(result.entries[0].bytes, 8);
  assert.equal(result.entries[0].files, 2);
  assert.equal(result.entries[0].skippedLinks, linked ? 1 : 0);
  assert.equal(result.entries[1].installed, false);
  assert.equal(result.entries[1].bytes, 0);
});

test('inventory returns immediately, deduplicates scans, and retains the last snapshot during refresh', async () => {
  let resolve,
    scans = 0;
  const scan = () => {
    scans++;
    return new Promise((r) => (resolve = r));
  };
  const inventory = new ModelInventory({ root: 'test', models: [], ttlMs: 0, scan });
  assert.equal(inventory.snapshot().state, 'scanning');
  assert.equal(inventory.snapshot().state, 'scanning');
  assert.equal(scans, 1);
  resolve({ root: 'test', entries: [{ id: 'one', bytes: 42 }] });
  await inventory.pending;
  const refreshing = inventory.snapshot();
  assert.equal(refreshing.state, 'scanning');
  assert.equal(refreshing.entries[0].bytes, 42);
  assert.equal(scans, 2);
  resolve({ root: 'test', entries: [] });
  await inventory.pending;
});

test('TRELLIS checkpoints are inventoried but cannot be removed until safe lifecycle management is connected', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trellis-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const models = managedModels.filter((item) =>
    ['3d-trellis', 'trellis-decoder', 'trellis-encoder'].includes(item.id),
  );
  assert.equal(models.length, 3);
  for (const model of models) {
    await fs.mkdir(path.join(root, model.folder));
    await fs.writeFile(path.join(root, model.folder, 'weights'), 'asset');
  }
  const inventory = await inspectModelInventory({ root, models });
  assert.deepEqual(
    inventory.entries.map((item) => [item.id, item.bytes, item.removable]),
    [
      ['3d-trellis', 5, false],
      ['trellis-decoder', 5, false],
      ['trellis-encoder', 5, false],
    ],
  );
  const removal = new ModelRemoval({
    root,
    stateDir: path.join(root, 'state'),
    models,
    checkStopped: async () => {},
  });
  await removal.ready;
  for (const model of models) {
    await assert.rejects(removal.begin(model.id), /not available for managed removal/);
  }
  for (const model of models) {
    assert.equal(await fs.readFile(path.join(root, model.folder, 'weights'), 'utf8'), 'asset');
  }
});
