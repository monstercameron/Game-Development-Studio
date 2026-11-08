// The Recovery report: what the studio found, repaired and still needs from the user after it
// stopped without finishing an orderly shutdown (crash, kill, power loss, forced shutdown), or
// after a database was repaired or a supervisor gave up restarting a failing process.
//
// The report is computed from evidence, not remembered: the session marker (session-state.js),
// the recovery journal (recovery-events.js), the job table read-only, the staging sweep
// (recovery-sweep.js) and live engine status. Dismissing it stores a fingerprint of what was
// shown, so it comes back only when something new needs attention. Nothing here talks to an
// engine to start, stop or load it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './app-log.js';
import { atomicWriteFileSync } from './durable-file.js';
import { listBackups, backupDirectoryFor } from './durable-db.js';
import { classifyJobForRecovery, inspectFinishedOutput } from './job-recovery.js';
import { readRecoveryNeeded } from './crash-loop.js';
import { redactText } from './error-redaction.js';
import {
  defaultRuntimeDirectory,
  errorLogFields,
  readRecoveryEvents,
  recordRecoveryEvent,
} from './recovery-events.js';
import { quarantineOrphans, runSweep } from './recovery-sweep.js';

export const STARTUP_FILE = 'recovery-startup.json';
export const STATE_FILE = 'recovery-state.json';
export const SNAPSHOT_FILE = 'recovery-report.json';
const ATTENTION_STATUSES = ['interrupted', 'needs_attention'];
const KNOWN_DATABASES = ['jobs', 'settings', 'i18n', 'keys', 'megascans', 'errors'];
const MAX_JOBS = 100;
const log = createLogger('runtime');

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    // A missing or damaged JSON file is expected for state that has not been written yet.
    log.debug('recovery.file.read.failed', errorLogFields(error));
    return null;
  }
}

function clean(text, limit = 300) {
  return redactText(typeof text === 'string' ? text : '').slice(0, limit);
}

function folderOf(projectsRoot, projectId) {
  let entries;
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    log.debug('recovery.projects.read.failed', errorLogFields(error));
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const meta = readJson(path.join(projectsRoot, entry.name, '.forge-project.json'));
    if (meta?.id === projectId) {
      return { folder: path.join(projectsRoot, entry.name), name: entry.name };
    }
  }
  return null;
}

