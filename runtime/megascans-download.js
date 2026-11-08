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

export const STALL_TIMEOUT_MS = 60_000;

async function sizeOf(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
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
export async function downloadFabFile({
  client,
  listingId,
  file,
  partPath,
  finalPath,
  signal,
  onProgress,
  stallMs = STALL_TIMEOUT_MS,
}) {
  const expected = file.size;
  let offset = await sizeOf(partPath);
  if (expected !== null && offset > expected) {
    await fs.rm(partPath, { force: true });
    offset = 0;
  }
  if (expected !== null && offset === expected) {
    await fs.rename(partPath, finalPath);
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
      await response.body?.cancel().catch(() => {});
      await fs.rm(partPath, { force: true });
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
  await fs.rename(partPath, finalPath);
  return { bytes: written, resumed };
}
