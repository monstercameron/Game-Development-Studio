// Periodic safe backups of the databases that hold work no other file can rebuild: the render
// queue (jobs.sqlite), each project's provenance database, the settings, the interface
// translations, the encrypted credential store and the Megascans library/import queue. Backups
// are made by durable-db.js (VACUUM INTO from a separate read connection, checked, flushed, then
// renamed) into <runtime>/backups/<name>/, keep the newest few, and skip a database that is
// unchanged, too large or busy. errors.sqlite and logs.sqlite are not backed up: they are
// re-collected from logs and the job table.
import fs from 'node:fs';
import path from 'node:path';
import {
  backupDatabase,
  backupDirectoryFor,
  databaseKindFor,
  projectBackupDirectory,
  projectDatabaseKey,
} from './durable-db.js';
import { recordRecoveryEvent } from './recovery-events.js';
import { createLogger } from './app-log.js';

const log = createLogger('runtime');

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const METADATA_FILE = '.forge-meta.sqlite';

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// Logs one snapshot outcome. The name is reduced to its kind, so a project name is never
// logged. A failed snapshot logs no reason here: durable-db.js has already logged the error.
function logSnapshotResult(name, result, durationMs) {
  const kind = databaseKindFor(name);
  if (result.status === 'created') {
    log.info('backup.snapshot.completed', { kind, bytes: result.bytes, durationMs });
  } else if (result.status === 'failed') {
    log.warn('backup.snapshot.failed', { kind, durationMs });
  } else if (result.status === 'unchanged') {
    log.debug('backup.snapshot.skipped', { kind, reason: 'unchanged', durationMs });
  } else {
    log.info('backup.snapshot.skipped', { kind, reason: result.reason, durationMs });
  }
}

/** The databases to back up right now. Project databases are discovered on every run. */
export function backupTargets({ runtimeDirectory, projectsRoot }) {
  const targets = [
    { name: 'jobs', file: path.join(runtimeDirectory, 'jobs.sqlite') },
    { name: 'settings', file: path.join(runtimeDirectory, 'settings.sqlite') },
    { name: 'i18n', file: path.join(runtimeDirectory, 'i18n.sqlite') },
    { name: 'keys', file: path.join(runtimeDirectory, 'credentials', 'keys.sqlite') },
    { name: 'megascans', file: path.join(runtimeDirectory, 'megascans.sqlite') },
  ].map((target) => ({
    ...target,
    backupDirectory: backupDirectoryFor(target.name, runtimeDirectory),
  }));
  let entries = [];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    // No projects folder yet.
    log.debug('backup.projects.unavailable', { error });
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const folder = path.join(projectsRoot, entry.name);
    const file = path.join(folder, METADATA_FILE);
    if (fs.existsSync(file)) {
      targets.push({
        name: `project-${projectDatabaseKey(folder)}`,
        file,
        backupDirectory: projectBackupDirectory(folder, runtimeDirectory),
      });
    }
  }
  return targets;
}

/**
 * @param {{ runtimeDirectory: string, projectsRoot: string, intervalMs?: number,
 *   firstDelayMs?: number, keep?: number, backup?: typeof backupDatabase }} options
 */
export function createBackupManager({
  runtimeDirectory,
  projectsRoot,
  intervalMs = DEFAULT_INTERVAL_MS,
  firstDelayMs = FIRST_RUN_DELAY_MS,
  keep = 8,
  backup = backupDatabase,
}) {
  let timer = null;
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running) {
      log.debug('backup.run.skipped', { reason: 'busy' });
      return [];
    }
    running = true;
    const results = [];
    try {
      for (const target of backupTargets({ runtimeDirectory, projectsRoot })) {
        if (stopped) {
          break;
        }
        const startedAt = performance.now();
        const result = backup(target.file, {
          name: target.name,
          directory: runtimeDirectory,
          backupDirectory: target.backupDirectory,
          keep,
        });
        logSnapshotResult(target.name, result, Math.round(performance.now() - startedAt));
        results.push({ name: target.name, ...result });
        if (result.status === 'failed') {
          recordRecoveryEvent(
            {
              code: 'database.backup_failed',
              severity: 'warn',
              kind: 'database',
              id: target.name,
              detail: result.reason,
            },
            { directory: runtimeDirectory },
          );
        }
        await yieldToEventLoop();
      }
    } finally {
      running = false;
    }
    return results;
  }

  function schedule(delay) {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      runOnce()
        .catch((error) => {
          log.error('backup.run.failed', { error });
          console.error('Database backup run failed:', error.message);
        })
        .finally(() => schedule(intervalMs));
    }, delay);
    timer.unref();
  }

  return {
    runOnce,
    start() {
      stopped = false;
      if (!timer) {
        schedule(firstDelayMs);
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}
