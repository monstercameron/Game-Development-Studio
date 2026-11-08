import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFileExclusive } from './durable-file.js';
import { audioClipPattern, videoClipPattern } from './video-options.js';

// Reference videos and audio for H3 come from the project's own assets. Like staged images
// they are copied at queue time, so a later edit or deletion cannot change a queued render.
export const MAX_CLIP_BYTES = { video: 64 * 1024 * 1024, audio: 32 * 1024 * 1024 };
const kinds = {
  '.webm': 'video',
  '.mp4': 'video',
  '.wav': 'audio',
  '.mp3': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  '.opus': 'audio',
};
export const clipKind = (name) => kinds[path.extname(String(name)).toLowerCase()] || null;

async function inputDirectory(projectFolder, create = false) {
  const root = await fs.realpath(projectFolder),
    dir = path.join(root, '.forge-inputs');
  if (create) {
    await fs.mkdir(dir, { recursive: true });
  }
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(dir)) !== dir) {
    throw Error('Project reference folder is missing or is a link.');
  }
  return dir;
}
export async function stageProjectClip(projectFolder, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\\') ||
    relative
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  ) {
    throw Error('Invalid project asset path.');
  }
  const kind = clipKind(relative);
  if (!kind) {
    throw Error('Choose a WebM or MP4 video, or a WAV, MP3, FLAC, OGG or Opus audio file.');
  }
  const root = await fs.realpath(projectFolder);
  let real;
  try {
    real = await fs.realpath(path.resolve(root, ...relative.split('/')));
  } catch (error) {
    // The raw filesystem error names a local path.
    throw error?.code === 'ENOENT' ? Error('That asset is not in the project.') : error;
  }
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Error('Asset must be inside the project.');
  }
  const info = await fs.stat(real);
  if (!info.isFile() || info.size < 1 || info.size > MAX_CLIP_BYTES[kind]) {
    throw Error(`The ${kind} must be a file of at most ${MAX_CLIP_BYTES[kind] / 1024 / 1024} MiB.`);
  }
  const dir = await inputDirectory(root, true),
    id = `${randomUUID()}${path.extname(real).toLowerCase()}`;
  await copyFileExclusive(real, path.join(dir, id));
  return { id, kind, size: info.size };
}
// Resolves a staged clip to its file, rechecking type and link status when the job runs.
export async function stagedClipPath(projectFolder, id, kind) {
  const pattern = kind === 'video' ? videoClipPattern : audioClipPattern;
  if (typeof id !== 'string' || !pattern.test(id)) {
    throw Error(`Provide a staged reference ${kind} ID.`);
  }
  const dir = await inputDirectory(projectFolder),
    file = path.join(dir, id),
    info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CLIP_BYTES[kind]) {
    throw Error(`Reference ${kind} is missing, too large, or is a link.`);
  }
  return file;
}
