// Startup sweep for files a crash can leave behind. Forge writes artifacts and state files to
// a hidden staging name beside the final name (durable-file.js, job-io.js, vegetation,
// thumbnails) and renames when complete, so a crash leaves a hidden `.tmp`/`.part` file and never
// a half-written final file. This module finds those leftovers and applies one policy:
//
// - delete a hidden `.tmp`/`.part` staging file only when it is older than `maxAgeMs` (24 hours
//   by default) and no open render job's id appears in its name;
// - everything else (conflict markers, damaged databases set aside, project folders without
//   readable metadata, staged Megascans uploads) is reported, never removed;
// - a reported file can later be moved into <runtime>/quarantine on the user's request.
//
// Paths in results are project-relative, never absolute. Megascans staging folders belong to the
// import queue and its own sweep (megascans-service.js) and are only counted here.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './app-log.js';
import { defaultRuntimeDirectory, errorLogFields, recordRecoveryEvent } from './recovery-events.js';

export const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DEPTH = 2;
const MAX_ENTRIES = 20000;
const JOB_ID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
const OPEN_STATUSES = [
  'queued',
  'waiting_engine',
  'waiting_memory',
  'preparing',
  'needs_attention',
  'submitting',
  'running',
  'finalizing',
  'interrupted',
];
const SKIPPED_DIRECTORIES = new Set(['.forge-staging', 'node_modules', '.forge-trash']);
const log = createLogger('runtime');

// Hidden staging names written by Forge: `.<name>.<token>.tmp`, `.<name>.<token>.part`,
// `.<name>.part.mp4`. The leading dot keeps them out of asset listings.
const STAGING_FILE = /^(?:\..+\.(?:tmp|part|part\.mp4)|\.forge-convert-[0-9a-f-]{36}\.\w+)$/i;
const REPORT_ONLY = [
  { pattern: /^\..+\.conflict$/i, kind: 'output_conflict' },
  { pattern: /\.corrupt-\d+/i, kind: 'damaged_database' },
  // A 3D conversion works in a hidden folder and publishes by linking files out of it.
  { pattern: /^\.forge-convert-[0-9a-f-]{36}$/i, kind: 'conversion_staging_folder' },
];

function entryId(scope, project, relative) {
  return createHash('sha1').update(`${scope}|${project}|${relative}`).digest('hex').slice(0, 16);
}

