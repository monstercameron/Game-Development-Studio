// SQLite open policy for every Forge database: explicit durability pragmas, a once-per-process
// integrity check, and a safe response to corruption. A database that fails its check is never
// deleted: it is moved aside as <name>.corrupt-<timestamp>, the newest backup that itself passes
// the check is restored, and only when there is none does the database start empty, with an
// error entry in the recovery journal (runtime/recovery-events.js) so the Recovery report says so.
// Backups are made with VACUUM INTO from a separate read connection. See docs/RESILIENCE.md.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fsyncFileSync, fsyncDirectorySync } from './durable-file.js';
import { defaultRuntimeDirectory, recordRecoveryEvent } from './recovery-events.js';
import { createLogger } from './app-log.js';

const log = createLogger('runtime');
const CHECK_SKIP_BYTES = 2 * 1024 ** 3;
const checkedFiles = new Set();
const SIDE_FILES = ['-wal', '-shm', '-journal'];

/**
 * The name a database is logged under: its kind only. Project databases are named after the
 * project folder (user text), so every one of them logs as `project`.
 */
export function databaseKindFor(name) {
  const text = String(name ?? 'database');
  return text.startsWith('project-') ? 'project' : text;
}

const isCorruptionError = (error) =>
  [11, 26].includes(error?.errcode) ||
  /malformed|not a database|corrupt|disk image/i.test(String(error?.message));

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:.TZ]/g, '');
}

function nameOf(file) {
  return path
    .basename(file)
    .replace(/^\./, '')
    .replace(/\.sqlite$/i, '');
}

/**
 * A stable folder-safe key for one project's metadata database: the folder name plus a short
 * hash of its full path, so two projects with similar names never share a backup folder.
 */
export function projectDatabaseKey(projectFolder) {
  const resolved = path.resolve(projectFolder);
  const hash = createHash('sha1').update(resolved.toLowerCase()).digest('hex').slice(0, 8);
  const label =
    path
      .basename(resolved)
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 40) || 'project';
  return `${label}-${hash}`;
}

/** Backup folder for a project's metadata database. */
export function projectBackupDirectory(
  projectFolder,
  runtimeDirectory = defaultRuntimeDirectory(),
) {
  return path.join(runtimeDirectory, 'backups', 'projects', projectDatabaseKey(projectFolder));
}

/** Where rotating backups for `name` live: <runtime>/backups/<name>. */
export function backupDirectoryFor(name, runtimeDirectory = defaultRuntimeDirectory()) {
  return path.join(runtimeDirectory, 'backups', name);
}

/**
 * Runs PRAGMA quick_check on an open connection.
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function quickCheck(db) {
  const rows = db.prepare('PRAGMA quick_check').all();
  const messages = rows.map((row) => String(Object.values(row)[0]));
  return { ok: messages.length === 1 && messages[0] === 'ok', messages: messages.slice(0, 5) };
}

/** Opens `file` read-only just to check it. Returns { ok, reason }. */
export function checkDatabaseFile(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    const result = quickCheck(db);
    return { ok: result.ok, reason: result.ok ? null : result.messages.join('; ') };
  } catch (error) {
    log.debug('db.check.failed', { error });
    return { ok: false, reason: error.message };
  } finally {
    try {
      db?.close();
    } catch (error) {
      // Nothing is left to release.
      log.debug('db.close.failed', { error });
    }
  }
}

