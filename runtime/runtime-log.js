import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.forge-runtime',
);

function reportUnavailable(error) {
  const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
  console.error(`Runtime log unavailable${code}.`);
}

/**
 * Creates the runtime worker log writer. It never throws: when the file cannot be opened,
 * lines fall back to stderr. Callers must call close() to flush the stream on shutdown.
 *
 * @param {{ directory?: string }} [options] Log directory; defaults to FORGE_RUNTIME_DIR
 *   or the repository's .forge-runtime folder.
 * @returns {{ write: (level: string, message: string, raw?: boolean) => void, close: () => void }}
 */
// A slow or failed disk must not stall inference or grow an unbounded queue.
// Lost output is counted, so diagnostics never silently implies a complete log.
export function createRuntimeLog({
  directory = process.env.FORGE_RUNTIME_DIR || defaultDirectory,
} = {}) {
  // stream is null after an open or write error; writes then go to stderr.
  let stream = null;
  // blocked is true while the stream buffer is full and waiting for 'drain'.
  let blocked = false;
  // dropped counts bytes discarded while blocked, reported on the next drain.
  let dropped = 0;
  let closed = false;
  try {
    fs.mkdirSync(directory, { recursive: true });
    stream = fs.createWriteStream(path.join(directory, 'runtime-worker.log'), {
      flags: 'a',
      highWaterMark: 256 * 1024,
    });
    stream.on('error', (error) => {
      stream = null;
      reportUnavailable(error);
    });
    stream.on('drain', () => {
      blocked = false;
      if (dropped && stream && !closed) {
        const lost = dropped;
        dropped = 0;
        blocked = !stream.write(
          `\n${new Date().toISOString()} WARN Runtime log dropped ${lost} bytes while storage was slow.\n`,
        );
      }
    });
  } catch (error) {
    // log-coverage: ignore -- this is the runtime log file writer itself; it reports through reportUnavailable
    reportUnavailable(error);
  }
  return {
    write(level, message, raw = false) {
      if (closed) {
        return;
      }
      const data = raw ? message : `${new Date().toISOString()} ${level} ${message}\n`;
      if (!stream) {
        process.stderr.write(data);
        return;
      }
      if (blocked) {
        dropped += Buffer.byteLength(data);
        return;
      }
      blocked = !stream.write(data);
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      stream?.end();
    },
  };
}
