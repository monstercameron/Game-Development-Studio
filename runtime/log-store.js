// SQLite store for the structured application log: .forge-runtime/logs.sqlite. Only the studio
// host opens it for writing (through runtime/log-ingest.js); every other process writes spool
// files instead (runtime/app-log.js). See docs/LOGGING.md for the schema and retention rules.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  EVENT_PATTERN,
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  LOG_LIMITS,
  isLogComponent,
} from './log-fields.js';

export const LOG_SCHEMA_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 14;
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
export const MAX_QUERY_ROWS = 500;
export const MAX_EXPORT_ROWS = 50_000;
const PRUNE_BATCH_ROWS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VACUUM_INTERVAL_MS = 7 * DAY_MS;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    component TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '{}',
    process TEXT NOT NULL DEFAULT '',
    pid INTEGER NOT NULL DEFAULT 0,
    trace_id TEXT,
    job_id TEXT,
    duration_ms INTEGER,
    seq INTEGER NOT NULL DEFAULT 0,
    count INTEGER NOT NULL DEFAULT 1,
    first_ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
  CREATE INDEX IF NOT EXISTS logs_component_ts ON logs(component, ts);
  CREATE INDEX IF NOT EXISTS logs_level_ts ON logs(level, ts);
  CREATE INDEX IF NOT EXISTS logs_job ON logs(job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS logs_trace ON logs(trace_id) WHERE trace_id IS NOT NULL;
  CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
    event, message, content='logs', content_rowid='id', tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS logs_fts_insert AFTER INSERT ON logs BEGIN
    INSERT INTO logs_fts(rowid, event, message) VALUES (new.id, new.event, new.message);
  END;
  CREATE TRIGGER IF NOT EXISTS logs_fts_delete AFTER DELETE ON logs BEGIN
    INSERT INTO logs_fts(logs_fts, rowid, event, message)
      VALUES ('delete', old.id, old.event, old.message);
  END;
  CREATE TABLE IF NOT EXISTS spool_offsets (
    file TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

export class LogQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogQueryError';
    this.status = 400;
  }
}

function capText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function optionalInteger(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

function idText(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:+/-]{1,128}$/.test(value) ? value : null;
}

/**
 * Normalizes one spool record for storage. Records come from Forge's own loggers, which already
 * validated them; this pass only enforces types and size caps so a damaged or hand-edited spool
 * line cannot store oversized or malformed rows. Returns null for an unusable record.
 */
export function normalizeStoredRecord(record) {
  if (!record || typeof record !== 'object' || !Number.isFinite(record.ts)) {
    return null;
  }
  const level = LOG_LEVEL_NAMES.includes(record.level) ? record.level : 'info';
  const event =
    typeof record.event === 'string' &&
    record.event.length <= LOG_LIMITS.eventLength &&
    EVENT_PATTERN.test(record.event)
      ? record.event
      : 'log.event.invalid';
  let fields = '{}';
  if (record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)) {
    fields = JSON.stringify(record.fields);
    if (fields.length > LOG_LIMITS.fieldsJsonLength + 256) {
      fields = JSON.stringify({ fieldsTruncated: true });
    }
  }
  return {
    ts: Math.round(record.ts),
    level,
    component: isLogComponent(record.component) ? record.component : 'unknown',
    event,
    message: capText(record.message, LOG_LIMITS.messageLength),
    fields,
    process: capText(typeof record.process === 'string' ? record.process : '', 40),
    pid: Number.isInteger(record.pid) ? record.pid : 0,
    traceId: idText(record.traceId),
    jobId: idText(record.jobId),
    durationMs: optionalInteger(record.durationMs),
    seq: Number.isInteger(record.seq) ? record.seq : 0,
    count: Number.isInteger(record.count) && record.count > 0 ? record.count : 1,
    firstTs: optionalInteger(record.firstTs),
  };
}

// Turns free search text into an FTS5 query of quoted prefix terms, so user input can never
// inject FTS syntax. Returns '' when nothing searchable remains.
export function ftsQuery(text) {
  const terms = String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 8)
    .map((term) => `"${term.slice(0, 40)}"*`);
  return terms.join(' AND ');
}

function presentRow(row) {
  let fields;
  try {
    fields = JSON.parse(row.fields);
  } catch {
    fields = { fieldsUnreadable: true };
  }
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    component: row.component,
    event: row.event,
    message: row.message,
    fields,
    process: row.process,
    pid: row.pid,
    traceId: row.trace_id,
    jobId: row.job_id,
    durationMs: row.duration_ms,
    seq: row.seq,
    count: row.count,
    firstTs: row.first_ts,
  };
}

