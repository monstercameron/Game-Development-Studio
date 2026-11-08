// Moves spool files written by every Forge process (runtime/app-log.js, runtime/app_log.py) into
// .forge-runtime/logs.sqlite. Runs in the studio host only. See docs/LOGGING.md.
//
// Spool file names: <process>-<pid>-<thread>-<startMs>-<n>.jsonl. A writer only ever appends to
// its newest file. A file is deleted once it is fully ingested and can no longer grow: a newer file
// of the same writer exists, or the writing process has exited. Offsets are committed in the same
// transaction as the rows, so a second ingester or a crash never duplicates or loses lines.
import fs from 'node:fs';
import path from 'node:path';

const SPOOL_NAME = /^(.+)-(\d+)-(\d+)-(\d+)-(\d+)\.jsonl$/;
export const INGEST_INTERVAL_MS = 1000;
// Bounds the synchronous SQLite work done per pass so the host's event loop stays responsive.
export const INGEST_MAX_LINES_PER_PASS = 4000;
const READ_CHUNK_BYTES = 2 * 1024 * 1024;

export function parseSpoolName(name) {
  const match = SPOOL_NAME.exec(name);
  if (!match) {
    return null;
  }
  return {
    writer: `${match[1]}-${match[2]}-${match[3]}-${match[4]}`,
    pid: Number(match[2]),
    index: Number(match[5]),
  };
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

function readRange(file, start, length) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(handle, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import('./log-store.js').createLogStore>} options.store
 * @param {string} options.spoolDirectory
 * @param {(pid: number) => boolean} [options.isAlive] for tests
 */
export function createLogIngester({ store, spoolDirectory, isAlive = isProcessAlive }) {
  const stats = {
    passes: 0,
    lines: 0,
    rejected: 0,
    deletedFiles: 0,
    backlogBytes: 0,
    lastError: null,
  };

  function ingestFile(name, budget) {
    const file = path.join(spoolDirectory, name);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return { lines: 0, done: false, size: 0, offset: 0 };
    }
    const offset = store.spoolOffset(name);
    if (size <= offset) {
      return { lines: 0, done: true, size, offset };
    }
    const bytes = readRange(file, offset, Math.min(size - offset, READ_CHUNK_BYTES));
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      // A partial line: the writer is in the middle of an append.
      return { lines: 0, done: false, size, offset };
    }
    const lines = bytes.subarray(0, lastNewline).toString('utf8').split('\n');
    const take = lines.slice(0, Math.max(1, budget));
    const consumedBytes =
      take.length === lines.length ? lastNewline + 1 : Buffer.byteLength(`${take.join('\n')}\n`);
    const records = [];
    let rejectedLines = 0;
    for (const line of take) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        rejectedLines += 1;
      }
    }
    const inserted = store.ingestSpoolChunk({
      spoolFile: name,
      expectedOffset: offset,
      nextOffset: offset + consumedBytes,
      records,
      rejectedLines,
    });
    stats.rejected += rejectedLines;
    return {
      lines: inserted ?? 0,
      done: offset + consumedBytes >= size,
      size,
      offset: offset + consumedBytes,
    };
  }

  /** One ingest pass. Never throws; failures are kept in stats.lastError. */
  function ingestOnce() {
    stats.passes += 1;
    let budget = INGEST_MAX_LINES_PER_PASS;
    let backlog = 0;
    try {
      let names;
      try {
        names = fs.readdirSync(spoolDirectory);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return { lines: 0 };
        }
        throw error;
      }
      const spool = names
        .map((name) => ({ name, parsed: parseSpoolName(name) }))
        .filter((item) => item.parsed)
        .sort(
          (a, b) =>
            a.parsed.writer.localeCompare(b.parsed.writer) || a.parsed.index - b.parsed.index,
        );
      const newestIndex = new Map();
      for (const { parsed } of spool) {
        newestIndex.set(parsed.writer, Math.max(newestIndex.get(parsed.writer) ?? 0, parsed.index));
      }
      let total = 0;
      for (const { name, parsed } of spool) {
        const result =
          budget > 0 ? ingestFile(name, budget) : { lines: 0, done: false, size: 0, offset: 0 };
        total += result.lines;
        budget -= result.lines;
        backlog += Math.max(0, result.size - result.offset);
        const isRolled = parsed.index < newestIndex.get(parsed.writer);
        if (result.done && (isRolled || !isAlive(parsed.pid))) {
          try {
            fs.unlinkSync(path.join(spoolDirectory, name));
            store.forgetSpoolFile(name);
            stats.deletedFiles += 1;
          } catch (error) {
            // EBUSY/EPERM on Windows while another process still has it open: retry next pass.
            if (error.code === 'ENOENT') {
              store.forgetSpoolFile(name);
            }
          }
        }
      }
      const present = new Set(names);
      for (const { file } of store.spoolFiles()) {
        if (!present.has(file)) {
          store.forgetSpoolFile(file);
        }
      }
      stats.lines += total;
      stats.backlogBytes = backlog;
      stats.lastError = null;
      return { lines: total };
    } catch (error) {
      stats.lastError = typeof error?.code === 'string' ? error.code : 'ingest_failed';
      return { lines: 0, error: stats.lastError };
    }
  }

  /** Ingests until the spool is empty or `maxPasses` is reached. */
  function drain(maxPasses = 50) {
    let total = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const { lines } = ingestOnce();
      total += lines;
      if (!lines) {
        break;
      }
    }
    return total;
  }

  return { ingestOnce, drain, stats };
}