/** Ids of render jobs that are not finished, read-only. Returns null when unavailable. */
export function readOpenJobIds(runtimeDirectory) {
  const file = path.join(runtimeDirectory, 'jobs.sqlite');
  if (!fs.existsSync(file)) {
    return new Set();
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    const marks = OPEN_STATUSES.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id FROM jobs WHERE status IN (${marks})`).all(...OPEN_STATUSES);
    return new Set(rows.map((row) => row.id.toLowerCase()));
  } catch (error) {
    // Without the job table, a staging file cannot be matched to its job, so none is deleted.
    log.warn('recovery.jobs.read.failed', errorLogFields(error));
    return null;
  } finally {
    try {
      db?.close();
    } catch (error) {
      // Nothing left to release.
      log.debug('recovery.jobs.close.failed', errorLogFields(error));
    }
  }
}

function readProjectIdentity(folder) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(folder, '.forge-project.json'), 'utf8'));
    return typeof meta?.id === 'string' && /^[a-f0-9-]{36}$/i.test(meta.id) ? meta.id : null;
  } catch (error) {
    log.debug('recovery.project.metadata.failed', errorLogFields(error));
    return null;
  }
}

function classify(name, { ageMs, maxAgeMs, openJobIds }) {
  for (const rule of REPORT_ONLY) {
    if (rule.pattern.test(name)) {
      return { kind: rule.kind, deletable: false };
    }
  }
  if (!STAGING_FILE.test(name)) {
    return null;
  }
  const referencedJob = JOB_ID.exec(name)?.[0].toLowerCase();
  if (referencedJob && (!openJobIds || openJobIds.has(referencedJob))) {
    return { kind: 'staging_in_use', deletable: false, skip: true };
  }
  if (ageMs < maxAgeMs) {
    return { kind: 'staging_recent', deletable: false, skip: true };
  }
  return { kind: 'stale_staging', deletable: true };
}

function* walk(root, depth = 0, budget = { left: MAX_ENTRIES }) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    log.debug('recovery.folder.read.failed', errorLogFields(error));
    return;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) {
      return;
    }
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (REPORT_ONLY.some((rule) => rule.pattern.test(entry.name))) {
        yield { full, name: entry.name };
        continue;
      }
      if (depth < MAX_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) {
        yield* walk(full, depth + 1, budget);
      }
      continue;
    }
    if (entry.isFile()) {
      yield { full, name: entry.name };
    }
  }
}

function describe(root, scope, project, found, decision, ageMs) {
  const relative = path.relative(root, found.full).split(path.sep).join('/');
  let bytes = 0;
  try {
    bytes = fs.statSync(found.full).size;
  } catch (error) {
    // The file vanished while scanning.
    log.debug('recovery.file.stat.failed', errorLogFields(error));
  }
  return {
    id: entryId(scope, project?.name || '', relative),
    scope,
    project: project ? { id: project.id, name: project.name } : null,
    path: relative,
    kind: decision.kind,
    bytes,
    ageHours: Math.round((ageMs / 3600000) * 10) / 10,
  };
}

/**
 * Scans the runtime folder and every project for crash leftovers.
 *
 * @param {object} options
 * @param {string} [options.runtimeDirectory]
 * @param {string} options.projectsRoot
 * @param {boolean} [options.apply] Delete stale staging files (default true). With false the
 *   sweep only reports what it would delete.
 * @param {number} [options.maxAgeMs]
 * @param {() => number} [options.now]
 * @returns {{ scanned: number, deleted: object[], reported: object[], skipped: number,
 *   stagedImports: number, projectProblems: object[], jobsUnreadable: boolean }}
 */
export function runSweep({
  runtimeDirectory = defaultRuntimeDirectory(),
  projectsRoot,
  apply = true,
  maxAgeMs = SWEEP_MAX_AGE_MS,
  now = Date.now,
} = {}) {
  const stop = log.time('recovery.sweep.completed', { dryRun: !apply });
  log.debug('recovery.sweep.started', { dryRun: !apply });
  const openJobIds = readOpenJobIds(runtimeDirectory);
  const result = {
    scanned: 0,
    deleted: [],
    reported: [],
    skipped: 0,
    stagedImports: 0,
    projectProblems: [],
    jobsUnreadable: openJobIds === null,
  };

  function consider(root, scope, project, found) {
    result.scanned++;
    let ageMs;
    try {
      ageMs = now() - fs.statSync(found.full).mtimeMs;
    } catch (error) {
      log.debug('recovery.file.stat.failed', errorLogFields(error));
      return;
    }
    const decision = classify(found.name, { ageMs, maxAgeMs, openJobIds });
    if (!decision) {
      return;
    }
    if (decision.skip) {
      result.skipped++;
      return;
    }
    const item = describe(root, scope, project, found, decision, ageMs);
    if (decision.deletable && apply) {
      try {
        // log-coverage: ignore -- each deletion is counted in the sweep.staging_deleted journal event
        fs.rmSync(found.full, { force: true });
        result.deleted.push({ ...item, action: 'deleted' });
        return;
      } catch (error) {
        item.error = error.code || 'error';
        log.warn('recovery.staging.delete.failed', errorLogFields(error));
      }
    }
    result.reported.push({ ...item, action: decision.deletable ? 'would_delete' : 'reported' });
  }

  // The runtime folder also holds virtual environments and third-party sources: scan only its own
  // top level and the folders Forge writes staging files into.
  const runtimeRoots = [
    [runtimeDirectory, MAX_DEPTH],
    [path.join(runtimeDirectory, 'backups'), -1],
    [path.join(runtimeDirectory, 'credentials'), MAX_DEPTH],
    [path.join(runtimeDirectory, 'model-removals'), MAX_DEPTH],
  ];
  for (const [directory, startDepth] of runtimeRoots) {
    for (const found of walk(directory, startDepth)) {
      consider(runtimeDirectory, 'runtime', null, found);
    }
  }

  let entries = [];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    // No projects folder yet.
    log.debug('recovery.projects.read.skipped', errorLogFields(error));
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) {
      continue;
    }
    const folder = path.join(projectsRoot, entry.name);
    const id = readProjectIdentity(folder);
    if (!id) {
      let isEmpty = false;
      try {
        isEmpty = fs.readdirSync(folder).length === 0;
      } catch (error) {
        // Unreadable folders are reported below without a size.
        log.debug('recovery.folder.read.failed', errorLogFields(error));
      }
      result.projectProblems.push({
        folder: entry.name,
        kind: isEmpty ? 'project_folder_empty' : 'project_metadata_unreadable',
      });
      continue;
    }
    const project = { id, name: entry.name };
    for (const found of walk(folder)) {
      consider(folder, 'project', project, found);
    }
    const staging = path.join(folder, '.forge-staging', 'megascans');
    try {
      result.stagedImports += fs.readdirSync(staging).length;
    } catch (error) {
      // No staged imports in this project.
      log.debug('recovery.staging.read.skipped', errorLogFields(error));
    }
  }

  if (result.deleted.length) {
    recordRecoveryEvent(
      {
        code: 'sweep.staging_deleted',
        kind: 'sweep',
        count: result.deleted.length,
        detail: 'Removed stale staging files left by an interrupted write.',
      },
      { directory: runtimeDirectory },
    );
  }
  if (result.reported.length) {
    recordRecoveryEvent(
      {
        code: 'sweep.orphans_found',
        severity: 'warn',
        kind: 'sweep',
        count: result.reported.length,
        detail: 'Files from an interrupted operation were found and left in place.',
      },
      { directory: runtimeDirectory },
    );
  }
  stop({
    scannedCount: result.scanned,
    deletedCount: result.deleted.length,
    reportedCount: result.reported.length,
    skippedCount: result.skipped,
    stagedImportCount: result.stagedImports,
    hasUnreadableJobs: result.jobsUnreadable,
  });
  return result;
}

/**
 * Moves reported files into <runtime>/quarantine/<stamp>/ (recoverable, never deleted).
 * `ids` come from a report; each is re-resolved by a fresh scan so a client cannot name a path.
 * @returns {{ moved: string[], failed: { id: string, error: string }[], missing: string[] }}
 */
export function quarantineOrphans({
  ids,
  runtimeDirectory = defaultRuntimeDirectory(),
  projectsRoot,
  now = () => new Date(),
}) {
  const wanted = new Set(ids);
  const scan = runSweep({
    runtimeDirectory,
    projectsRoot,
    apply: false,
    maxAgeMs: 0,
    now: Date.now,
  });
  const outcome = { moved: [], failed: [], missing: [] };
  const stamp = now()
    .toISOString()
    .replace(/[-:.TZ]/g, '');
  const destinationRoot = path.join(runtimeDirectory, 'quarantine', stamp);
  const known = new Map(scan.reported.map((item) => [item.id, item]));
  for (const id of wanted) {
    const item = known.get(id);
    if (!item || item.kind === 'staging_in_use') {
      outcome.missing.push(id);
      continue;
    }
    const root =
      item.scope === 'runtime' ? runtimeDirectory : path.join(projectsRoot, item.project.name);
    const source = path.join(root, ...item.path.split('/'));
    try {
      fs.mkdirSync(destinationRoot, { recursive: true });
      // log-coverage: ignore -- each move is counted in the sweep.quarantined journal event
      fs.renameSync(source, path.join(destinationRoot, `${id}-${path.basename(source)}`));
      outcome.moved.push(id);
    } catch (error) {
      log.warn('recovery.quarantine.failed', { id, ...errorLogFields(error) });
      outcome.failed.push({ id, error: error.code || 'error' });
    }
  }
  if (outcome.moved.length) {
    recordRecoveryEvent(
      {
        code: 'sweep.quarantined',
        kind: 'sweep',
        count: outcome.moved.length,
        detail: 'Moved orphaned files to the quarantine folder at the user request.',
      },
      { directory: runtimeDirectory },
    );
  }
  return outcome;
}
