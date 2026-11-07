import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listTrash, restoreAsset, trashAsset } from '../project-assets.js';

async function makeProject(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-restore-recovery-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'images'));
  await fs.writeFile(path.join(folder, 'images', 'asset.png'), 'asset bytes');
  return { folder, assets: [{ id: 'images/asset.png' }] };
}

function failOnceUnlink(matches) {
  const original = fs.unlink;
  let failed = false;
  fs.unlink = async (...args) => {
    if (!failed && matches(args[0])) {
      failed = true;
      const error = Error('Injected unlink failure.');
      error.code = 'EIO';
      throw error;
    }
    return original(...args);
  };
  return () => {
    fs.unlink = original;
    assert.equal(failed, true, 'unlink failure was not exercised');
  };
}

test('restore reports committed success and keeps its backup when source cleanup fails', async (t) => {
  const project = await makeProject(t);
  const { trashId } = await trashAsset(project, 'images/asset.png');
  const source = path.join(project.folder, '.forge-trash', `${trashId}.asset`);
  const manifest = path.join(project.folder, '.forge-trash', `${trashId}.json`);
  const restoreUnlink = failOnceUnlink((file) => file === source);

  let result;
  try {
    result = await restoreAsset(project, trashId);
  } finally {
    restoreUnlink();
  }

  assert.deepEqual(result, { path: 'images/asset.png', cleanupPending: true });
  assert.equal(
    await fs.readFile(path.join(project.folder, 'images', 'asset.png'), 'utf8'),
    'asset bytes',
  );
  assert.equal(await fs.readFile(source, 'utf8'), 'asset bytes');
  assert.ok(await fs.stat(manifest));
  assert.equal((await listTrash(project)).items[0].trashId, trashId);
});

test('restore reports committed success when only manifest cleanup fails', async (t) => {
  const project = await makeProject(t);
  const { trashId } = await trashAsset(project, 'images/asset.png');
  const source = path.join(project.folder, '.forge-trash', `${trashId}.asset`);
  const manifest = path.join(project.folder, '.forge-trash', `${trashId}.json`);
  const restoreUnlink = failOnceUnlink((file) => file === manifest);

  let result;
  try {
    result = await restoreAsset(project, trashId);
  } finally {
    restoreUnlink();
  }

  assert.deepEqual(result, { path: 'images/asset.png', cleanupPending: true });
  assert.equal(
    await fs.readFile(path.join(project.folder, 'images', 'asset.png'), 'utf8'),
    'asset bytes',
  );
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  assert.ok(await fs.stat(manifest));
  const listing = await listTrash(project);
  assert.deepEqual(listing.items, []);
  assert.match(listing.warnings[0], /incomplete or unreadable and has been preserved/);
});
