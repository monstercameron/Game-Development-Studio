import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMAGE_BUDGET_MIB,
  createImagePreparation,
  imageBudgetMiB,
} from '../runtime/image-preparation.js';

// Budgets in this file are MiB; one GiB is 1024 MiB.
const GiB = 1024;

test('image GPU budget grows with the requested size', () => {
  const small = imageBudgetMiB({ width: 512, height: 512 }, true);
  const large = imageBudgetMiB({ width: 2752, height: 1536 }, true);
  assert.ok(large > small * 4, 'a 4 MP render needs far more working memory than a 0.26 MP one');
  // About 37 GiB of working memory on top of a resident model matches the measured 73 GiB peak.
  assert.ok(large > 36 * GiB && large < 50 * GiB);
});

test('image GPU budget covers the model when it is not loaded yet', () => {
  assert.equal(imageBudgetMiB({ width: 512, height: 512 }, false), IMAGE_BUDGET_MIB);
  assert.ok(imageBudgetMiB({ width: 2752, height: 1536 }, false) > IMAGE_BUDGET_MIB);
  // Without a size (match-the-reference mode) a typical one-megapixel working set is assumed.
  assert.ok(imageBudgetMiB({}, true) > 10 * GiB);
});

test('a large render waits for GPU memory even when the model is already loaded', async () => {
  const hardware = async () => ({ devices: [{ index: 0, name: 'GPU', freeMiB: 20 * GiB }] });
  const prepare = createImagePreparation({ hardware, services: async () => [] });
  const small = await prepare({ width: 512, height: 512 }, true);
  assert.equal(small, null);
  const large = await prepare({ width: 2752, height: 1536 }, true);
  assert.equal(large?.status, 'waiting_memory');
});
