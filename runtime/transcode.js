import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLogger, traceEnv } from './app-log.js';
import { backfillAssetMeta, recordConversion } from './asset-metadata.js';
import { convertModelAsset, isModelAsset } from './model-convert.js';
import { fsyncFile } from './durable-file.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python =
  process.env.FORGE_TRANSCODE_PYTHON ||
  path.join(path.dirname(root), 'Snapdargon-DJ', '.runtime', 'python.exe');
const script = path.join(root, 'runtime', 'transcode.py');
const log = createLogger('transcode');
const formats = {
  image: { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp', tga: 'tga' },
  audio: { wav: 'wav', mp3: 'mp3', ogg: 'ogg', opus: 'opus', flac: 'flac' },
  // WebM (VP8) is poorly supported by game engines and editors; MP4 (H.264 + AAC) is not.
  video: { mp4: 'mp4', gif: 'gif' },
};

function run(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The worker logs to the studio log under the caller's trace id.
      env: { ...process.env, ...traceEnv(), FORGE_LOG_PROCESS: 'transcode' },
    });
    const startedAt = performance.now();
    const fields = { kind: input.kind, format: input.format };
    log.info('transcode.process.spawned', { ...fields, pid: child.pid });
    let stdout = '',
      stderr = '',
      settled = false;
    const timer = setTimeout(() => {
      log.warn('transcode.process.timed_out', { ...fields, pid: child.pid, limitMs: 300000 });
      child.kill();
      finish(Error('Conversion took too long. Try a smaller file.'));
    }, 300000);
    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    child.on('error', (error) => {
      log.error('transcode.process.failed', { ...fields, error });
      finish(
        Error(
          error.code === 'ENOENT'
            ? 'Conversion runtime is missing. Check the conversion setup in the README.'
            : error.message,
        ),
      );
    });
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-8000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('close', (code) => {
      const durationMs = Math.round(performance.now() - startedAt);
      log.info('transcode.process.exited', { ...fields, exitCode: code, durationMs });
      if (code !== 0) {
        return finish(Error(stderr.trim().split(/\r?\n/).pop() || 'Conversion failed.'));
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch (error) {
        log.warn('transcode.result.invalid', { ...fields, error });
        finish(Error('Conversion returned an invalid result.'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export async function convertAsset(project, input) {
  const asset = project.assets.find((item) => item.id === input.path);
  if (!asset) {
    throw Error('Asset not found.');
  }
  // 3D models convert between mesh formats in their own helper (see model-convert.js).
  if (isModelAsset(asset)) {
    return convertModelAsset(project, asset, input);
  }
  const kind = ['Images', 'Masks'].includes(asset.category)
    ? 'image'
    : asset.category === 'Audio'
      ? 'audio'
      : asset.category === 'Video'
        ? 'video'
        : null;
  if (!kind || !Object.hasOwn(formats[kind], input.format || '')) {
    throw Error('Choose a supported format for this asset.');
  }
  const quality = input.quality === undefined ? 90 : Number(input.quality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw Error('Quality must be between 1 and 100.');
  }
  const background = input.background || '#ffffff';
  if (!/^#[0-9a-f]{6}$/i.test(background)) {
    throw Error('Choose a valid background color.');
  }
  const rootReal = await fs.realpath(project.folder),
    source = await fs.realpath(path.resolve(project.folder, ...asset.id.split('/')));
  const rel = path.relative(rootReal, source);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Error('Asset not found.');
  }
  const parent = path.dirname(source),
    stem = path.basename(source, path.extname(source)),
    extension = formats[kind][input.format];
  const temporary = path.join(parent, `.forge-convert-${randomUUID()}.${extension}`);
  try {
    const result = await run({
      source,
      target: temporary,
      kind,
      format: input.format,
      quality,
      background,
    });
    // Flushed before any final name exists, so a power loss cannot leave a partial conversion
    // under a finished-looking name.
    await fsyncFile(temporary);
    for (let i = 0; i < 10000; i++) {
      const name = `${stem}-converted${i ? `-${i + 1}` : ''}.${extension}`,
        destination = path.join(parent, name);
      try {
        await fs.link(temporary, destination);
        const relative = path.relative(rootReal, destination).split(path.sep).join('/');
        // Make sure an older source has its details so the copy can inherit them.
        backfillAssetMeta(rootReal, project.id, project.assets);
        recordConversion(rootReal, asset.id, relative, { format: input.format });
        return {
          path: relative,
          name,
          backend: result.backend,
          url: `/api/projects/${project.id}/asset?path=${encodeURIComponent(relative)}`,
        };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
    throw Error('Could not find an available name for the converted file.');
  } finally {
    await fs.unlink(temporary).catch((error) => {
      // ENOENT is normal when the conversion failed before writing anything.
      log.debug('transcode.temp.cleanup.failed', { error });
    });
  }
}

// Lower-level entry for jobs that already know the exact source and target files.
export const convertFile = (input) => run(input);
