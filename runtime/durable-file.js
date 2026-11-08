// Crash and power-loss safe file helpers. A file that is renamed or linked to its final name
// before its bytes reached the disk can come back after a power failure as a zero-length or
// partial file under a name that looks complete. Every writer that publishes a project artifact
// or a small state file therefore follows one protocol: write a staging name in the same
// directory, fsync the file, rename it into place, then fsync the directory where the platform
// allows it. See docs/RESILIENCE.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from './app-log.js';

const log = createLogger('runtime');

// Windows cannot open a directory for fsync (NTFS journals the rename itself), and some network
// filesystems refuse it. Those cases are expected and are not errors.
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EISDIR',
  'EPERM',
  'EACCES',
  'EBADF',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
]);

// Another process (a virus scanner, the Explorer preview) can hold a destination open for a
// moment; a rename onto it then fails with a transient sharing error on Windows.
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let isDirectorySyncUnsupportedLogged = false;

// Directory sync is unavailable on Windows and some network shares, which is normal. It is
// recorded once per process at debug level rather than on every write.
function logDirectorySyncUnsupportedOnce(error) {
  if (isDirectorySyncUnsupportedLogged) {
    return;
  }
  isDirectorySyncUnsupportedLogged = true;
  log.debug('file.fsync.unsupported', { error });
}

/** Flushes one existing file's data and metadata to stable storage. */
export async function fsyncFile(file) {
  const handle = await fsp.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function fsyncFileSync(file) {
  const descriptor = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Best effort: flushes a directory entry. Returns false where the platform cannot do it. */
export async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) {
      logDirectorySyncUnsupportedOnce(error);
      return false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function fsyncDirectorySync(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) {
      logDirectorySyncUnsupportedOnce(error);
      return false;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        // The descriptor was already unusable; there is nothing left to release.
        log.debug('file.close.failed', { error });
      }
    }
  }
}

function stagingName(file) {
  const base = path.basename(file).replace(/^\./, '');
  return path.join(path.dirname(file), `.${base}.${randomUUID()}.tmp`);
}

/**
 * Replaces `file` with `data` so that a crash leaves either the old complete file or the new
 * complete file, never a mixture. The staging name is hidden and ends in `.tmp`, which the
 * startup sweep (runtime/recovery-sweep.js) recognises.
 * @param {string} file Final path.
 * @param {string|Buffer|Uint8Array} data
 * @param {{ mode?: number }} [options]
 */
