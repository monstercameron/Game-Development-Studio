import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { backfillAssetMeta, recordConversion } from './asset-metadata.js';
import { createLogger } from './app-log.js';
import { fsyncFile } from './durable-file.js';

const log = createLogger('model');

// 3D conversion: GLB, glTF, OBJ, PLY and STL in any direction (except to the same format).
// runtime/model_convert.py does the work in the Hunyuan3D environment, which ships trimesh. It
// is CPU-only file work and loads no model.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'runtime', 'model_convert.py');
const defaultPython = path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe');
export const MODEL_FORMATS = ['glb', 'gltf', 'obj', 'ply', 'stl'];
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export function modelExtension(assetId) {
  const extension = path
    .extname(String(assetId || ''))
    .slice(1)
    .toLowerCase();
  return MODEL_FORMATS.includes(extension) ? extension : null;
}
export function isModelAsset(asset) {
  return asset?.category === '3D' && modelExtension(asset.id) !== null;
}

function runModelHelper(input, python = process.env.FORGE_MODEL_CONVERT_PYTHON || defaultPython) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    log.info('model.convert.process.spawned', { kind: 'model_convert', pid: child.pid });
    const stopProcessTimer = log.time('model.convert.process.exited', {
      kind: 'model_convert',
      pid: child.pid,
    });
    let stdout = '',
      stderr = '',
      settled = false;
    const timer = setTimeout(() => {
      log.warn('model.convert.process.timeout', { kind: 'model_convert', pid: child.pid });
      child.kill();
      finish(Error('Conversion took too long. Try a smaller model.'));
    }, 300000);
    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    child.on('error', (error) =>
      finish(
        Error(
          error.code === 'ENOENT'
            ? '3D conversion needs the Hunyuan3D Python environment (trimesh). Install it, then try again.'
            : error.message,
        ),
      ),
    );
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-16000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('close', (code, signal) => {
      stopProcessTimer({ exitCode: code, signal });
      if (code !== 0) {
        return finish(Error(stderr.trim().split(/\r?\n/).pop() || '3D conversion failed.'));
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch (error) {
        log.warn('model.convert.output.rejected', {
          reason: 'invalid_json',
          errorClass: error.name,
        });
        finish(Error('3D conversion returned an invalid result.'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// Hard links publish each file without replacing one that appeared meanwhile.
async function publish(temporaryFolder, parent, files) {
  const linked = [];
  try {
    for (const file of files) {
      const destination = path.join(parent, file.name);
      // Flushed before the final name exists (see docs/RESILIENCE.md).
      await fsyncFile(path.join(temporaryFolder, file.name));
      await fs.link(path.join(temporaryFolder, file.name), destination);
      linked.push(destination);
    }
    return true;
  } catch (error) {
    await Promise.all(
      linked.map((item) =>
        fs.unlink(item).catch((cleanupError) => {
          log.warn('model.convert.output.rollback.failed', {
            kind: 'output',
            errorCode: cleanupError.code,
          });
        }),
      ),
    );
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

export async function convertModelAsset(project, asset, input, { run = runModelHelper } = {}) {
  const sourceFormat = modelExtension(asset.id);
  if (!MODEL_FORMATS.includes(input.format || '') || input.format === sourceFormat) {
    log.warn('model.convert.rejected', { reason: 'same_or_unsupported_format' });
    throw Error('Choose a different 3D format for this asset.');
  }
  log.info('model.convert.requested', { format: input.format, projectId: project.id });
  const stopConversionTimer = log.time('model.convert.completed', { format: input.format });
  const rootReal = await fs.realpath(project.folder),
    source = await fs.realpath(path.resolve(project.folder, ...asset.id.split('/')));
  const rel = path.relative(rootReal, source);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    log.warn('model.convert.rejected', { reason: 'outside_project' });
    throw Error('Asset not found.');
  }
  const parent = path.dirname(source),
    base = path.basename(source, path.extname(source)),
    temporaryFolder = path.join(parent, `.forge-convert-${randomUUID()}`);
  await fs.mkdir(temporaryFolder);
  try {
    for (let index = 0; index < 1000; index++) {
      const stem = `${base}-converted${index ? `-${index + 1}` : ''}`;
      try {
        await fs.lstat(path.join(parent, `${stem}.${input.format}`));
        continue;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      const result = await run({ source, directory: temporaryFolder, stem, format: input.format });
      // Only plain file names the helper was asked to write are published.
      const files = (Array.isArray(result?.files) ? result.files : []).filter(
        (file) => safeName.test(file?.name || '') && file.name.startsWith(stem),
      );
      const main = files.find((file) => file.role === 'main');
      if (!main) {
        log.warn('model.convert.output.rejected', {
          reason: 'no_main_file',
          fileCount: files.length,
        });
        throw Error('3D conversion did not produce a file.');
      }
      if (!(await publish(temporaryFolder, parent, [main, ...files.filter((f) => f !== main)]))) {
        // A companion file (material or texture) already exists under this name: try the next one.
        for (const file of files) {
          await fs.unlink(path.join(temporaryFolder, file.name)).catch((cleanupError) => {
            log.debug('model.convert.temp.cleanup.failed', {
              kind: 'temporary',
              errorCode: cleanupError.code,
            });
          });
        }
        continue;
      }
      // Make sure an older source has its details so the copies can inherit them.
      backfillAssetMeta(rootReal, project.id, project.assets);
      const published = files.map((file) => ({
        name: file.name,
        role: file.role,
        path: path.relative(rootReal, path.join(parent, file.name)).split(path.sep).join('/'),
      }));
      for (const file of published) {
        recordConversion(rootReal, asset.id, file.path, { format: input.format });
      }
      const mainFile = published.find((file) => file.role === 'main');
      stopConversionTimer({ fileCount: published.length });
      return {
        path: mainFile.path,
        name: mainFile.name,
        backend: typeof result.backend === 'string' ? result.backend.slice(0, 80) : 'trimesh',
        url: `/api/projects/${project.id}/asset?path=${encodeURIComponent(mainFile.path)}`,
        extraFiles: published.filter((file) => file !== mainFile),
        notes: (Array.isArray(result.notes) ? result.notes : [])
          .filter((note) => typeof note === 'string')
          .map((note) => note.slice(0, 300))
          .slice(0, 5),
      };
    }
    throw Error('Could not find an available name for the converted file.');
  } finally {
    await fs.rm(temporaryFolder, { recursive: true, force: true }).catch((cleanupError) => {
      log.warn('model.convert.temp.folder.cleanup.failed', { errorCode: cleanupError.code });
    });
  }
}
