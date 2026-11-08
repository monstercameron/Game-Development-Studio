// Global error review store: .forge-runtime/errors.sqlite. Rows are redacted before they are
// written, repeats with the same fingerprint increase a count, and retention bounds the file.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './app-log.js';
import { openDatabase } from './durable-db.js';
import {
  ERROR_FIELD_LIMITS,
  fingerprintSource,
  redactText,
  truncateMiddle,
} from './error-redaction.js';

export const ERROR_STATUSES = ['new', 'reviewed', 'resolved', 'verified', 'ignored'];
export const FIX_SOURCES = ['self', 'ai', 'both'];
export const ERROR_RETENTION = Object.freeze({ maxRows: 2000, maxAgeDays: 30 });
const SOURCE_PATTERN = /^(?:browser|queue|server|engine:[a-z0-9][a-z0-9-]{0,40})$/;
const log = createLogger('errors');

// Log fields carry only the class and code of a failure. Messages and stacks can hold paths,
// stored text or prompts, so they never reach the studio log.
function failureFields(error) {
  return { errorClass: error?.name, errorCode: error?.code };
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function isoOrNow(value) {
  const parsed = typeof value === 'string' ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function publicRow(row, { full = false } = {}) {
  if (!row) {
    return null;
  }
  let context;
  try {
    context = row.context_json ? JSON.parse(row.context_json) : {};
  } catch (error) {
    // A row written by an older build with invalid JSON still displays.
    log.debug('errors.context.parse.failed', { errorId: row.id, ...failureFields(error) });
    context = {};
  }
  const summary = {
    id: row.id,
    fingerprint: row.fingerprint,
    source: row.source,
    message: full ? row.message : truncateMiddle(row.message, 300),
    count: row.count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    status: row.status,
    page: row.page || null,
    jobId: row.job_id || null,
    projectId: row.project_id || null,
    hasSuggestion: !!row.suggestion,
    issueUrl: row.issue_url || null,
    issueNumber: row.issue_number ?? null,
  };
  if (!full) {
    return summary;
  }
  return {
    ...summary,
    stack: row.stack || '',
    context,
    note: row.note || '',
    fixNote: row.fix_note || '',
    fixSource: row.fix_source || null,
    verifiedAt: row.verified_at || null,
    suggestion: row.suggestion || '',
    suggestionModel: row.suggestion_model || null,
    suggestionAt: row.suggestion_at || null,
    updatedAt: row.updated_at,
  };
}

/**
 * Opens (creating on first write) the errors database.
 *
 * @param {{directory: string, roots?: object, retention?: {maxRows: number, maxAgeDays: number},
 *   now?: () => Date}} options roots are the local paths replaced by placeholders.
 */
export function createErrorStore({
  directory,
  roots = {},
  retention = ERROR_RETENTION,
  now = () => new Date(),
} = {}) {
  if (!directory) {
    throw Error('An errors directory is required.');
  }
  fs.mkdirSync(directory, { recursive: true });
  // NORMAL is enough here: in WAL mode a power loss can lose the last few commits but never
  // corrupts the file, and every row is re-collected from the logs and the job table.
  let db;
  let phase = 'open';
  try {
    db = openDatabase(path.join(directory, 'errors.sqlite'), {
      name: 'errors',
      journal: 'WAL',
      synchronous: 'NORMAL',
      directory,
    });
    phase = 'migrate';
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL UNIQUE,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      page TEXT,
      job_id TEXT,
      project_id TEXT,
      message TEXT NOT NULL,
      stack TEXT,
      context_json TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      note TEXT,
      fix_note TEXT,
      fix_source TEXT,
      verified_at TEXT,
      suggestion TEXT,
      suggestion_model TEXT,
      suggestion_at TEXT,
      issue_url TEXT,
      issue_number INTEGER,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS errors_last_seen ON errors(last_seen);
    CREATE INDEX IF NOT EXISTS errors_status ON errors(status);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_seen (
      job_id TEXT NOT NULL,
      error_hash TEXT NOT NULL,
      seen_at TEXT NOT NULL,
      PRIMARY KEY(job_id, error_hash)
    );`);
  } catch (error) {
    // The error is rethrown unchanged; the log only says whether opening or the schema failed.
    log.error('errors.store.open.failed', { phase, ...failureFields(error) });
    throw error;
  }
  let writesSincePrune = 0;
  const redact = (text) => redactText(text, roots);
  // Trim before redacting so oversized input cannot make redaction slow, then trim again
  // because placeholders can change the length.
  const clip = (text, limit) => truncateMiddle(redact(truncateMiddle(text, limit * 2)), limit);

  function prune() {
    const cutoff = new Date(now().getTime() - retention.maxAgeDays * 86400000).toISOString();
    const expiredCount = db.prepare('DELETE FROM errors WHERE last_seen < ?').run(cutoff).changes;
    const overflowCount = db
      .prepare(
        'DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY last_seen DESC, id DESC LIMIT ?)',
      )
      .run(retention.maxRows).changes;
    db.prepare('DELETE FROM job_seen WHERE seen_at < ?').run(cutoff);
    writesSincePrune = 0;
    if (expiredCount + overflowCount > 0) {
      log.info('errors.retention.completed', { deletedCount: expiredCount + overflowCount });
    }
  }

  function cleanContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      return '{}';
    }
    const entries = Object.entries(context)
      .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key) && value !== undefined)
      .slice(0, 20)
      .map(([key, value]) => [
        key,
        typeof value === 'string' ? clip(value, 500) : typeof value === 'number' ? value : null,
      ]);
    const text = JSON.stringify(Object.fromEntries(entries));
    return text.length <= ERROR_FIELD_LIMITS.context ? text : '{}';
  }

  return {
    roots,
    /** Records one occurrence. Returns the row id and whether it was a new fingerprint. */
    record(entry) {
      const source = String(entry?.source || '');
      if (!SOURCE_PATTERN.test(source)) {
        throw Error('Unknown error source.');
      }
      const message = clip(String(entry.message || '').trim() || 'Unknown error', 2000);
      const stack = clip(String(entry.stack || ''), ERROR_FIELD_LIMITS.stack);
      const fingerprint = hash(fingerprintSource({ source, kind: entry.kind, message, stack }));
      const at = isoOrNow(entry.at);
      const updatedAt = now().toISOString();
      const page = entry.page ? clip(String(entry.page), ERROR_FIELD_LIMITS.page) : null;
      const jobId = typeof entry.jobId === 'string' ? entry.jobId.slice(0, 64) : null;
      const projectId = typeof entry.projectId === 'string' ? entry.projectId.slice(0, 64) : null;
      const context = cleanContext(entry.context);
      const existing = db
        .prepare('SELECT id,status FROM errors WHERE fingerprint=?')
        .get(fingerprint);
      if (existing) {
        // A resolved or verified error that happens again is a regression and needs review.
        db.prepare(
          `UPDATE errors SET count=count+1,
            last_seen=CASE WHEN last_seen > ? THEN last_seen ELSE ? END,
            first_seen=CASE WHEN first_seen < ? THEN first_seen ELSE ? END,
            stack=?, page=COALESCE(?,page), job_id=COALESCE(?,job_id),
            project_id=COALESCE(?,project_id), context_json=?,
            status=CASE WHEN status IN ('resolved','verified') THEN 'new' ELSE status END,
            updated_at=? WHERE id=?`,
        ).run(at, at, at, at, stack, page, jobId, projectId, context, updatedAt, existing.id);
        if (existing.status === 'resolved' || existing.status === 'verified') {
          log.info('errors.status.changed', {
            errorId: existing.id,
            from: existing.status,
            to: 'new',
            reason: 'recurred',
          });
        }
      } else {
        db.prepare(
          `INSERT INTO errors(fingerprint,first_seen,last_seen,count,source,page,job_id,project_id,
            message,stack,context_json,status,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,'new',?)`,
        ).run(
          fingerprint,
          at,
          at,
          source,
          page,
          jobId,
          projectId,
          message,
          stack,
          context,
          updatedAt,
        );
      }
      if (++writesSincePrune >= 25) {
        prune();
      }
      const id =
        existing?.id ?? db.prepare('SELECT id FROM errors WHERE fingerprint=?').get(fingerprint).id;
      const recordFields = { errorId: id, source, kind: entry.kind, isNew: !existing };
      if (existing) {
        log.debug('errors.error.repeated', recordFields);
      } else {
        log.info('errors.error.recorded', recordFields);
      }
      return { id, created: !existing, fingerprint };
    },
    prune,
    list({ status = '', source = '', query = '', limit = 100, offset = 0 } = {}) {
      const where = [],
        params = [];
      if (status) {
        where.push('status=?');
        params.push(status);
      }
      if (source === 'engine') {
        where.push("source LIKE 'engine:%'");
      } else if (source) {
        where.push('source=?');
        params.push(source);
      }
      const text = String(query || '')
        .trim()
        .slice(0, 200);
      if (text) {
        const like = `%${escapeLike(text)}%`;
        where.push(
          "(message LIKE ? ESCAPE '\\' OR stack LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR job_id LIKE ? ESCAPE '\\')",
        );
        params.push(like, like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM errors ${clause} ORDER BY last_seen DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
      const total = db.prepare(`SELECT COUNT(*) AS n FROM errors ${clause}`).get(...params).n;
      return { errors: rows.map((row) => publicRow(row)), total };
    },
    get(id) {
      return publicRow(db.prepare('SELECT * FROM errors WHERE id=?').get(id), { full: true });
    },
    /** New errors since the review dialog was last opened, plus status totals. */
    summary() {
      const lastOpened = this.getSetting('lastOpenedAt', '');
      const counts = Object.fromEntries(ERROR_STATUSES.map((status) => [status, 0]));
      for (const row of db
        .prepare('SELECT status, COUNT(*) AS n FROM errors GROUP BY status')
        .all()) {
        counts[row.status] = row.n;
      }
      const unread = db
        .prepare("SELECT COUNT(*) AS n FROM errors WHERE status='new' AND last_seen > ?")
        .get(lastOpened).n;
      return { unread, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
    },
    markOpened() {
      this.setSetting('lastOpenedAt', now().toISOString());
    },
    setStatus(id, status, { fixNote, fixSource } = {}) {
      if (!ERROR_STATUSES.includes(status)) {
        throw Error('Choose a valid status.');
      }
      if (status === 'verified') {
        if (fixSource !== undefined && fixSource !== null && !FIX_SOURCES.includes(fixSource)) {
          throw Error('Choose who fixed the error.');
        }
      }
      const previousStatus = db.prepare('SELECT status FROM errors WHERE id=?').get(id)?.status;
      const changes =
        status === 'verified'
          ? db
              .prepare(
                'UPDATE errors SET status=?,fix_note=?,fix_source=?,verified_at=?,updated_at=? WHERE id=?',
              )
              .run(
                status,
                clip(String(fixNote || ''), ERROR_FIELD_LIMITS.note),
                fixSource || null,
                now().toISOString(),
                now().toISOString(),
                id,
              ).changes
          : db
              .prepare('UPDATE errors SET status=?,updated_at=? WHERE id=?')
              .run(status, now().toISOString(), id).changes;
      if (changes > 0) {
        log.info('errors.status.changed', { errorId: id, from: previousStatus, to: status });
      }
      return changes > 0;
    },
    markReviewed(id) {
      const result = db
        .prepare("UPDATE errors SET status='reviewed',updated_at=? WHERE id=? AND status='new'")
        .run(now().toISOString(), id);
      if (result.changes > 0) {
        log.info('errors.status.changed', { errorId: id, from: 'new', to: 'reviewed' });
      }
    },
    setNote(id, note) {
      return (
        db
          .prepare('UPDATE errors SET note=?,updated_at=? WHERE id=?')
          .run(clip(String(note || ''), ERROR_FIELD_LIMITS.note), now().toISOString(), id).changes >
        0
      );
    },
    saveSuggestion(id, { suggestion, model }) {
      const at = now().toISOString();
      db.prepare(
        'UPDATE errors SET suggestion=?,suggestion_model=?,suggestion_at=?,updated_at=? WHERE id=?',
      ).run(
        clip(suggestion, ERROR_FIELD_LIMITS.suggestion),
        String(model).slice(0, 100),
        at,
        at,
        id,
      );
      return at;
    },
    saveIssue(id, { url, number }) {
      db.prepare('UPDATE errors SET issue_url=?,issue_number=?,updated_at=? WHERE id=?').run(
        String(url).slice(0, 300),
        Number.isSafeInteger(number) ? number : null,
        now().toISOString(),
        id,
      );
    },
    remove(id) {
      const isRemoved = db.prepare('DELETE FROM errors WHERE id=?').run(id).changes > 0;
      log.info('errors.error.deleted', { errorId: id, isRemoved });
      return isRemoved;
    },
    /** Deletes only rows whose message contains the marker (used for generated test errors). */
    removeMarked(marker) {
      const text = String(marker || '');
      if (!text) {
        return 0;
      }
      const removedCount = db
        .prepare('DELETE FROM errors WHERE instr(message, ?) > 0')
        .run(text).changes;
      log.info('errors.marked.removed', { removedCount });
      return removedCount;
    },
    clear(statuses) {
      const list = statuses.filter((status) => ERROR_STATUSES.includes(status));
      if (!list.length) {
        return 0;
      }
      const removedCount = db
        .prepare(`DELETE FROM errors WHERE status IN (${list.map(() => '?').join(',')})`)
        .run(...list).changes;
      log.info('errors.clear.completed', { removedCount });
      return removedCount;
    },
    getSetting(key, fallback) {
      const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
      return row ? row.value : fallback;
    },
    setSetting(key, value) {
      db.prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, String(value));
    },
    getCursor(key) {
      return db.prepare('SELECT value FROM cursors WHERE key=?').get(key)?.value ?? null;
    },
    setCursor(key, value) {
      db.prepare(
        'INSERT INTO cursors(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run(key, String(value));
    },
    /** Returns true the first time a job reports this particular error text. */
    markJobErrorSeen(jobId, errorText) {
      const result = db
        .prepare('INSERT OR IGNORE INTO job_seen(job_id,error_hash,seen_at) VALUES(?,?,?)')
        .run(jobId, hash(errorText), now().toISOString());
      return result.changes > 0;
    },
    close() {
      db.close();
    },
  };
}
