import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelRemoval } from '../runtime/model-removal.js';
import { renameAsset, restoreAsset, trashAsset } from '../runtime/project-assets.js';

test('recovery-critical asset failures emit bounded, privacy-safe warnings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-asset-logs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const warnings = [];
  const logger = (message) => warnings.push(message);

  const modelsRoot = path.join(root, 'models');
  await fs.mkdir(path.join(modelsRoot, 'test-model'), { recursive: true });
  const removal = new ModelRemoval({
    root: modelsRoot,
    stateDir: path.join(root, 'removal-state'),
    models: [{ id: 'test-model', folder: 'test-model' }],
    remove: async () => {
      const error = Error('private path and details');
      error.code = 'EACCES';
      throw error;
    },
    logger,
  });
  await removal.ready;
  const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const staged = removal.staged('test-model', operation);
  await fs.rename(path.join(modelsRoot, 'test-model'), staged);
  await removal.purge({ id: 'test-model', operation, state: 'deleting', error: null }, staged);
  assert.equal(removal.status('test-model').state, 'failed');
  assert.equal(warnings.shift(), 'WARN operation=model_remove stage=purge error_code=EACCES');

  const folder = path.join(root, 'project-restore');
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, 'images', 'restore.png'), 'asset');
  const project = { folder, assets: [{ id: 'images/restore.png' }] };
  const { trashId } = await trashAsset(project, 'images/restore.png');
  const restoreResult = await restoreAsset(project, trashId, {
    logger,
    unlink: async (file) => {
      if (file.endsWith('.asset')) {
        const error = Error('private path and details');
        error.code = 'EPERM';
        throw error;
      }
      return fs.unlink(file);
    },
  });
  assert.deepEqual(restoreResult, { path: 'images/restore.png', cleanupPending: true });
  assert.equal(
    warnings.shift(),
    'WARN operation=asset_restore stage=backup_cleanup error_code=EPERM',
  );

  const renameFolder = path.join(root, 'project-rename');
  await fs.mkdir(path.join(renameFolder, 'images'), { recursive: true });
  await fs.writeFile(path.join(renameFolder, 'images', 'before.png'), 'asset');
  const renameProject = { folder: renameFolder, assets: [{ id: 'images/before.png' }] };
  await assert.rejects(
    renameAsset(renameProject, 'images/before.png', 'after.png', {
      logger,
      unlink: async (file) => {
        const error = Error('private path and details');
        error.code = file.endsWith('before.png') ? 'EIO' : 'EPERM';
        throw error;
      },
    }),
    /Rename could not finish/,
  );
  assert.equal(warnings.shift(), 'WARN operation=asset_rename stage=rollback error_code=EPERM');
  // The raw error messages above contain private paths, so nothing else may be logged.
  assert.deepEqual(warnings, []);
});
