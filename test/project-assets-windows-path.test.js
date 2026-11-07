import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoreAsset } from '../project-assets.js';

test(
  'trash restore rejects Windows device and normalized path components without consuming the item',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trash-windows-path-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const trash = path.join(folder, '.forge-trash');
    await fs.mkdir(path.join(folder, 'images'), { recursive: true });
    await fs.mkdir(trash);

    for (const [index, rel] of [
      'images/CON.txt',
      'images/trailing.',
      'images/bad\u0001.png',
    ].entries()) {
      const id = `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, '0')}`;
      const source = path.join(trash, `${id}.asset`);
      await fs.writeFile(source, 'recoverable');
      await fs.writeFile(
        path.join(trash, `${id}.json`),
        JSON.stringify({ path: rel, deletedAt: new Date().toISOString() }),
      );

      await assert.rejects(restoreAsset({ folder }, id), /Invalid original asset path/);
      assert.equal(await fs.readFile(source, 'utf8'), 'recoverable');
    }
  },
);