/** Backups for `name`, newest first. */
export function listBackups(directory) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    log.debug('db.backups.unreadable', { error });
    return [];
  }
  return names
    .filter((entry) => /\.sqlite$/.test(entry) && !entry.startsWith('.'))
    .map((entry) => {
      const full = path.join(directory, entry);
      const info = fs.statSync(full);
      return { file: full, name: entry, bytes: info.size, modifiedAt: info.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

function moveSideFilesAside(file, target) {
  for (const suffix of SIDE_FILES) {
    try {
      fs.renameSync(file + suffix, target + suffix);
    } catch (error) {
      // Companion files exist only while the database is in use.
      log.debug('db.sidefile.skipped', { error });
    }
  }
}

/**
 * Puts a backup in place of `file`. The copy is staged, checked, flushed and renamed, so a
 * crash in the middle leaves `file` as it was.
 * @returns {boolean} true when a valid backup was restored.
 */
export function restoreNewestBackup(file, backupDirectory, { directory, name } = {}) {
  const kind = databaseKindFor(name);
  for (const backup of listBackups(backupDirectory)) {
    const staging = `${file}.restore-${process.pid}.tmp`;
    try {
      fs.copyFileSync(backup.file, staging);
      const result = checkDatabaseFile(staging);
      if (!result.ok) {
        recordRecoveryEvent(
          {
            code: 'database.backup_invalid',
            severity: 'warn',
            kind: 'database',
            id: name,
            detail: `Backup ${backup.name} failed its check.`,
          },
          { directory },
        );
        log.warn('db.backup.rejected', { kind, reason: 'failed_check' });
        fs.rmSync(staging, { force: true });
        continue;
      }
      fsyncFileSync(staging);
      fs.renameSync(staging, file);
      fsyncDirectorySync(path.dirname(file));
      recordRecoveryEvent(
        {
          code: 'database.restored',
          severity: 'warn',
          kind: 'database',
          id: name,
          detail: `Restored from backup ${backup.name} (${backup.modifiedAt}). Changes after that time were lost.`,
        },
        { directory },
      );
      log.warn('db.restore.completed', { kind, bytes: backup.bytes });
      return true;
    } catch (error) {
      log.error('db.restore.failed', { kind, error });
      fs.rmSync(staging, { force: true });
      recordRecoveryEvent(
        {
          code: 'database.restore_failed',
          severity: 'error',
          kind: 'database',
          id: name,
          detail: error.message,
        },
        { directory },
      );
    }
  }
  return false;
}

// Moves a database that failed its check aside and restores a backup or starts empty.
function recoverCorruptDatabase(
  file,
  { name, backupDirectory, directory, reason, corruptPath, onRecover },
) {
  const target = corruptPath ? corruptPath(file) : `${file}.corrupt-${stamp()}`;
  fs.renameSync(file, target);
  moveSideFilesAside(file, target);
  log.warn('db.corrupt.moved_aside', { kind: databaseKindFor(name) });
  recordRecoveryEvent(
    {
      code: 'database.quarantined',
      severity: 'error',
      kind: 'database',
      id: name,
      detail: `Failed its integrity check and was set aside as ${path.basename(target)}. ${reason || ''}`,
    },
    { directory },
  );
  const restored = restoreNewestBackup(file, backupDirectory, { directory, name });
  try {
    onRecover?.({ restored });
  } catch (error) {
    // A notification failure must not undo the recovery.
    log.warn('db.recover.callback_failed', { kind: databaseKindFor(name), error });
  }
  if (!restored) {
    log.error('db.fresh.started', { kind: databaseKindFor(name) });
    recordRecoveryEvent(
      {
        code: 'database.started_fresh',
        severity: 'error',
        kind: 'database',
        id: name,
        detail:
          'No valid backup existed, so the database started empty. The damaged file was kept.',
      },
      { directory },
    );
  }
}

/**
 * Opens a Forge database with explicit durability settings.
 *
 * @param {string} file
 * @param {object} [options]
 * @param {string} [options.name] Short name used for backups and recovery entries.
 * @param {'WAL'|'DELETE'|null} [options.journal] 'WAL' for databases written while read
 *   elsewhere; null leaves the file's existing journal mode untouched.
 * @param {'FULL'|'NORMAL'} [options.synchronous] FULL syncs every commit (a power loss cannot
 *   lose a committed write). NORMAL, in WAL mode, may lose the last commits of a power loss but
 *   never corrupts; use it only where that is harmless (rebuildable data).
 * @param {number} [options.busyTimeoutMs]
 * @param {boolean} [options.readOnly] Read-only connections are never checked or repaired.
 * @param {boolean} [options.check] Run the integrity check on the first open in this process.
 * @param {string} [options.directory] Runtime folder for the journal and the default backups.
 * @param {string} [options.backupDirectory]
 * @param {(file: string) => string} [options.corruptPath] Where a damaged file is moved
 *   (default `<file>.corrupt-<timestamp>`).
 * @param {(result: { restored: boolean }) => void} [options.onRecover] Called after a damaged
 *   file was set aside and a backup restored or an empty database started.
 * @returns {DatabaseSync}
 */
export function openDatabase(file, options = {}) {
  const {
    name = nameOf(file),
    journal = 'WAL',
    synchronous = 'FULL',
    busyTimeoutMs = 5000,
    readOnly = false,
    check = !readOnly,
    directory = defaultRuntimeDirectory(),
    backupDirectory = backupDirectoryFor(name, directory),
  } = options;
  if (readOnly) {
    const db = new DatabaseSync(file, { readOnly: true, timeout: busyTimeoutMs });
    return db;
  }
  const kind = databaseKindFor(name);
  const key = path.resolve(file);
  const shouldCheck = check && !checkedFiles.has(key) && fs.existsSync(file);
  if (shouldCheck) {
    checkedFiles.add(key);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch (error) {
      // The file vanished between the checks; opening creates it.
      log.debug('db.size.unknown', { error });
    }
    if (size > CHECK_SKIP_BYTES) {
      log.info('db.integrity.skipped', { kind, bytes: size, reason: 'too_large' });
      recordRecoveryEvent(
        {
          code: 'database.check_skipped',
          severity: 'warn',
          kind: 'database',
          id: name,
          detail: 'The database is too large to check at startup.',
        },
        { directory },
      );
    } else {
      const result = checkDatabaseFile(file);
      log.info('db.integrity.checked', { kind, isOk: result.ok, bytes: size });
      if (!result.ok && size > 0) {
        try {
          recoverCorruptDatabase(file, {
            name,
            backupDirectory,
            directory,
            reason: result.reason,
            corruptPath: options.corruptPath,
            onRecover: options.onRecover,
          });
        } catch (error) {
          log.error('db.quarantine.failed', { kind, error });
          // Another process may hold the file open; nothing was changed, so opening below
          // reports the original problem.
          recordRecoveryEvent(
            {
              code: 'database.quarantine_failed',
              severity: 'error',
              kind: 'database',
              id: name,
              detail: error.message,
            },
            { directory },
          );
        }
      }
    }
  }
  let db;
  try {
    db = new DatabaseSync(file, { timeout: busyTimeoutMs });
    if (journal) {
      db.exec(`PRAGMA journal_mode=${journal}`);
    }
    db.exec(`PRAGMA synchronous=${synchronous === 'NORMAL' ? 'NORMAL' : 'FULL'}`);
    db.exec(`PRAGMA busy_timeout=${Math.trunc(busyTimeoutMs)}`);
  } catch (error) {
    try {
      db?.close();
    } catch (error) {
      // The failure below is the useful one.
      log.debug('db.close.failed', { error });
    }
    throw error;
  }
  return db;
}

/** Test hook: forget which files were already checked in this process. */
export function resetDatabaseChecksForTests() {
  checkedFiles.clear();
}

export { isCorruptionError };

/**
 * Writes one rotating backup of `file` with VACUUM INTO from a separate read connection, so it
 * never runs inside the writer's transaction and, in WAL mode, does not block the writer. The
 * copy is staged, checked, flushed and only then renamed into place.
 *
 * @returns {{ status: 'created'|'unchanged'|'skipped'|'failed', reason?: string, file?: string,
 *   bytes?: number }}
 */
export function backupDatabase(
  file,
  {
    name = nameOf(file),
    directory = defaultRuntimeDirectory(),
    backupDirectory = backupDirectoryFor(name, directory),
    keep = 8,
    maxBytes = 512 * 1024 ** 2,
    totalMaxBytes = 2 * 1024 ** 3,
    now = new Date(),
  } = {},
) {
  let sourceInfo;
  try {
    sourceInfo = fs.statSync(file);
  } catch (error) {
    log.debug('db.source.missing', { kind: databaseKindFor(name), error });
    return { status: 'skipped', reason: 'missing' };
  }
  let latestChange = sourceInfo.mtimeMs;
  let totalBytes = sourceInfo.size;
  for (const suffix of ['-wal']) {
    try {
      const info = fs.statSync(file + suffix);
      latestChange = Math.max(latestChange, info.mtimeMs);
      totalBytes += info.size;
    } catch (error) {
      // No write-ahead log at the moment.
      log.debug('db.sidefile.skipped', { error });
    }
  }
  if (totalBytes > maxBytes) {
    return { status: 'skipped', reason: 'too_large' };
  }
  const existing = listBackups(backupDirectory);
  if (existing[0] && Date.parse(existing[0].modifiedAt) >= latestChange) {
    return { status: 'unchanged' };
  }
  fs.mkdirSync(backupDirectory, { recursive: true });
  const finalName = `${name}-${stamp(now)}.sqlite`;
  const staging = path.join(backupDirectory, `.${finalName}.${process.pid}.tmp`);
  let source;
  try {
    fs.rmSync(staging, { force: true });
    source = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    source.exec(`VACUUM INTO '${staging.replaceAll("'", "''")}'`);
    source.close();
    source = null;
    const result = checkDatabaseFile(staging);
    if (!result.ok) {
      throw Error(`The new backup failed its check: ${result.reason}`);
    }
    fsyncFileSync(staging);
    const finalPath = path.join(backupDirectory, finalName);
    fs.renameSync(staging, finalPath);
    fsyncDirectorySync(backupDirectory);
    rotateBackups(backupDirectory, { keep, totalMaxBytes, kind: databaseKindFor(name) });
    return { status: 'created', file: finalPath, bytes: fs.statSync(finalPath).size };
  } catch (error) {
    try {
      source?.close();
    } catch (closeError) {
      // Already closed.
      log.debug('db.close.failed', { error: closeError });
    }
    fs.rmSync(staging, { force: true });
    const busy = /locked|busy/i.test(error.message);
    if (!busy) {
      log.warn('db.backup.failed', { kind: databaseKindFor(name), error });
    }
    return { status: busy ? 'skipped' : 'failed', reason: busy ? 'busy' : error.message };
  }
}

function rotateBackups(directory, { keep, totalMaxBytes, kind }) {
  const backups = listBackups(directory);
  let total = backups.reduce((sum, item) => sum + item.bytes, 0);
  for (let index = backups.length - 1; index >= 1; index--) {
    if (index < keep && total <= totalMaxBytes) {
      break;
    }
    try {
      fs.rmSync(backups[index].file);
      total -= backups[index].bytes;
    } catch (error) {
      // A backup that cannot be removed now is retried at the next rotation.
      log.warn('db.backup.rotate_failed', { kind, error });
    }
  }
}