// Reads unfinished jobs that need a person. The request column (which holds prompts) is never
// selected.
function readAttentionJobs(runtimeDirectory) {
  const file = path.join(runtimeDirectory, 'jobs.sqlite');
  if (!fs.existsSync(file)) {
    return { jobs: [], available: true };
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    const marks = ATTENTION_STATUSES.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id,type,project_id,status,remote_id,stage,error,output,updated_at FROM jobs
         WHERE status IN (${marks}) ORDER BY updated_at DESC LIMIT ${MAX_JOBS}`,
      )
      .all(...ATTENTION_STATUSES);
    return {
      available: true,
      jobs: rows.map((row) => ({
        id: row.id,
        type: row.type,
        projectId: row.project_id,
        status: row.status,
        remoteId: row.remote_id,
        stage: row.stage,
        error: row.error,
        output: row.output,
        updatedAt: row.updated_at,
      })),
    };
  } catch (error) {
    log.warn('recovery.jobs.read.failed', errorLogFields(error));
    return { jobs: [], available: false };
  } finally {
    try {
      db?.close();
    } catch (error) {
      // Nothing left to release.
      log.debug('recovery.jobs.close.failed', errorLogFields(error));
    }
  }
}

function databaseSummary(runtimeDirectory, events) {
  return KNOWN_DATABASES.map((name) => {
    const own = events.filter((event) => event.kind === 'database' && event.id === name);
    const backups = listBackups(backupDirectoryFor(name, runtimeDirectory));
    const last = [...own].reverse().find((event) => event.code.startsWith('database.'));
    let state = 'ok';
    if (own.some((event) => event.code === 'database.started_fresh')) {
      state = 'started_fresh';
    } else if (own.some((event) => event.code === 'database.restored')) {
      state = 'restored';
    } else if (own.some((event) => event.code === 'database.quarantined')) {
      state = 'quarantined';
    }
    return {
      name,
      state,
      backups: backups.length,
      newestBackupAt: backups[0]?.modifiedAt || null,
      note: last?.detail ? clean(last.detail) : null,
    };
  });
}

/**
 * @param {object} options
 * @param {string} [options.runtimeDirectory]
 * @param {string} options.projectsRoot
 * @param {(path: string, init?: object) => Promise<any>} [options.callRuntime] Loopback call to
 *   the studio's own /api/runtime routes (injected by the HTTP service; tests supply a fake).
 * @param {() => number} [options.now]
 */
export function createRecoveryManager({
  runtimeDirectory = defaultRuntimeDirectory(),
  projectsRoot,
  callRuntime = async () => {
    throw Error('The runtime is not reachable.');
  },
  now = Date.now,
} = {}) {
  let sweep = null;

  function startupInfo() {
    return (
      readJson(path.join(runtimeDirectory, STARTUP_FILE)) || {
        sessionId: null,
        startedAt: null,
        previous: { state: 'none' },
      }
    );
  }

  /** Runs the staging sweep once (deleting only stale staging files) and keeps the result. */
  function runStartupSweep({ apply = true } = {}) {
    sweep = runSweep({ runtimeDirectory, projectsRoot, apply, now });
    return sweep;
  }

  async function engineStates() {
    try {
      const body = await callRuntime('/api/runtime/services');
      const services = Array.isArray(body?.services) ? body.services : [];
      return services
        .filter((service) => service?.id)
        .map((service) => ({
          id: String(service.id),
          name: clean(service.name, 80),
          status: String(service.status || 'unknown'),
          reason: typeof service.reason === 'string' ? service.reason : null,
          managed: service.managed === true,
          ownership: service.ownershipRecovery || null,
        }))
        .filter(
          (service) =>
            service.status === 'unavailable' ||
            service.status === 'unverified' ||
            service.ownership,
        );
    } catch (error) {
      // Runtime routes unreachable: engine status is left out of the report.
      log.debug('recovery.engines.read.failed', errorLogFields(error));
      return null;
    }
  }

  async function jobSection() {
    const { jobs, available } = readAttentionJobs(runtimeDirectory);
    const items = [];
    for (const job of jobs) {
      const entry = classifyJobForRecovery(job);
      let output = { state: 'unknown' };
      const project = folderOf(projectsRoot, job.projectId);
      if (project) {
        output = await inspectFinishedOutput(job, project.folder).catch((error) => {
          log.debug('recovery.output.inspect.failed', { jobId: job.id, ...errorLogFields(error) });
          return { state: 'unknown' };
        });
      }
      items.push({
        ...entry,
        stage: clean(entry.stage, 160),
        error: clean(job.error, 300),
        project: project?.name || null,
        savedOutput: output.state,
        savedOutputPath:
          output.state === 'valid' || output.state === 'unverified' ? output.output : null,
      });
    }
    return { available, items };
  }

  function fingerprint(report) {
    return createHash('sha1')
      .update(
        JSON.stringify([
          report.jobs.items.map((job) => [job.id, job.status]),
          report.orphans.items.map((item) => item.id),
          report.events.filter((event) => event.severity !== 'info').length,
          report.recoveryNeeded?.at || null,
          report.unclean,
        ]),
      )
      .digest('hex');
  }

  /** Builds the current report. `rescan` repeats the staging scan without deleting. */
  async function report({ rescan = false } = {}) {
    const startup = startupInfo();
    if (!sweep || rescan) {
      runStartupSweep({ apply: false });
    }
    const since = startup.previous?.startedAt || startup.startedAt || undefined;
    const events = readRecoveryEvents({ directory: runtimeDirectory, since, limit: 200 });
    const [jobs, engines] = await Promise.all([jobSection(), engineStates()]);
    const recoveryNeeded = readRecoveryNeeded(runtimeDirectory);
    const unclean = startup.previous?.state === 'unclean';
    const result = {
      version: 1,
      generatedAt: new Date(now()).toISOString(),
      sessionId: startup.sessionId,
      unclean,
      previous: startup.previous || { state: 'none' },
      recoveryNeeded,
      jobs,
      orphans: {
        items: sweep.reported.map(({ error: _error, ...item }) => item),
        deleted: sweep.deleted.length,
        deletedBytes: sweep.deleted.reduce((sum, item) => sum + item.bytes, 0),
        projectProblems: sweep.projectProblems,
        stagedImports: sweep.stagedImports,
      },
      databases: databaseSummary(runtimeDirectory, events),
      engines,
      events: events.map((event) => ({ ...event })),
    };
    const state = readJson(path.join(runtimeDirectory, STATE_FILE));
    const needsAttention =
      unclean ||
      !!recoveryNeeded ||
      jobs.items.some((job) => job.kind !== 'continuing') ||
      result.orphans.items.length > 0 ||
      result.databases.some((database) => database.state !== 'ok') ||
      events.some((event) => event.severity === 'error');
    result.fingerprint = fingerprint(result);
    result.dismissed = !!state && state.fingerprint === result.fingerprint;
    result.needsAttention = needsAttention && !result.dismissed;
    return result;
  }

  /** Records what the startup sweep and checks did, for the audit trail and the MCP tool. */
  async function writeSnapshot() {
    const stop = log.time('recovery.report.written');
    try {
      const current = await report();
      atomicWriteFileSync(
        path.join(runtimeDirectory, SNAPSHOT_FILE),
        `${JSON.stringify(current, null, 2)}\n`,
      );
      stop({
        jobCount: current.jobs.items.length,
        orphanCount: current.orphans.items.length,
        hasAttention: current.needsAttention,
      });
      return current;
    } catch (error) {
      log.warn('recovery.report.failed', errorLogFields(error));
      return null;
    }
  }

  function dismiss(fingerprintValue) {
    atomicWriteFileSync(
      path.join(runtimeDirectory, STATE_FILE),
      `${JSON.stringify({ fingerprint: fingerprintValue, dismissedAt: new Date(now()).toISOString() })}\n`,
    );
  }

  /**
   * Runs one user-confirmed action. Every action re-reads the evidence it depends on.
   * @returns {Promise<object>}
   */
  async function act(input) {
    const action = input?.action;
    if (action === 'dismiss') {
      const current = await report();
      dismiss(current.fingerprint);
      return { dismissed: true };
    }
    if (action === 'rescan') {
      return { report: await report({ rescan: true }) };
    }
    if (action === 'quarantine-orphans') {
      if (
        input.confirm !== 'quarantine-orphans' ||
        !Array.isArray(input.ids) ||
        !input.ids.length
      ) {
        throw Object.assign(Error('Confirm which files to move.'), { status: 400 });
      }
      const ids = input.ids.filter((id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id));
      return quarantineOrphans({ ids, runtimeDirectory, projectsRoot });
    }
    if (action === 'resolve-job' || action === 'retry-job') {
      const id = typeof input.jobId === 'string' ? input.jobId : '';
      if (!/^[a-f0-9-]{36}$/i.test(id)) {
        throw Object.assign(Error('Choose a job.'), { status: 400 });
      }
      const { items } = await jobSection();
      const job = items.find((item) => item.id === id);
      if (!job) {
        throw Object.assign(Error('That job no longer needs attention.'), { status: 404 });
      }
      if (action === 'resolve-job') {
        if (input.confirm !== 'engine-job-not-running' || job.status !== 'interrupted') {
          throw Object.assign(
            Error(
              'Only an interrupted job can be marked cancelled, after you confirm the engine is not rendering it.',
            ),
            { status: 400 },
          );
        }
        const result = await callRuntime(`/api/runtime/jobs/${id}/resolve`, {
          method: 'POST',
          body: { confirmRemoteNotRunning: true },
        });
        recordRecoveryEvent(
          {
            code: 'job.resolved',
            kind: 'job',
            id,
            detail: 'Marked cancelled from the Recovery report.',
          },
          { directory: runtimeDirectory },
        );
        return { job: result?.job ?? null };
      }
      if (!job.safeToRetry) {
        throw Object.assign(
          Error(
            'Retrying this job could repeat work the engine already accepted, so it is not offered.',
          ),
          { status: 409 },
        );
      }
      const result = await callRuntime(`/api/runtime/jobs/${id}/retry`, {
        method: 'POST',
        body: {},
      });
      recordRecoveryEvent(
        { code: 'job.retried', kind: 'job', id, detail: 'Queued again from the Recovery report.' },
        { directory: runtimeDirectory },
      );
      return { job: result?.job ?? null };
    }
    throw Object.assign(Error('Unknown recovery action.'), { status: 400 });
  }

  return { report, act, runStartupSweep, writeSnapshot };
}