export async function atomicWriteFile(file, data, { mode } = {}) {
  const staging = stagingName(file);
  try {
    await fsp.writeFile(staging, data, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    await fsyncFile(staging);
    await renameWithRetry(staging, file);
    await fsyncDirectory(path.dirname(file));
    log.debug('file.write.completed', { kind: 'atomic_write', bytes: Buffer.byteLength(data) });
  } catch (error) {
    log.warn('file.write.failed', { kind: 'atomic_write', bytes: Buffer.byteLength(data), error });
    await fsp.rm(staging, { force: true }).catch((cleanupError) => {
      log.debug('file.staging.cleanup_failed', { error: cleanupError });
    });
    throw error;
  }
}

export function atomicWriteFileSync(file, data, { mode } = {}) {
  const staging = stagingName(file);
  try {
    fs.writeFileSync(staging, data, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    fsyncFileSync(staging);
    fs.renameSync(staging, file);
    fsyncDirectorySync(path.dirname(file));
    log.debug('file.write.completed', { kind: 'atomic_write', bytes: Buffer.byteLength(data) });
  } catch (error) {
    log.warn('file.write.failed', { kind: 'atomic_write', bytes: Buffer.byteLength(data), error });
    try {
      fs.rmSync(staging, { force: true });
    } catch (cleanupError) {
      // The sweep removes an abandoned staging file later; the write error is what matters.
      log.debug('file.staging.cleanup_failed', { error: cleanupError });
    }
    throw error;
  }
}

// Hard links cannot reserve a name on every filesystem (FAT, some network shares).
const LINK_UNSUPPORTED = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV', 'ENOSYS']);

/**
 * Copies `source` to `target` without ever replacing an existing `target` and without exposing a
 * partial copy under the final name. The copy is staged beside the target, flushed, and then
 * linked (or, where hard links are unavailable, renamed after checking the name is free).
 * Throws an error with code EEXIST when `target` exists.
 */
export async function copyFileExclusive(source, target) {
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.part`);
  try {
    await fsp.copyFile(source, staging, fs.constants.COPYFILE_EXCL);
    await fsyncFile(staging);
    try {
      await fsp.link(staging, target);
    } catch (error) {
      if (!LINK_UNSUPPORTED.has(error.code)) {
        throw error;
      }
      const occupied = await fsp.lstat(target).then(
        () => true,
        (lookup) => {
          if (lookup.code !== 'ENOENT') {
            throw lookup;
          }
          return false;
        },
      );
      if (occupied) {
        throw Object.assign(Error('The destination already exists.'), { code: 'EEXIST' });
      }
      await fsp.rename(staging, target);
    }
    await fsyncDirectory(path.dirname(target));
  } finally {
    await fsp.rm(staging, { force: true }).catch(() => {});
  }
}

/** Renames over an existing file, retrying a transient Windows sharing violation. */
export async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME.has(error.code) || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }
      log.debug('file.rename.retried', { attempt, error });
      await sleep(20 * attempt);
    }
  }
}

/**
 * Moves a damaged or unwanted file next to itself under a recognisable name instead of deleting
 * it. Returns the new path. The caller decides what replaces it.
 */
export async function moveAside(file, label = 'corrupt') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  let target = `${file}.${label}-${stamp}`;
  for (let n = 2; ; n++) {
    try {
      await fsp.access(target);
      // log-coverage: ignore -- probing for a free name; a missing name is the normal outcome.
    } catch {
      break;
    }
    target = `${file}.${label}-${stamp}-${n}`;
  }
  await fsp.rename(file, target);
  log.warn('file.moved_aside.completed', { kind: label });
  return target;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TRAILER = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

async function readRange(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

// Each checker gets an open handle and the size. A `structural` result means the end of the
// file was checked too, so a truncated file cannot pass; `header` means only the start could be.
const CHECKS = {
  async glb(handle, size) {
    const head = await readRange(handle, 0, 12);
    if (head.length < 12 || head.toString('latin1', 0, 4) !== 'glTF') {
      return { ok: false, reason: 'not a glTF binary' };
    }
    if (head.readUInt32LE(8) !== size) {
      return { ok: false, reason: 'length field does not match the file size (truncated)' };
    }
    return { ok: true, level: 'structural' };
  },
  async png(handle, size) {
    if (size < PNG_SIGNATURE.length + PNG_TRAILER.length) {
      return { ok: false, reason: 'too small to be a PNG' };
    }
    const head = await readRange(handle, 0, PNG_SIGNATURE.length);
    if (!head.equals(PNG_SIGNATURE)) {
      return { ok: false, reason: 'not a PNG' };
    }
    const tail = await readRange(handle, size - PNG_TRAILER.length, PNG_TRAILER.length);
    return tail.equals(PNG_TRAILER)
      ? { ok: true, level: 'structural' }
      : { ok: false, reason: 'PNG end marker missing (truncated)' };
  },
  async wav(handle, size) {
    const head = await readRange(handle, 0, 12);
    if (
      head.length < 12 ||
      head.toString('latin1', 0, 4) !== 'RIFF' ||
      head.toString('latin1', 8, 12) !== 'WAVE'
    ) {
      return { ok: false, reason: 'not a WAV' };
    }
    const declared = head.readUInt32LE(4);
    // Streaming writers leave 0 or 0xFFFFFFFF until they finish; both are treated as unknown.
    if (declared !== 0 && declared !== 0xffffffff && declared + 8 > size) {
      return { ok: false, reason: 'RIFF length exceeds the file size (truncated)' };
    }
    return declared === 0 || declared === 0xffffffff
      ? { ok: true, level: 'header' }
      : { ok: true, level: 'structural' };
  },
  async flac(handle, size) {
    const head = await readRange(handle, 0, 4);
    return size >= 42 && head.toString('latin1') === 'fLaC'
      ? { ok: true, level: 'header' }
      : { ok: false, reason: 'not a FLAC stream' };
  },
  async webm(handle, size) {
    const head = await readRange(handle, 0, 4);
    return size >= 64 && head.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      ? { ok: true, level: 'header' }
      : { ok: false, reason: 'not a WebM/Matroska file' };
  },
  async mp4(handle, size) {
    const head = await readRange(handle, 4, 4);
    return size >= 32 && head.toString('latin1') === 'ftyp'
      ? { ok: true, level: 'header' }
      : { ok: false, reason: 'not an MP4 file' };
  },
  async ply(handle) {
    const head = await readRange(handle, 0, 4);
    return /^ply(\r?\n)/.test(head.toString('latin1'))
      ? { ok: true, level: 'header' }
      : { ok: false, reason: 'not a PLY file' };
  },
  async bvh(handle, size) {
    if (size > 64 * 1024 * 1024) {
      return { ok: true, level: 'header' };
    }
    const text = (await readRange(handle, 0, size)).toString('utf8');
    const frames = /^\s*Frames:\s*(\d+)/m.exec(text);
    const time = /^\s*Frame Time:.*$/m.exec(text);
    if (!text.startsWith('HIERARCHY') || !frames || !time) {
      return { ok: false, reason: 'not a complete BVH file' };
    }
    const rows = text
      .slice(time.index + time[0].length)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '').length;
    return rows >= Number(frames[1])
      ? { ok: true, level: 'structural' }
      : { ok: false, reason: 'fewer motion rows than the declared frame count (truncated)' };
  },
  async json(handle, size) {
    if (size > 64 * 1024 * 1024) {
      return { ok: true, level: 'header' };
    }
    try {
      JSON.parse((await readRange(handle, 0, size)).toString('utf8'));
      return { ok: true, level: 'structural' };
    } catch {
      // The parser message can quote file content, so only the reason code is logged.
      log.debug('file.json.invalid', { reason: 'not_json' });
      return { ok: false, reason: 'not valid JSON (truncated)' };
    }
  },
};

/**
 * Decides whether a finished output file is complete, from its size and signature only.
 * `level: 'structural'` also checked the end of the file; `'header'` could only check the start,
 * so a file of such a type that was cut short could still pass. Unknown extensions only need
 * to be non-empty and report `level: 'size'`.
 * @returns {Promise<{ ok: boolean, level?: string, reason?: string, size: number }>}
 */
export async function verifyOutputFile(file, extension) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) {
      return { ok: false, reason: 'not a regular file', size: 0 };
    }
    if (info.size === 0) {
      return { ok: false, reason: 'empty file', size: 0 };
    }
    const name = String(extension || path.extname(file))
      .replace(/^\./, '')
      .toLowerCase();
    const check = CHECKS[name];
    if (!check) {
      return { ok: true, level: 'size', size: info.size };
    }
    return { ...(await check(handle, info.size)), size: info.size };
  } catch (error) {
    log.debug('file.output.unreadable', { error });
    return {
      ok: false,
      reason: error.code === 'ENOENT' ? 'missing' : `unreadable (${error.code || 'error'})`,
      size: 0,
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}
