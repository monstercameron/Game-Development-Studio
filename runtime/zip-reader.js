// A small, strict ZIP reader for archives the user hands to Forge.
//
// It reads the central directory, then streams single entries to disk. It deliberately
// supports only what a downloaded asset bundle needs: stored and deflated members, no
// encryption, no ZIP64, no multi-disk archives. Anything else is refused with a ZipError
// whose message is safe to show in the UI. Callers decide which names are acceptable
// (see megascans-import.js); this module never writes outside the destination it is given.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fsyncFile } from './durable-file.js';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const MAX_COMMENT_BYTES = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const UNIX_HOST = 3;
const UNIX_SYMLINK = 0xa000;
const UNIX_TYPE_MASK = 0xf000;

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new ZipError('The ZIP archive is truncated or damaged.');
  }
  return buffer;
}

function decodeName(raw, flags) {
  // Bit 11 marks UTF-8. Older tools write the system code page, which latin1 preserves.
  return raw.toString(flags & 0x800 ? 'utf8' : 'latin1');
}

/**
 * Reads the member list of a ZIP file.
 * @param {string} file Path of the archive on disk.
 * @param {{ maxEntries?: number }} [options]
 * @returns {Promise<{ size: number, entries: object[] }>} Entries carry the raw name, sizes,
 * CRC-32, offsets and flags; `isDirectory`, `isSymlink` and `isEncrypted` are derived.
 */
export async function readZipDirectory(file, { maxEntries = 20000 } = {}) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) {
      throw new ZipError('The file is too small to be a ZIP archive.');
    }
    const tailLength = Math.min(size, 22 + MAX_COMMENT_BYTES);
    const tail = await readExactly(handle, tailLength, size - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
        eocd = index;
        break;
      }
    }
    if (eocd < 0) {
      throw new ZipError('This is not a readable ZIP archive.');
    }
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
      throw new ZipError('ZIP64 archives are not supported. Use a smaller or standard ZIP.');
    }
    const diskNumber = tail.readUInt16LE(eocd + 4);
    const directoryDisk = tail.readUInt16LE(eocd + 6);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (diskNumber !== 0 || directoryDisk !== 0) {
      throw new ZipError('Multi-part ZIP archives are not supported.');
    }
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported. Use a smaller or standard ZIP.');
    }
    if (entryCount > maxEntries) {
      throw new ZipError(`The archive has more than ${maxEntries} files.`);
    }
    if (
      directorySize > MAX_CENTRAL_DIRECTORY_BYTES ||
      directoryOffset + directorySize > size - 22 + MAX_COMMENT_BYTES
    ) {
      throw new ZipError('The ZIP directory is invalid.');
    }
    const directory = await readExactly(handle, directorySize, directoryOffset);
    const entries = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_ENTRY) {
        throw new ZipError('The ZIP directory is invalid.');
      }
      const versionMadeBy = directory.readUInt16LE(cursor + 4);
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const crc32 = directory.readUInt32LE(cursor + 16);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const externalAttributes = directory.readUInt32LE(cursor + 38);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length) {
        throw new ZipError('The ZIP directory is invalid.');
      }
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new ZipError('ZIP64 archives are not supported. Use a smaller or standard ZIP.');
      }
      const name = decodeName(directory.subarray(cursor + 46, cursor + 46 + nameLength), flags);
      const unixMode = externalAttributes >>> 16;
      entries.push({
        name,
        flags,
        method,
        crc32,
        compressedSize,
        size: uncompressedSize,
        localOffset,
        isDirectory: name.endsWith('/') || name.endsWith('\\'),
        isEncrypted: Boolean(flags & 0x1) || Boolean(flags & 0x40),
        isSymlink: versionMadeBy >> 8 === UNIX_HOST && (unixMode & UNIX_TYPE_MASK) === UNIX_SYMLINK,
      });
      cursor = next;
    }
    return { size, entries };
  } finally {
    await handle.close();
  }
}

function countingStream({ expectedSize, onBytes }) {
  let total = 0;
  let crc = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > expectedSize) {
        // The directory understated the real size: a decompression bomb or a damaged file.
        callback(new ZipError('A file in the archive is larger than the archive says.'));
        return;
      }
      crc = zlib.crc32(chunk, crc);
      onBytes?.(chunk.length);
      callback(null, chunk);
    },
  });
  stream.result = () => ({ total, crc });
  return stream;
}

/**
 * Streams one archive member to a new file. The destination must not exist (flag `wx`).
 * The member is checked against its declared size and CRC-32.
 * @param {string} file Path of the archive.
 * @param {object} entry An entry returned by readZipDirectory.
 * @param {string} destination Absolute path of the file to create.
 * @param {{ signal?: AbortSignal, onBytes?: (count: number) => void, archiveSize: number }} options
 */
export async function extractZipEntry(file, entry, destination, options) {
  const { signal, onBytes, archiveSize } = options;
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError('The archive uses an unsupported compression method.');
  }
  if (entry.method === 0 && entry.compressedSize !== entry.size) {
    throw new ZipError('The ZIP directory is invalid.');
  }
  const handle = await fs.open(file, 'r');
  let dataStart;
  try {
    const header = await readExactly(handle, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOCAL_HEADER) {
      throw new ZipError('The ZIP archive is truncated or damaged.');
    }
    dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (dataStart + entry.compressedSize > archiveSize) {
    throw new ZipError('The ZIP archive is truncated or damaged.');
  }
  const counter = countingStream({ expectedSize: entry.size, onBytes });
  const output = createWriteStream(destination, { flags: 'wx' });
  if (entry.compressedSize === 0) {
    output.end();
    await new Promise((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
  } else {
    const input = createReadStream(file, {
      start: dataStart,
      end: dataStart + entry.compressedSize - 1,
    });
    const stages =
      entry.method === 8
        ? [input, zlib.createInflateRaw(), counter, output]
        : [input, counter, output];
    await pipeline(stages, { signal });
  }
  const { total, crc } = counter.result();
  if (total !== entry.size || crc >>> 0 !== entry.crc32) {
    throw new ZipError('A file in the archive failed its integrity check.');
  }
  // Extracted files are renamed into the project as a folder; flush them first so a power loss
  // cannot leave zero-filled files inside a finished-looking import.
  await fsyncFile(destination);
}
