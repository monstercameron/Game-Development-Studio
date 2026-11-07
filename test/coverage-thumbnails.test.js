import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readThumbnail, saveThumbnail } from '../runtime/thumbnails.js';

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function makeAsset(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-thumbnail-runtime-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const id = 'images/asset.png';
  await fs.mkdir(path.join(folder, 'images'));
  const file = path.join(folder, ...id.split('/'));
  await fs.writeFile(file, 'original asset');
  const stat = await fs.stat(file);
  const asset = { id, size: stat.size, modified: stat.mtime.toISOString() };
  return { project: { folder }, file, asset };
}

function thumbnailInput(asset) {
  return { image, size: asset.size, modified: asset.modified };
}

test('thumbnail save revalidates and accepts an unchanged source asset', async (t) => {
  const { project, asset } = await makeAsset(t);

  assert.deepEqual(await saveThumbnail(project, asset, thumbnailInput(asset)), { saved: true });
  assert.deepEqual(await readThumbnail(project, asset), Buffer.from(image.split(',')[1], 'base64'));
});

test('thumbnail save rejects a source asset that changed after its metadata was read', async (t) => {
  const { project, file, asset } = await makeAsset(t);
  await fs.writeFile(file, 'replacement asset with a different size');

  await assert.rejects(saveThumbnail(project, asset, thumbnailInput(asset)), {
    message: 'Asset changed while its thumbnail was being created.',
  });
  await assert.rejects(fs.access(path.join(project.folder, '.forge-thumbnails')), {
    code: 'ENOENT',
  });
});

test('thumbnail save rejects a source asset that disappeared after its metadata was read', async (t) => {
  const { project, file, asset } = await makeAsset(t);
  await fs.unlink(file);

  await assert.rejects(saveThumbnail(project, asset, thumbnailInput(asset)), { code: 'ENOENT' });
});

test('thumbnail save rejects a source asset redirected through a symlink', async (t) => {
  const { project, file, asset } = await makeAsset(t);
  const replacementFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-thumbnail-link-'));
  t.after(() => fs.rm(replacementFolder, { recursive: true, force: true }));
  await fs.writeFile(path.join(replacementFolder, 'asset.png'), 'replacement asset');
  await fs.rm(path.dirname(file), { recursive: true });
  try {
    await fs.symlink(replacementFolder, path.dirname(file), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip(`Directory symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(saveThumbnail(project, asset, thumbnailInput(asset)), {
    message: 'Invalid thumbnail asset.',
  });
});