/**
 * Builds the WHERE clause for the shared filters.
 *
 * @param {object} filters
 * @param {string} [filters.level] minimum level (trace..error)
 * @param {string[]} [filters.components] registered component names
 * @param {string} [filters.eventPrefix] e.g. 'job.' or 'engine.start'
 * @param {string} [filters.text] full-text search over event and message
 * @param {number} [filters.since] inclusive lower bound, ms since epoch
 * @param {number} [filters.until] exclusive upper bound, ms since epoch
 * @param {string} [filters.jobId]
 * @param {string} [filters.traceId]
 * @param {string} [filters.process]
 */
function whereFor(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.level) {
    const minimum = LOG_LEVELS[filters.level];
    if (!minimum) {
      throw new LogQueryError('level must be trace, debug, info, warn or error.');
    }
    const levels = LOG_LEVEL_NAMES.filter((name) => LOG_LEVELS[name] >= minimum);
    clauses.push(`level IN (${levels.map(() => '?').join(',')})`);
    params.push(...levels);
  }
  if (filters.components?.length) {
    const components = filters.components.filter(isLogComponent);
    if (components.length !== filters.components.length) {
      throw new LogQueryError('component must be a registered component name.');
    }
    clauses.push(`component IN (${components.map(() => '?').join(',')})`);
    params.push(...components);
  }
  if (filters.eventPrefix) {
    if (!/^[a-z0-9_.-]{1,96}$/.test(filters.eventPrefix)) {
      throw new LogQueryError(
        'event must be lowercase letters, digits, dots, dashes or underscores.',
      );
    }
    clauses.push('event >= ? AND event < ?');
    params.push(filters.eventPrefix, `${filters.eventPrefix}￿`);
  }
  if (filters.text) {
    const match = ftsQuery(filters.text);
    if (match) {
      clauses.push('id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)');
      params.push(match);
    }
  }
  if (Number.isFinite(filters.since)) {
    clauses.push('ts >= ?');
    params.push(filters.since);
  }
  if (Number.isFinite(filters.until)) {
    clauses.push('ts < ?');
    params.push(filters.until);
  }
  for (const [key, column] of [
    ['jobId', 'job_id'],
    ['traceId', 'trace_id'],
    ['process', 'process'],
  ]) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      if (!idText(filters[key])) {
        throw new LogQueryError(`${key} has an invalid format.`);
      }
      clauses.push(`${column} = ?`);
      params.push(filters[key]);
    }
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function parseCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') {
    return null;
  }
  const match = /^(\d{1,15})_(\d{1,15})$/.exec(String(cursor));
  if (!match) {
    throw new LogQueryError('cursor is invalid.');
  }
  return { ts: Number(match[1]), id: Number(match[2]) };
}

/**
 * Opens (creating if needed) the log database.
 *
 * @param {object} options
 * @param {string} options.directory runtime folder that holds logs.sqlite
 * @param {() => number} [options.now]
 */
