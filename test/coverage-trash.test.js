import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listTrash,
  readAssetMetadata,
  renameAsset,
  restoreAsset,
  trashAsset,
  updateAsset,
} from '../project-assets.js';

async function makeProject(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trash-failure-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'images'));
  await fs.writeFile(path.join(folder, 'images', 'asset.png'), 'asset bytes');
  return {
    folder,
    assets: [{ id: 'images/asset.png' }],
  };
}

function failOnce(method, matches) {
  const original = fs[method];
  let failed = false;
  fs[method] = async (...args) => {
    if (!failed && matches(...args)) {
      failed = true;
      const error = Error('Injected filesystem failure.');
      error.code = 'EIO';
      throw error;
    }
    return original(...args);
  };
  return () => {
    fs[method] = original;
    assert.equal(failed, true, `${method} failure was not exercised`);
  };
}

test('rename rolls back its staged destination when metadata cannot be saved', async (t) => {
  const project = await makeProject(t);
  await updateAsset(project, 'images/asset.png', { rating: 4 });
  const restoreRename = failOnce(
    'rename',
    (source, destination) =>
      path.basename(source).startsWith('.forge-assets-') &&
      path.basename(destination) === '.forge-assets.json',
  );
  try {
    await assert.rejects(renameAsset(project, 'images/asset.png', 'renamed.png'), {
      code: 'EIO',
    });
  } finally {
    restoreRename();
  }
  assert.equal(
    await fs.readFile(path.join(project.folder, 'images', 'asset.png'), 'utf8'),
    'asset bytes',
  );
  await assert.rejects(fs.stat(path.join(project.folder, 'images', 'renamed.png')), {
    code: 'ENOENT',
  });
  assert.deepEqual((await readAssetMetadata(project.folder))['images/asset.png'], { rating: 4 });
});

test('trash removes its recovery manifest when moving the asset fails', async (t) => {
  const project = await makeProject(t);
  const restoreRename = failOnce(
    'rename',
    (source, destination) =>
      path.basename(source) === 'asset.png' && path.basename(destination).endsWith('.asset'),
  );
  try {
    await assert.rejects(trashAsset(project, 'images/asset.png'), { code: 'EIO' });
  } finally {
    restoreRename();
  }
  assert.equal(
    await fs.readFile(path.join(project.folder, 'images', 'asset.png'), 'utf8'),
    'asset bytes',
  );
  assert.deepEqual(await listTrash(project), { items: [], warnings: [] });
});

test('restore preserves both trash files when copying the asset fails', async (t) => {
  const project = await makeProject(t);
  const { trashId } = await trashAsset(project, 'images/asset.png');
  const restoreCopy = failOnce(
    'copyFile',
    (_source, destination) => path.basename(destination) === 'asset.png',
  );
  try {
    await assert.rejects(restoreAsset(project, trashId), { code: 'EIO' });
  } finally {
    restoreCopy();
  }
  assert.equal((await listTrash(project)).items[0].trashId, trashId);
  assert.equal(
    await fs.readFile(path.join(project.folder, '.forge-trash', `${trashId}.asset`), 'utf8'),
    'asset bytes',
  );
  await assert.rejects(fs.stat(path.join(project.folder, 'images', 'asset.png')), {
    code: 'ENOENT',
  });
});
