import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python =
  process.env.FORGE_TRANSCODE_PYTHON ||
  path.join(path.dirname(root), 'Snapdargon-DJ', '.runtime', 'python.exe');
const script = path.join(root, 'runtime', 'transcode.py');
const formats = {
  image: { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp', tga: 'tga' },
  audio: { wav: 'wav', mp3: 'mp3', ogg: 'ogg', opus: 'opus', flac: 'flac' },
};

function run(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '',
      settled = false;
    const timer = setTimeout(() => {
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
    child.on('error', (error) =>
      finish(
        Error(
          error.code === 'ENOENT'
            ? 'Conversion runtime is missing. Check the conversion setup in the README.'
            : error.message,
        ),
      ),
    );
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-8000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(Error(stderr.trim().split(/\r?\n/).pop() || 'Conversion failed.'));
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
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
  const kind = ['Images', 'Masks'].includes(asset.category)
    ? 'image'
    : asset.category === 'Audio'
      ? 'audio'
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
    for (let i = 0; i < 10000; i++) {
      const name = `${stem}-converted${i ? `-${i + 1}` : ''}.${extension}`,
        destination = path.join(parent, name);
      try {
        await fs.link(temporary, destination);
        const relative = path.relative(rootReal, destination).split(path.sep).join('/');
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
    await fs.unlink(temporary).catch(() => {});
  }
}
