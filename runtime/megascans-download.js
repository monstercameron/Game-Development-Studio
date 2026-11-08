// Downloads one Fab file into a project's staging folder.
//
// The signed address Fab hands out expires after about five minutes, so it is requested right
// before the transfer and used once; it is never stored or logged. The file is written to
// `upload.<ext>.part`. When a `.part` exists, a new signed address is requested and the transfer
// continues with a Range request if the server honors it; otherwise it starts over. The finished
// file must match the size Fab listed before it is renamed to `upload.<ext>`.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FabError } from './megascans-fab.js';
import { fsyncFile } from './durable-file.js';
import { createLogger } from './app-log.js';

const log = createLogger('megascans');

// After a crash, the end of a partial file can hold zeros that the file size already counts
// (the size is journaled before the data). The studio sets this when the previous session ended
// uncleanly, and a resumed download then repeats the last few megabytes.
const UNCLEAN_RESUME_OVERLAP_BYTES = 8 * 1024 * 1024;

export const STALL_TIMEOUT_MS = 60_000;

async function sizeOf(file) {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    // A missing partial file is the normal first attempt, so this stays at debug.
    log.debug('megascans.download.part.stat.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
    });
    return 0;
  }
}

/**
 * @param {object} options
 * @param {import('./megascans-fab.js').FabClient} options.client
 * @param {string} options.listingId
 * @param {{ uid: string, formatCode: string, size: number | null }} options.file
 * @param {string} options.partPath Where the partial file lives (`upload.<ext>.part`).
 * @param {string} options.finalPath Where the finished file goes (`upload.<ext>`).
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { bytesDone: number, bytesTotal: number, stage: string }) => void} [options.onProgress]
 * @returns {Promise<{ bytes: number, resumed: boolean }>}
 */
async function transferFabFile({
  client,
  listingId,
  file,
  partPath,
  finalPath,
  signal,
  onProgress,
  stallMs = STALL_TIMEOUT_MS,
  resumeOverlapBytes = process.env.FORGE_PREVIOUS_UNCLEAN === '1'
    ? UNCLEAN_RESUME_OVERLAP_BYTES
    : 0,
}) {
  const expected = file.size;
  let offset = await sizeOf(partPath);
  if (offset > 0 && resumeOverlapBytes > 0) {
    offset = Math.max(0, offset - resumeOverlapBytes);
    await fs.truncate(partPath, offset);
    log.debug('megascans.download.part.truncated', { resumeOffsetBytes: offset });
  }
  if (expected !== null && offset > expected) {
    await fs.rm(partPath, { force: true });
    log.debug('megascans.download.part.removed', { reason: 'oversized' });
    offset = 0;
  }
  if (expected !== null && offset === expected) {
    await fsyncFile(partPath);
    await fs.rename(partPath, finalPath);
    log.debug('megascans.download.part.renamed', { bytes: expected });
    return { bytes: expected, resumed: true };
  }
  const info = await client.getDownloadInfo(listingId, file.formatCode, file.uid, { signal });
  let response = await client.openDownload(info.url, { start: offset, signal });
  let resumed = false;
  if (offset > 0) {
    if (response.status === 206 && response.rangeStart === offset) {
      resumed = true;
    } else {
      // The server ignored the range (or answered another one): start over from the beginning.
      log.warn('megascans.download.range.ignored', { listingId, httpStatus: response.status });
      await response.body?.cancel().catch(() => {});
      await fs.rm(partPath, { force: true });
      log.debug('megascans.download.part.removed', { reason: 'range_ignored' });
      offset = 0;
      response = await client.openDownload(info.url, { start: 0, signal });
    }
  }
  if (offset === 0 && response.status === 206) {
    await response.body?.cancel().catch(() => {});
    throw new FabError('The download server answered with part of the file only.');
  }
  const declared = response.contentLength === null ? null : response.contentLength + offset;
  if (expected !== null && declared !== null && declared !== expected) {
    await response.body?.cancel().catch(() => {});
    throw new FabError('The download is not the size Fab listed, so Forge stopped.');
  }
  const total = expected ?? declared ?? 0;
  let done = offset;
  let stall;
  const controller = new AbortController();
  const link = () => controller.abort();
  signal?.addEventListener('abort', link, { once: true });
  const arm = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(new FabError('The download stalled.')), stallMs);
  };
  arm();
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length;
      if (expected !== null && done > expected) {
        callback(new FabError('The download is larger than Fab listed, so Forge stopped.'));
        return;
      }
      arm();
      onProgress?.({ bytesDone: done, bytesTotal: total, stage: 'Downloading' });
      callback(null, chunk);
    },
  });
  try {
    onProgress?.({ bytesDone: done, bytesTotal: total, stage: 'Downloading' });
    await pipeline(
      Readable.fromWeb(response.body),
      counter,
      createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' }),
      { signal: controller.signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (error?.name === 'AbortError') {
      throw controller.signal.reason instanceof FabError
        ? controller.signal.reason
        : new FabError('The download was interrupted.');
    }
    throw error instanceof FabError ? error : new FabError('The download was interrupted.');
  } finally {
    clearTimeout(stall);
    signal?.removeEventListener('abort', link);
  }
  const written = await sizeOf(partPath);
  if (expected !== null && written !== expected) {
    throw new FabError('The download ended early. Retry to continue where it stopped.');
  }
  // The bytes are flushed before the finished name exists (see docs/RESILIENCE.md).
  await fsyncFile(partPath);
  await fs.rename(partPath, finalPath);
  log.debug('megascans.download.part.renamed', { bytes: written });
  return { bytes: written, resumed };
}

/**
 * Downloads one Fab file (contract in transferFabFile) and logs only its outcome. The listing id
 * and byte counts are logged; the signed address and file paths never are.
 */
export async function downloadFabFile(options) {
  const { listingId, file, signal } = options;
  const startedAt = Date.now();
  log.info('megascans.download.started', { listingId, expectedBytes: file.size ?? undefined });
  try {
    const result = await transferFabFile(options);
    log.info('megascans.download.completed', {
      listingId,
      bytes: result.bytes,
      isResumed: result.resumed,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (signal?.aborted || error?.name === 'AbortError') {
      log.info('megascans.download.cancelled', { listingId, durationMs });
    } else {
      log.error('megascans.download.failed', {
        listingId,
        errorClass: error?.name,
        errorCode: error?.code,
        httpStatus: error?.status,
        durationMs,
      });
    }
    throw error;
  }
}
