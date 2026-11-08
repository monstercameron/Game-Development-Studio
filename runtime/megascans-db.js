// The app-level Megascans database: the local listing library and the import queue.
//
// It lives in `.forge-runtime/megascans.sqlite` and is separate from the render queue's
// `jobs.sqlite`, because imports have no GPU or memory semantics and must never share a lease
// or a model-load barrier with renders. Nothing here holds credentials or Fab responses.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MEGASCANS_DB_NAME = 'megascans.sqlite';

export function runtimeDirectory() {
  return process.env.FORGE_RUNTIME_DIR || path.join(appRoot, '.forge-runtime');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  license TEXT NOT NULL,
  seller TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_updated ON listings(updated_at);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  listing_id TEXT,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT,
  error TEXT,
  upload_bytes INTEGER NOT NULL,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  rate_bps REAL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  output TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_status ON imports(status, created_at);
CREATE TABLE IF NOT EXISTS search_pages (
  key TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  cursor TEXT NOT NULL,
  ids TEXT NOT NULL,
  next_cursor TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Columns added after the first schema. Old databases gain them in place.
const LISTING_COLUMNS = {
  source: "TEXT NOT NULL DEFAULT 'user'",
  user_tags: "TEXT NOT NULL DEFAULT '[]'",
  thumbnail_url: 'TEXT',
  category: 'TEXT',
  formats: "TEXT NOT NULL DEFAULT '[]'",
  size_min: 'INTEGER',
  size_max: 'INTEGER',
  published_at: 'TEXT',
  fetched_at: 'TEXT',
  detail: 'TEXT',
  detail_fetched_at: 'TEXT',
};

// 'upload' rows come from a file the user chose; 'fab' rows are downloaded by Forge.
const IMPORT_COLUMNS = {
  source: "TEXT NOT NULL DEFAULT 'upload'",
  file_uid: 'TEXT',
  format_code: 'TEXT',
};

function ensureColumns(db, table, columns) {
  const present = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!present.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * Opens (and creates) the Megascans database. Every connection waits for a competing writer
 * instead of failing, so two processes can share the file safely.
 * @param {string} [directory] Folder holding the database; defaults to the runtime folder.
 * @returns {{ db: DatabaseSync, hasFts: boolean, close: () => void }}
 */
export function openMegascansDb(directory = runtimeDirectory()) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, MEGASCANS_DB_NAME));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  ensureColumns(db, 'listings', LISTING_COLUMNS);
  ensureColumns(db, 'imports', IMPORT_COLUMNS);
  db.exec('CREATE INDEX IF NOT EXISTS listings_published ON listings(published_at)');
  let hasFts = true;
  try {
    // A standalone FTS5 table kept in step with `listings` by megascans-library.js.
    db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS listings_fts USING fts5(id UNINDEXED, title, tags, notes)',
    );
  } catch {
    // Search falls back to LIKE when this SQLite build has no FTS5.
    hasFts = false;
  }
  return { db, hasFts, close: () => db.close() };
}

/** Runs `work` inside an immediate transaction, rolling back on any error. */
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('Megascans transaction rollback failed:', rollbackError.message);
    }
    throw error;
  }
}

/**
 * Remembers the `ETag` and `Last-Modified` Fab sent with a response, so the next read can ask
 * "has this changed?" instead of downloading it again. Only validators are kept, never bodies,
 * and never anything that came from a download address.
 */
export class ValidatorStore {
  constructor(db, { now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
  }

  get(key) {
    const row = this.db.prepare('SELECT etag, last_modified FROM http_cache WHERE key=?').get(key);
    return row && (row.etag || row.last_modified)
      ? { etag: row.etag, lastModified: row.last_modified }
      : null;
  }

  set(key, { etag = null, lastModified = null }) {
    this.db
      .prepare(
        `INSERT INTO http_cache (key,etag,last_modified,fetched_at) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET etag=excluded.etag, last_modified=excluded.last_modified,
           fetched_at=excluded.fetched_at`,
      )
      .run(key, etag, lastModified, this.now().toISOString());
  }

  delete(key) {
    this.db.prepare('DELETE FROM http_cache WHERE key=?').run(key);
  }
}
