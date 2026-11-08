// Validation and safe extraction of a 3D model or archive the user downloaded themselves.
//
// This module never touches the network. It receives a file already staged inside a project's
// hidden `.forge-staging` folder, checks it, expands it into a second staging folder and renames
// the result into the project's `3d/` folder. Every error thrown as ImportError is safe to show.
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZipEntry, readZipDirectory, ZipError } from './zip-reader.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const IMPORT_LIMITS = Object.freeze({
  maxUploadBytes: 2 * GiB,
  maxExpandedBytes: 6 * GiB,
  maxFileBytes: 4 * GiB,
  maxEntries: 5000,
  maxRatio: 200,
  ratioFloorBytes: 100 * MiB,
  maxNoteBytes: 1 * MiB,
  maxMetadataBytes: 64 * 1024,
  freeSpaceMarginBytes: 256 * MiB,
  maxPathLength: 200,
  maxSegmentLength: 120,
});

export const MODEL_EXTENSIONS = Object.freeze(['.glb', '.gltf', '.fbx', '.obj', '.ply', '.stl']);
export const ARCHIVE_EXTENSIONS = Object.freeze(['.zip']);
export const UPLOAD_EXTENSIONS = Object.freeze([...ARCHIVE_EXTENSIONS, ...MODEL_EXTENSIONS]);
const SUPPORT_EXTENSIONS = new Set(['.mtl', '.bin']);
const TEXTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tga', '.bmp', '.exr']);
const NOTE_EXTENSIONS = new Set(['.json', '.txt']);
// Files that run code or install software. Their presence rejects the whole archive.
const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.sys',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.msp',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsh',
  '.js',
  '.mjs',
  '.cjs',
  '.jse',
  '.jar',
  '.lnk',
  '.url',
  '.reg',
  '.hta',
  '.cpl',
  '.sh',
  '.py',
  '.pyc',
  '.apk',
  '.app',
  '.appx',
  '.msix',
  '.dmg',
  '.pkg',
  '.so',
  '.dylib',
  '.pif',
  '.gadget',
  '.scf',
  '.chm',
]);
const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
// eslint-disable-next-line no-control-regex -- Reject the whole control-character range.
const INVALID_SEGMENT_CHARACTERS = /[<>:"|?*\u0000-\u001f]/;

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Lower-case file extension including the dot, or an empty string. */
export function extensionOf(name) {
  return path.extname(String(name)).toLowerCase();
}

/**
 * Validates a user-supplied file name for upload. Returns the safe base name.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanUploadName(value) {
  const base = String(value ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .trim();
  if (!base || base.length > 150 || INVALID_SEGMENT_CHARACTERS.test(base)) {
    throw new ImportError('Choose a file with a plain name of up to 150 characters.');
  }
  if (!UPLOAD_EXTENSIONS.includes(extensionOf(base))) {
    throw new ImportError(
      `Choose a ZIP archive or a ${MODEL_EXTENSIONS.join(', ')} model. Unreal Engine packages are not supported.`,
    );
  }
  if (RESERVED_WINDOWS_NAME.test(base) || /[. ]$/.test(base)) {
    throw new ImportError('Choose a file with a different name.');
  }
  return base;
}

/**
 * Turns an archive member name into safe relative path segments, or throws ImportError.
 * Rejects absolute paths, drive letters, `..`, alternate data streams and reserved names.
 * @param {string} name
 * @returns {string[]}
 */
export function safeSegments(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
    throw new ImportError('The archive contains an invalid file name.');
  }
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new ImportError('The archive contains an absolute path, which is not allowed.');
  }
  const segments = [];
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new ImportError('The archive tries to write outside its folder and was rejected.');
    }
    if (
      INVALID_SEGMENT_CHARACTERS.test(segment) ||
      RESERVED_WINDOWS_NAME.test(segment) ||
      /[. ]$/.test(segment) ||
      segment.length > IMPORT_LIMITS.maxSegmentLength
    ) {
      throw new ImportError('The archive contains a file name that Windows cannot store safely.');
    }
    segments.push(segment);
  }
  if (!segments.length || segments.join('/').length > IMPORT_LIMITS.maxPathLength) {
    throw new ImportError('The archive contains a missing or overlong file name.');
  }
  return segments;
}

function classify(extension) {
  if (MODEL_EXTENSIONS.includes(extension)) {
    return 'model';
  }
  if (SUPPORT_EXTENSIONS.has(extension)) {
    return 'support';
  }
  if (TEXTURE_EXTENSIONS.has(extension)) {
    return 'texture';
  }
  if (NOTE_EXTENSIONS.has(extension)) {
    return 'note';
  }
  return null;
}

