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

test('a loaded model is marked releasable only when a fresh load would fit the whole GPU', async () => {
  const request = { width: 1664, height: 928 };
  const gpu = (totalMiB) => async () => ({
    devices: [{ index: 0, name: 'GPU', freeMiB: 20 * GiB, totalMiB }],
  });
  const wait = (totalMiB, loaded) =>
    createImagePreparation({ hardware: gpu(totalMiB), services: async () => [] })(request, loaded);
  const big = await wait(96 * GiB, true);
  assert.equal(big.status, 'waiting_memory');
  assert.equal(big.details.releasableLoadedModel, true);
  // A card too small to load the model again would only lose the loaded model.
  assert.equal((await wait(40 * GiB, true)).details.releasableLoadedModel, undefined);
  // An unloaded engine has nothing to release.
  assert.equal((await wait(96 * GiB, false)).details.releasableLoadedModel, undefined);
  // Without a reported total nothing is assumed.
  assert.equal((await wait(null, true)).details.releasableLoadedModel, undefined);
});
