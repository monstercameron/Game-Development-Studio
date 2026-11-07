import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelInventory } from '../runtime/model-inventory.js';

test('inventory invalidation prevents a pending scan from refreshing stale data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-swarm-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let resolveScan;
  let scans = 0;
  const inventory = new ModelInventory({
    root,
    models: [],
    ttlMs: 60_000,
    scan: () => {
      scans++;
      if (scans === 1) {
        return new Promise((resolve) => {
          resolveScan = resolve;
        });
      }
      return Promise.resolve({ root, entries: [] });
    },
  });

  assert.equal(inventory.snapshot().state, 'scanning');
  inventory.invalidate();
  resolveScan({ root, entries: [{ id: 'stale', bytes: 12 }] });
  await inventory.pending;

  assert.equal(inventory.snapshot().state, 'scanning');
  assert.equal(scans, 2);
  await inventory.pending;
  assert.deepEqual(inventory.snapshot().entries, []);
});
