import test from 'node:test';
import assert from 'node:assert/strict';
import { readLibraryFiles } from '../src/asset-picker.js';

test('library read failures include a recovery hint and preserve cancellation', async () => {
  const project = { id: 'project' };
  const asset = { id: 'images/portrait.png', name: 'portrait.png', size: 1 };

  await assert.rejects(
    readLibraryFiles(project, [asset], {
      fetchImpl: async () => {
        throw TypeError('Failed to fetch');
      },
    }),
    /Could not read portrait\.png\. Refresh the library and try again\./,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readLibraryFiles(project, [asset], {
      signal: controller.signal,
      fetchImpl: async () => {
        throw controller.signal.reason;
      },
    }),
    (error) => error === controller.signal.reason,
  );
});
