import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRemoval } from '../runtime/model-removal.js';

test('managed removal rejects dot path components before touching their targets', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-removal-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const root = path.join(directory, 'models');
  await fs.mkdir(root);
  await fs.writeFile(path.join(directory, 'outside.txt'), 'preserve');

  // A catalog folder of '.' or '..' would resolve to the models root or its parent, so a
  // managed removal of either must be refused before any file under them is touched.
  for (const folder of ['.', '..']) {
    const removal = new ModelRemoval({
      root,
      stateDir: path.join(directory, `state-${folder === '.' ? 'dot' : 'parent'}`),
      models: [{ id: 'test-model', folder }],
    });
    await removal.ready;
    await assert.rejects(removal.begin('test-model'), /not available/);
  }

  assert.equal(await fs.readFile(path.join(directory, 'outside.txt'), 'utf8'), 'preserve');
  assert.equal((await fs.readdir(root)).length, 0);
});
