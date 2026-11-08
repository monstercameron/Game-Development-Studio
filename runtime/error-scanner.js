// Feeds the error store from Forge's own runtime logs and failed render-queue jobs.
// Logs are read incrementally from a saved byte offset; the job database is opened read-only
// and job prompts (the request column) are never read.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractLogErrors } from './error-log-parser.js';

const FIRST_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const STALE_LOG_MS = 60000;
const QUEUE_ERROR_STATES = ['failed', 'interrupted', 'needs_attention'];

/** Lists the Forge runtime log files and the error source each one reports as. */
export async function runtimeLogFiles(runtimeDir) {
  let names;
  try {
    names = await fs.readdir(runtimeDir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const engine = /^engine-([a-z0-9][a-z0-9-]{0,40})\.log$/.exec(name);
    if (engine) {
      files.push({ name, source: `engine:${engine[1]}` });
    } else if (name === 'service-supervisor.log' || name === 'runtime-worker.log') {
      files.push({ name, source: 'server' });
    }
  }
  // Each studio start writes its own server-<port>-<time>-error.log; read only the newest few.
  const serverLogs = names.filter((name) => /^server-\d+-[\d-]+-error\.log$/.test(name)).sort();
  for (const name of serverLogs.slice(-3)) {
    files.push({ name, source: 'server' });
  }
  return files;
}

async function readRange(file, start, length) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Reads new log bytes since the saved cursor and records each error found. */
export async function scanLogs(store, { runtimeDir, now = () => Date.now() } = {}) {
  let recorded = 0;
  const problems = [];
  for (const { name, source } of await runtimeLogFiles(runtimeDir)) {
    const file = path.join(runtimeDir, name);
    try {
      const info = await fs.stat(file);
      const key = `log:${name}`;
      const savedText = store.getCursor(key);
      const saved = savedText === null ? null : Number(savedText);
      let start = Number.isSafeInteger(saved) && saved >= 0 ? saved : null;
      if (start === null) {
        start = Math.max(0, info.size - FIRST_READ_BYTES);
      } else if (start > info.size) {
        // The log was truncated or replaced.
        start = 0;
      }
      if (start === info.size) {
        continue;
      }
      const length = Math.min(MAX_READ_BYTES, info.size - start);
      let buffer = await readRange(file, start, length);
      let skipped = 0;
      const isFirstRead = saved === null || !Number.isSafeInteger(saved);
      if (start > 0 && isFirstRead) {
        // A first read that starts mid-file begins at the next full line.
        const newline = buffer.indexOf(10);
        skipped = newline + 1;
        buffer = buffer.subarray(skipped);
      }
      const lastNewline = buffer.lastIndexOf(10);
      const reachedEnd = start + length >= info.size;
      if (lastNewline < 0 && reachedEnd) {
        continue;
      }
      const complete = lastNewline < 0 ? buffer : buffer.subarray(0, lastNewline + 1);
      const text = complete.toString('utf8');
      const isStale = now() - info.mtimeMs > STALE_LOG_MS;
      let { entries, safeLength } = extractLogErrors(text, { final: reachedEnd && isStale });
      if (safeLength === 0 && text.length && !reachedEnd) {
        // One traceback is larger than a read; keep what fits rather than stalling the cursor.
        ({ entries, safeLength } = extractLogErrors(text, { final: true }));
      }
      for (const entry of entries) {
        store.record({
          source,
          message: entry.message,
          stack: entry.stack,
          at: entry.timestamp || new Date(info.mtimeMs).toISOString(),
          context: { log: name, ...(entry.context || {}) },
        });
        recorded++;
      }
      const consumed = Buffer.byteLength(text.slice(0, safeLength), 'utf8');
      store.setCursor(key, start + skipped + consumed);
    } catch (error) {
      problems.push(`${name}: ${error.code || 'read failed'}`);
    }
  }
  return { recorded, problems };
}

function safeDetails(details) {
  try {
    const parsed = details ? JSON.parse(details) : null;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    // Only short machine codes; preparation details can carry request-derived values.
    const picked = {};
    for (const key of ['code', 'outcome']) {
      if (typeof parsed[key] === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(parsed[key])) {
        picked[key] = parsed[key];
      }
    }
    return picked;
  } catch {
    return {};
  }
}

/** Records failed, interrupted and needs-attention jobs that have an error message. */
export function scanJobs(store, { jobsFile, retentionDays = 30, now = () => Date.now() } = {}) {
  let db;
  try {
    db = new DatabaseSync(jobsFile, { readOnly: true, timeout: 2000 });
  } catch (error) {
    return { recorded: 0, problems: [`jobs: ${error.code || 'unavailable'}`] };
  }
  let recorded = 0;
  try {
    const since =
      store.getCursor('jobs') || new Date(now() - retentionDays * 86400000).toISOString();
    const rows = db
      .prepare(
        `SELECT id,type,project_id,status,stage,error,details,updated_at FROM jobs
         WHERE status IN (${QUEUE_ERROR_STATES.map(() => '?').join(',')})
         AND error IS NOT NULL AND error<>'' AND updated_at >= ?
         ORDER BY updated_at LIMIT 500`,
      )
      .all(...QUEUE_ERROR_STATES, since);
    let latest = since;
    for (const row of rows) {
      latest = row.updated_at > latest ? row.updated_at : latest;
      if (!store.markJobErrorSeen(row.id, `${row.status}\n${row.error}`)) {
        continue;
      }
      store.record({
        source: 'queue',
        kind: row.type,
        message: row.error,
        jobId: row.id,
        projectId: row.project_id,
        at: row.updated_at,
        context: {
          jobType: row.type,
          jobStatus: row.status,
          stage: typeof row.stage === 'string' ? row.stage.slice(0, 200) : undefined,
          ...safeDetails(row.details),
        },
      });
      recorded++;
    }
    store.setCursor('jobs', latest);
    return { recorded, problems: [] };
  } catch (error) {
    return { recorded, problems: [`jobs: ${error.code || 'query failed'}`] };
  } finally {
    db.close();
  }
}