/**
 * Decides which members of an archive are extracted, or throws ImportError.
 * @param {object[]} entries Entries from readZipDirectory.
 * @param {Partial<typeof IMPORT_LIMITS>} [overrides] Limits, for tests.
 */
export function planArchive(entries, overrides = {}) {
  const limits = { ...IMPORT_LIMITS, ...overrides };
  if (entries.length > limits.maxEntries) {
    throw new ImportError(`The archive has more than ${limits.maxEntries} files.`);
  }
  const files = [];
  const seen = new Set();
  let skipped = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isEncrypted) {
      throw new ImportError('Encrypted ZIP archives are not supported.');
    }
    if (entry.isSymlink) {
      throw new ImportError('The archive contains a symbolic link and was rejected.');
    }
    const segments = safeSegments(entry.name);
    if (entry.isDirectory) {
      continue;
    }
    const extension = extensionOf(segments.at(-1));
    if (BLOCKED_EXTENSIONS.has(extension)) {
      throw new ImportError(
        `The archive contains an executable or script (${extension}) and was rejected.`,
      );
    }
    const kind = classify(extension);
    if (!kind) {
      skipped++;
      continue;
    }
    if (entry.size > limits.maxFileBytes) {
      throw new ImportError('A file in the archive is larger than the 4 GiB limit.');
    }
    if (
      entry.size > limits.ratioFloorBytes &&
      entry.size > Math.max(entry.compressedSize, 1) * limits.maxRatio
    ) {
      throw new ImportError('The archive expands far more than expected and was rejected.');
    }
    if (kind === 'note' && entry.size > limits.maxNoteBytes) {
      skipped++;
      continue;
    }
    const key = segments.join('/').toLowerCase();
    if (seen.has(key)) {
      throw new ImportError('The archive contains the same file name twice.');
    }
    seen.add(key);
    totalBytes += entry.size;
    if (totalBytes > limits.maxExpandedBytes) {
      throw new ImportError('The archive would expand to more than 6 GiB.');
    }
    files.push({ entry, segments, kind, size: entry.size });
  }
  if (!files.some((file) => file.kind === 'model')) {
    throw new ImportError(
      'No supported 3D model was found in the archive. Forge imports GLB, glTF, FBX, OBJ, PLY and STL; Unreal Engine packages are not supported.',
    );
  }
  // A single wrapper folder around everything adds nothing to the project.
  if (
    files.every((file) => file.segments.length > 1 && file.segments[0] === files[0].segments[0])
  ) {
    for (const file of files) {
      file.segments = file.segments.slice(1);
    }
  }
  return { files, skipped, totalBytes };
}

/** Checks the first bytes of a single model file. Throws ImportError on a mismatch. */
export async function checkModelFile(file, extension) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      throw new ImportError('The file is empty.');
    }
    const head = Buffer.alloc(Math.min(size, 512));
    await handle.read(head, 0, head.length, 0);
    const text = head.toString('latin1');
    const hasNul = head.includes(0);
    const valid =
      extension === '.glb'
        ? text.startsWith('glTF')
        : extension === '.ply'
          ? text.startsWith('ply')
          : extension === '.fbx'
            ? text.startsWith('Kaydara FBX Binary') || /^\s*;\s*FBX/.test(text)
            : extension === '.gltf'
              ? !hasNul && /^\s*\{/.test(text)
              : extension === '.obj'
                ? !hasNul
                : extension === '.stl'
                  ? size >= 84 || /^\s*solid/i.test(text)
                  : false;
    if (!valid) {
      throw new ImportError(`This file does not look like a valid ${extension} model.`);
    }
    return size;
  } finally {
    await handle.close();
  }
}

export function slugify(value, fallback = 'model') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function freeBytes(folder) {
  const stats = await fs.statfs(folder);
  return Number(stats.bavail) * Number(stats.bsize);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('The import was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

async function readMegascansMetadata(directory, plan) {
  // Bridge-style exports carry a small JSON next to the model. It only suggests a title.
  const note = plan.files.find(
    (file) => file.kind === 'note' && file.segments.at(-1).toLowerCase().endsWith('.json'),
  );
  if (!note || note.size > IMPORT_LIMITS.maxMetadataBytes) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, ...note.segments), 'utf8'));
    const name = typeof parsed?.name === 'string' ? parsed.name.trim().slice(0, 120) : '';
    return name ? { title: name } : {};
  } catch {
    return {};
  }
}

