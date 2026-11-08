// Append-only journal of recovery events: a database set aside as corrupt, a backup restored,
// a job left interrupted by a crash, an orphaned staging file, an engine re-adopted. Any
// process (queue worker, studio host, supervisor) can append one line synchronously; the
// recovery report (runtime/recovery-report.js) reads the lines written since the previous
// session began. Lines carry codes, ids and counts only: never prompts and never local paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';
import { redactText } from './error-redaction.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS_FILE = 'recovery-events.jsonl';
const ROTATE_BYTES = 1024 * 1024;
const DETAIL_LIMIT = 240;
const SEVERITIES = new Set(['info', 'warn', 'error']);
const log = createLogger('runtime');

export function defaultRuntimeDirectory() {
  if (process.env.FORGE_RUNTIME_DIR) {
    return process.env.FORGE_RUNTIME_DIR;
  }
  // A test that did not name its own runtime folder must not write into the real one.
  if (process.env.NODE_TEST_CONTEXT) {
    return path.join(os.tmpdir(), `forge-test-runtime-${process.pid}`);
  }
  return path.join(repositoryRoot, '.forge-runtime');
}

/**
 * The fields to log for a caught error: its class and code only. Messages and stacks can quote a
 * path or user text, so they are never logged.
 */
export function errorLogFields(error) {
  const code = error?.code;
  return {
    errorClass: typeof error?.name === 'string' ? error.name : undefined,
    errorCode: typeof code === 'string' || Number.isFinite(code) ? code : undefined,
  };
}

function cleanText(value, limit) {
  return redactText(String(value ?? ''))
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, limit);
}

/**
 * Appends one event. Never throws: a recovery record must not make a recovery worse.
 * @param {{ code: string, severity?: 'info'|'warn'|'error', kind?: string, id?: string,
 *   detail?: string, count?: number }} event `code` is `<area>.<what>` such as
 *   `database.quarantined`; `kind`/`id` name the subject (a job, an engine, a database).
 * @param {{ directory?: string, now?: () => Date }} [options]
 */
export function recordRecoveryEvent(event, { directory = defaultRuntimeDirectory(), now } = {}) {
  try {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+){1,3}$/.test(event?.code || '')) {
      return null;
    }
    const entry = {
      at: (now ? now() : new Date()).toISOString(),
      code: event.code,
      severity: SEVERITIES.has(event.severity) ? event.severity : 'info',
      ...(event.kind ? { kind: cleanText(event.kind, 40) } : {}),
      ...(event.id ? { id: cleanText(event.id, 80) } : {}),
      ...(event.detail ? { detail: cleanText(event.detail, DETAIL_LIMIT) } : {}),
      ...(Number.isFinite(event.count) ? { count: Math.trunc(event.count) } : {}),
    };
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, EVENTS_FILE);
    try {
      const { size } = fs.statSync(file);
      if (size > ROTATE_BYTES) {
        fs.renameSync(file, `${file}.1`);
        log.debug('recovery.journal.rotated', { bytes: size });
      }
    } catch (error) {
      // No file yet, or it is being rotated by another process; appending below still works.
      log.debug('recovery.journal.rotate.skipped', errorLogFields(error));
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    const fields = { reason: event.code, ...(entry.kind ? { kind: entry.kind } : {}) };
    if (entry.id && /^[A-Za-z0-9._:+/-]{1,128}$/.test(entry.id)) {
      if (entry.kind === 'job' && /^[a-f0-9-]{36}$/i.test(entry.id)) {
        fields.jobId = entry.id;
      } else {
        fields.targetId = entry.id;
      }
    }
    if (entry.count !== undefined) {
      fields.count = entry.count;
    }
    log[entry.severity](`recovery.${event.code}`, fields);
    return entry;
  } catch (error) {
    // Recording must never make recovery worse, so the failure is logged and swallowed here.
    log.warn('recovery.journal.write.failed', errorLogFields(error));
    return null;
  }
}

/**
 * Reads events, oldest first. `since` (ISO string or Date) drops older entries.
 * Damaged lines (a crash during an append) are skipped.
 */
export function readRecoveryEvents({
  directory = defaultRuntimeDirectory(),
  since,
  limit = 500,
} = {}) {
  const cutoff = since ? new Date(since).getTime() : 0;
  const events = [];
  for (const name of [`${EVENTS_FILE}.1`, EVENTS_FILE]) {
    let text;
    try {
      text = fs.readFileSync(path.join(directory, name), 'utf8');
    } catch (error) {
      // A missing journal is normal before the first event.
      log.debug('recovery.journal.read.skipped', errorLogFields(error));
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.code === 'string' && Date.parse(entry.at) >= cutoff) {
          events.push(entry);
        }
      } catch (error) {
        // A line cut short by a crash is expected after power loss.
        log.debug('recovery.journal.line.skipped', errorLogFields(error));
      }
    }
  }
  return events.slice(-limit);
}