export function createLogStore({ directory, now = () => Date.now() }) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'logs.sqlite');
  const db = new DatabaseSync(file, { timeout: 2000 });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    // auto_vacuum must be chosen before the first table exists; it lets retention give space
    // back to the file system without a full VACUUM.
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec(SCHEMA);
    const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    if (!version) {
      db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(
        String(LOG_SCHEMA_VERSION),
      );
    } else if (Number(version.value) > LOG_SCHEMA_VERSION) {
      throw new Error(`logs.sqlite schema ${version.value} is newer than this studio.`);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare(
    `INSERT INTO logs(ts,level,component,event,message,fields,process,pid,trace_id,job_id,
      duration_ms,seq,count,first_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const readOffset = db.prepare('SELECT offset FROM spool_offsets WHERE file=?');
  const writeOffset = db.prepare(
    'INSERT INTO spool_offsets(file,offset,updated_at) VALUES(?,?,?) ON CONFLICT(file) DO UPDATE SET offset=excluded.offset, updated_at=excluded.updated_at',
  );
  const bumpCounter = db.prepare(
    'INSERT INTO counters(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value',
  );

  function insertRows(records) {
    let inserted = 0;
    for (const raw of records) {
      const row = normalizeStoredRecord(raw);
      if (!row) {
        continue;
      }
      insert.run(
        row.ts,
        row.level,
        row.component,
        row.event,
        row.message,
        row.fields,
        row.process,
        row.pid,
        row.traceId,
        row.jobId,
        row.durationMs,
        row.seq,
        row.count,
        row.firstTs,
      );
      inserted += 1;
    }
    return inserted;
  }

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getMeta(key) {
    return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
  }

  function setMeta(key, value) {
    db.prepare(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, String(value));
  }

  function sizes() {
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = db.prepare('PRAGMA page_count').get().page_count;
    const freePages = db.prepare('PRAGMA freelist_count').get().freelist_count;
    let walBytes = 0;
    try {
      walBytes = fs.statSync(`${file}-wal`).size;
    } catch {
      // No WAL file yet: nothing was written since the last checkpoint.
    }
    return {
      fileBytes: pageCount * pageSize,
      usedBytes: (pageCount - freePages) * pageSize,
      walBytes,
    };
  }

  function deleteOldest(limit) {
    return db
      .prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY ts ASC, id ASC LIMIT ?)')
      .run(limit).changes;
  }

  const store = {
    file,

    /** Inserts already-validated records in one transaction. Returns the inserted count. */
    insert(records) {
      return transaction(() => insertRows(records));
    },

    /**
     * Inserts the records read from a spool file and advances its offset atomically. When the
     * stored offset is not `expectedOffset` another ingester got there first and nothing is
     * written. Returns the inserted count, or null when skipped.
     */
    ingestSpoolChunk({ spoolFile, expectedOffset, nextOffset, records, rejectedLines = 0 }) {
      return transaction(() => {
        const current = readOffset.get(spoolFile)?.offset ?? 0;
        if (current !== expectedOffset) {
          return null;
        }
        const inserted = insertRows(records);
        writeOffset.run(spoolFile, nextOffset, now());
        if (rejectedLines) {
          bumpCounter.run('spool_rejected_lines', rejectedLines);
        }
        return inserted;
      });
    },

    spoolOffset(spoolFile) {
      return readOffset.get(spoolFile)?.offset ?? 0;
    },

    forgetSpoolFile(spoolFile) {
      db.prepare('DELETE FROM spool_offsets WHERE file=?').run(spoolFile);
    },

    spoolFiles() {
      return db.prepare('SELECT file, offset FROM spool_offsets').all();
    },

    addCounter(name, value) {
      if (/^[a-z_]{1,40}$/.test(name) && Number.isInteger(value) && value > 0) {
        bumpCounter.run(name, value);
      }
    },

    /**
     * Newest-first rows matching the filters, with a cursor for the next (older) page.
     *
     * @returns {{ rows: object[], nextCursor: string|null }}
     */
    query(filters = {}, { limit = 100, cursor } = {}) {
      const count = Math.max(1, Math.min(MAX_QUERY_ROWS, Number(limit) || 100));
      const { where, params } = whereFor(filters);
      const after = parseCursor(cursor);
      const cursorClause = after
        ? `${where ? ' AND' : 'WHERE'} (ts < ? OR (ts = ? AND id < ?))`
        : '';
      const rows = db
        .prepare(`SELECT * FROM logs ${where}${cursorClause} ORDER BY ts DESC, id DESC LIMIT ?`)
        .all(...params, ...(after ? [after.ts, after.ts, after.id] : []), count + 1);
      const page = rows.slice(0, count).map(presentRow);
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor: rows.length > count && last ? `${last.ts}_${last.id}` : null,
      };
    },

    /** Rows inserted after `afterId`, oldest first, for live tailing. */
    tail(filters = {}, { afterId = 0, limit = 200 } = {}) {
      const count = Math.max(1, Math.min(MAX_QUERY_ROWS, Number(limit) || 200));
      const { where, params } = whereFor(filters);
      const start = Number.isInteger(afterId) && afterId >= 0 ? afterId : 0;
      const rows = db
        .prepare(
          `SELECT * FROM logs ${where}${where ? ' AND' : 'WHERE'} id > ? ORDER BY id ASC LIMIT ?`,
        )
        .all(...params, start, count)
        .map(presentRow);
      const lastId = rows.length
        ? rows[rows.length - 1].id
        : start || (db.prepare('SELECT MAX(id) AS id FROM logs').get().id ?? 0);
      return { rows, cursor: lastId };
    },

    /** Rows for export, oldest first, capped at MAX_EXPORT_ROWS. */
    *exportRows(filters = {}, { limit = MAX_EXPORT_ROWS } = {}) {
      const count = Math.max(1, Math.min(MAX_EXPORT_ROWS, Number(limit) || MAX_EXPORT_ROWS));
      const { where, params } = whereFor(filters);
      const statement = db.prepare(`SELECT * FROM logs ${where} ORDER BY ts ASC, id ASC LIMIT ?`);
      for (const row of statement.iterate(...params, count)) {
        yield presentRow(row);
      }
    },

    /** Counts by level and component, top events, drop counters and sizes. */
    summary(filters = {}) {
      const { where, params } = whereFor(filters);
      const byLevel = Object.fromEntries(
        db
          .prepare(`SELECT level, SUM(count) AS n FROM logs ${where} GROUP BY level`)
          .all(...params)
          .map((row) => [row.level, row.n]),
      );
      const byComponent = db
        .prepare(
          `SELECT component, SUM(count) AS n FROM logs ${where} GROUP BY component ORDER BY n DESC LIMIT 60`,
        )
        .all(...params)
        .map((row) => ({ component: row.component, count: row.n }));
      const topEvents = db
        .prepare(
          `SELECT event, component, MAX(level) AS level, SUM(count) AS n FROM logs ${where} GROUP BY event, component ORDER BY n DESC LIMIT 20`,
        )
        .all(...params)
        .map((row) => ({ event: row.event, component: row.component, count: row.n }));
      const range = db
        .prepare(`SELECT COUNT(*) AS rows, MIN(ts) AS oldest, MAX(ts) AS newest FROM logs ${where}`)
        .get(...params);
      const dropped = db
        .prepare(
          `SELECT COALESCE(SUM(json_extract(fields,'$.droppedCount')),0) AS records,
             COALESCE(SUM(json_extract(fields,'$.droppedFields')),0) AS fields,
             COALESCE(SUM(CASE WHEN count > 1 THEN count ELSE 0 END),0) AS collapsed
           FROM logs`,
        )
        .get();
      const counters = Object.fromEntries(
        db
          .prepare('SELECT name, value FROM counters')
          .all()
          .map((row) => [row.name, row.value]),
      );
      return {
        rows: range.rows,
        oldestTs: range.oldest,
        newestTs: range.newest,
        byLevel,
        byComponent,
        topEvents,
        dropped: {
          records: dropped.records,
          fields: dropped.fields,
          collapsedRecords: dropped.collapsed,
          ...counters,
        },
        ...sizes(),
      };
    },

    /**
     * Retention: deletes rows older than `maxAgeDays`, then the oldest rows while the used size
     * is above `maxBytes`, in short transactions so the host stays responsive. Gives free pages
     * back with an incremental vacuum, and runs a full VACUUM at most once a week when more than
     * half of the file is free.
     */
    prune({ maxAgeDays = DEFAULT_RETENTION_DAYS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
      const started = now();
      const cutoff = started - maxAgeDays * DAY_MS;
      let deletedByAge = 0;
      let deletedBySize = 0;
      for (;;) {
        const changes = transaction(
          () =>
            db
              .prepare(
                'DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE ts < ? ORDER BY ts LIMIT ?)',
              )
              .run(cutoff, PRUNE_BATCH_ROWS).changes,
        );
        deletedByAge += changes;
        if (changes < PRUNE_BATCH_ROWS) {
          break;
        }
      }
      for (let pass = 0; pass < 200 && sizes().usedBytes > maxBytes; pass += 1) {
        const total = db.prepare('SELECT COUNT(*) AS n FROM logs').get().n;
        if (!total) {
          break;
        }
        const batch = Math.max(100, Math.min(PRUNE_BATCH_ROWS, Math.ceil(total * 0.05)));
        deletedBySize += transaction(() => deleteOldest(batch));
      }
      if (deletedByAge + deletedBySize > 0) {
        db.exec('PRAGMA incremental_vacuum');
      }
      const after = sizes();
      const lastVacuum = Number(getMeta('last_vacuum_ts') || 0);
      let isVacuumed = false;
      if (
        after.fileBytes > 0 &&
        after.usedBytes < after.fileBytes / 2 &&
        started - lastVacuum > VACUUM_INTERVAL_MS
      ) {
        db.exec('VACUUM');
        setMeta('last_vacuum_ts', started);
        isVacuumed = true;
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return { deletedByAge, deletedBySize, isVacuumed, ...sizes() };
    },

    /** Deletes rows older than `days` days (0 deletes everything). Returns the deleted count. */
    deleteOlderThan(days) {
      const cutoff = now() - days * DAY_MS;
      let total = 0;
      for (;;) {
        const changes = transaction(
          () =>
            db
              .prepare(
                'DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE ts < ? ORDER BY ts LIMIT ?)',
              )
              .run(cutoff, PRUNE_BATCH_ROWS).changes,
        );
        total += changes;
        if (changes < PRUNE_BATCH_ROWS) {
          break;
        }
      }
      if (total) {
        db.exec('PRAGMA incremental_vacuum');
      }
      return total;
    },

    close() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
  return store;
}