/**
 * Validates, expands and moves one staged upload into the project's `3d/` folder.
 *
 * @param {object} job
 * @param {string} job.id Import id, used in output names.
 * @param {string} job.projectFolder Real path of the project folder.
 * @param {string} job.uploadPath Staged upload inside `<project>/.forge-staging/megascans/<id>/`.
 * @param {string} job.stagingDirectory The same folder; work files are created below it.
 * @param {string} job.filename The user's original file name (already cleaned).
 * @param {string} job.title Name used for output folders.
 * @param {AbortSignal} [job.signal]
 * @param {(progress: { bytesDone: number, bytesTotal: number, stage: string }) => void} [job.onProgress]
 * @returns {Promise<{ files: string[], folder: string | null, skipped: number, bytes: number, suggestedTitle?: string }>}
 */
export async function runImport(job) {
  const { id, projectFolder, uploadPath, stagingDirectory, filename, signal, onProgress } = job;
  const extension = extensionOf(filename);
  const shortId = id.slice(0, 8);
  const workDirectory = path.join(stagingDirectory, 'work');
  await fs.rm(workDirectory, { recursive: true, force: true });
  await fs.mkdir(workDirectory, { recursive: true });
  const modelsDirectory = path.join(projectFolder, '3d');
  await fs.mkdir(modelsDirectory, { recursive: true });
  const modelsReal = await fs.realpath(modelsDirectory);
  if (!inside(await fs.realpath(projectFolder), modelsReal)) {
    throw new ImportError('The project folder is not usable.');
  }
  const baseName = slugify(job.title || path.basename(filename, extension));
  const progress = { bytesDone: 0, bytesTotal: 0 };
  const report = (stage) => onProgress?.({ ...progress, stage });
  try {
    if (extension !== '.zip') {
      progress.bytesTotal = await checkModelFile(uploadPath, extension);
      await ensureFreeSpace(projectFolder, progress.bytesTotal);
      report('Copying the model');
      const target = path.join(modelsReal, `${baseName}-${shortId}${extension}`);
      throwIfAborted(signal);
      await moveIntoProject(uploadPath, target);
      progress.bytesDone = progress.bytesTotal;
      report('Saved');
      return {
        files: [`3d/${path.basename(target)}`],
        folder: null,
        skipped: 0,
        bytes: progress.bytesTotal,
      };
    }

    let directory;
    try {
      directory = await readZipDirectory(uploadPath, { maxEntries: IMPORT_LIMITS.maxEntries });
    } catch (error) {
      throw error instanceof ZipError ? new ImportError(error.message) : error;
    }
    const plan = planArchive(directory.entries);
    progress.bytesTotal = plan.totalBytes;
    await ensureFreeSpace(projectFolder, plan.totalBytes);
    report('Extracting');
    const output = path.join(workDirectory, 'out');
    await fs.mkdir(output);
    for (const file of plan.files) {
      throwIfAborted(signal);
      const destination = path.join(output, ...file.segments);
      if (!inside(output, destination)) {
        throw new ImportError('The archive tries to write outside its folder and was rejected.');
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        await extractZipEntry(uploadPath, file.entry, destination, {
          signal,
          archiveSize: directory.size,
          onBytes: (count) => {
            progress.bytesDone += count;
            report('Extracting');
          },
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw error;
        }
        throw error instanceof ZipError
          ? new ImportError(error.message)
          : new ImportError('The archive could not be extracted. It may be damaged.');
      }
    }
    throwIfAborted(signal);
    const suggested = await readMegascansMetadata(output, plan);
    const folderName = `megascans-${slugify(job.title || suggested.title || path.basename(filename, extension))}-${shortId}`;
    const target = path.join(modelsReal, folderName);
    if (!inside(modelsReal, target)) {
      throw new ImportError('The output folder name is not usable.');
    }
    report('Saving to the project');
    await moveIntoProject(output, target);
    const files = plan.files
      .filter((file) => file.kind === 'model')
      .map((file) => `3d/${folderName}/${file.segments.join('/')}`);
    return {
      files,
      folder: `3d/${folderName}`,
      skipped: plan.skipped,
      bytes: plan.totalBytes,
      suggestedTitle: suggested.title,
    };
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

// The staging folder lives in the project, so this is a same-volume rename. It never replaces an
// existing file or folder.
async function moveIntoProject(source, target) {
  try {
    await fs.access(target);
    throw new ImportError('A file with this import name already exists in the project.');
  } catch (error) {
    if (error instanceof ImportError) {
      throw error;
    }
  }
  try {
    await fs.rename(source, target);
  } catch {
    throw new ImportError('Could not save the import into the project folder.');
  }
}

export async function ensureFreeSpace(folder, bytes) {
  if (bytes + IMPORT_LIMITS.freeSpaceMarginBytes > (await freeBytes(folder))) {
    throw new ImportError(
      'There is not enough free disk space on the project drive for this import.',
    );
  }
}
