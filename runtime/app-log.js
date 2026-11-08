// Forge structured application log: the Node writer used by every Node process (studio host,
// runtime worker, forked job processes, MCP bridge). See docs/LOGGING.md for the design and
// docs/LOGGING_CONVERSION_GUIDE.md for how to instrument a file.
//
//   import { createLogger } from './app-log.js';
//   const log = createLogger('queue');
//   log.info('job.state.changed', { jobId, from: 'queued', to: 'running' });
//
// Guarantees:
// - A call never throws into the caller and never waits for disk. Records are validated, redacted
//   and buffered in memory; a timer appends them to this process's own spool file
//   (.forge-runtime/log-spool/<process>-<pid>-<thread>-<start>-<n>.jsonl) every 250 ms. The studio
//   host ingests spool files into .forge-runtime/logs.sqlite. No process but the host opens the
//   database for writing, so loggers never meet SQLite locks.
// - A call below the active level returns after one comparison.
// - Field names are checked against an allow-list (runtime/log-fields.js); free text, paths and
//   secrets cannot be logged by accident. Rejected fields are dropped and counted on the record.
// - Hot loops are collapsed (count + first/last time) and a token bucket caps the rate; anything
//   dropped is reported by a `log.records.dropped` record.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  buildRecord,
  isEventId,
  isLogComponent,
  parseLevelSpec,
  redactLogText,
  sanitizeFields,
  sanitizeMessage,
} from './log-fields.js';
import { installSharedLogSink } from './shared-log.js';

export {
  LOG_COMPONENTS,
  LOG_LEVEL_NAMES,
  LOG_LEVELS,
  isEventId,
  isLogComponent,
  routeTemplate,
} from './log-fields.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** HTTP header that carries a trace id between the browser, the host and engines. */
export const TRACE_HEADER = 'x-forge-trace';
/** Environment variable that carries a trace id into a forked or spawned process. */
export const TRACE_ENV = 'FORGE_TRACE_ID';
/** Environment variable with a level specification, e.g. `info` or `warn,queue=debug`. */
export const LEVEL_ENV = 'FORGE_LOG_LEVEL';

export const SPOOL_FLUSH_MS = 250;
export const SPOOL_FLUSH_ROWS = 50;
export const SPOOL_ROLL_BYTES = 4 * 1024 * 1024;
export const SPOOL_PROCESS_CAP_BYTES = 32 * 1024 * 1024;
export const BUFFER_CAP_ROWS = 5000;
export const RATE_BURST_ROWS = 1000;
export const RATE_ROWS_PER_SECOND = 200;
export const DEDUPE_WINDOW_MS = 10_000;
export const DEDUPE_BURST_ROWS = 20;
const DEDUPE_KEYS_CAP = 2000;
const LEVEL_REFRESH_MS = 5000;
const MEMORY_CAP_ROWS = 5000;
const TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const traceStorage = new AsyncLocalStorage();

function defaultRuntimeDirectory() {
  return process.env.FORGE_RUNTIME_DIR || path.join(repositoryRoot, '.forge-runtime');
}

function defaultProcessName() {
  if (process.env.FORGE_LOG_PROCESS) {
    return process.env.FORGE_LOG_PROCESS;
  }
  const script = path.basename(process.argv[1] || 'node').replace(/\.[cm]?js$/i, '');
  return threadId ? `${script}-thread` : script;
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'node'
  );
}

// Tests run under `node --test` without a runtime folder of their own must not write into the
// real .forge-runtime, so they keep records in memory (readMemoryLogRecords) instead.
function defaultSinkMode() {
  const explicit = process.env.FORGE_LOG_SINK;
  if (explicit === 'off' || explicit === 'memory' || explicit === 'spool') {
    return explicit;
  }
  const isTestRun = Boolean(process.env.NODE_TEST_CONTEXT);
  const hasOwnDirectory = Boolean(process.env.FORGE_RUNTIME_DIR || process.env.FORGE_LOG_DIR);
  return isTestRun && !hasOwnDirectory ? 'memory' : 'spool';
}

function localRoots(runtimeDirectory) {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // Some service accounts have no user record; home-folder redaction still applies.
  }
  return {
    repo: repositoryRoot,
    projects: process.env.FORGE_PROJECTS_DIR || path.join(repositoryRoot, 'projects'),
    runtime: runtimeDirectory,
    home: os.homedir(),
    user,
  };
}

// Reads the persisted `logs.level` and `logs.componentLevels` settings straight from
// settings.sqlite (registered in runtime/core-settings.js). It is read directly rather than through
// the settings registry so that importing the logger never pulls the registry (and its imports)
// into every module, which would create import cycles once those modules log too.
function readSettingsLevelSpec(runtimeDirectory) {
  const file = path.join(runtimeDirectory, 'settings.sqlite');
  if (!fs.existsSync(file)) {
    return '';
  }
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true, timeout: 50 });
  try {
    const rows = db
      .prepare(
        "SELECT key,value_json FROM settings_overrides WHERE key IN ('logs.level','logs.componentLevels')",
      )
      .all();
    const values = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value_json)]));
    return [values['logs.level'], values['logs.componentLevels']]
      .filter((value) => typeof value === 'string' && value)
      .join(',');
  } catch (error) {
    if (/no such table/i.test(String(error?.message))) {
      return '';
    }
    throw error;
  } finally {
    db.close();
  }
}

function freshState() {
  return {
    processName: null,
    runtimeDirectory: null,
    spoolDirectory: null,
    mode: null,
    redact: null,
    startMs: Date.now(),
    seq: 0,
    buffer: [],
    memory: [],
    interval: null,
    immediate: null,
    inflight: false,
    fileIndex: 0,
    fileName: null,
    fileBytes: 0,
    spoolBlockedUntil: 0,
    tokens: RATE_BURST_ROWS,
    tokensAt: Date.now(),
    dedupe: new Map(),
    dropped: { rate: 0, buffer: 0, spool: 0, write: 0 },
    droppedFieldsTotal: 0,
    internalErrors: 0,
    written: 0,
    hooksInstalled: false,
    unknownComponents: new Set(),
    levelEpoch: 0,
    nextLevelRefresh: 0,
    defaultThreshold: LOG_LEVELS[DEFAULT_LOG_LEVEL],
    componentThresholds: {},
    levelProvider: null,
    processTraceId: TRACE_ID_PATTERN.test(process.env[TRACE_ENV] || '')
      ? process.env[TRACE_ENV]
      : null,
    processJobId: /^[A-Za-z0-9._:-]{1,128}$/.test(process.env.FORGE_LOG_JOB_ID || '')
      ? process.env.FORGE_LOG_JOB_ID
      : null,
  };
}

let state = freshState();

function ensureConfigured() {
  if (state.mode) {
    return;
  }
  state.runtimeDirectory ||= defaultRuntimeDirectory();
  state.spoolDirectory ||=
    process.env.FORGE_LOG_DIR || path.join(state.runtimeDirectory, 'log-spool');
  state.processName ||= defaultProcessName();
  state.mode = defaultSinkMode();
  const roots = localRoots(state.runtimeDirectory);
  state.redact ||= (text) => redactLogText(text, roots);
}

function refreshLevels(now) {
  state.nextLevelRefresh = now + LEVEL_REFRESH_MS;
  let spec = process.env[LEVEL_ENV] || '';
  if (!spec) {
    try {
      ensureConfigured();
      if (state.levelProvider) {
        spec = String(state.levelProvider() || '');
      } else if (state.mode === 'spool') {
        spec = readSettingsLevelSpec(state.runtimeDirectory);
      }
    } catch {
      // A locked or damaged settings file keeps the default level; logging must not fail on it.
      state.internalErrors += 1;
      spec = '';
    }
  }
  const parsed = parseLevelSpec(spec);
  const thresholds = {};
  for (const [component, level] of Object.entries(parsed.components)) {
    thresholds[component] = LOG_LEVELS[level];
  }
  state.defaultThreshold = LOG_LEVELS[parsed.level];
  state.componentThresholds = thresholds;
  state.levelEpoch += 1;
}

function takeToken(now) {
  const elapsedMs = now - state.tokensAt;
  if (elapsedMs > 0) {
    state.tokens = Math.min(
      RATE_BURST_ROWS,
      state.tokens + (elapsedMs * RATE_ROWS_PER_SECOND) / 1000,
    );
    state.tokensAt = now;
  }
  if (state.tokens < 1) {
    return false;
  }
  state.tokens -= 1;
  return true;
}

function summaryOf(entry) {
  return {
    ...entry.last,
    seq: ++state.seq,
    count: entry.suppressed,
    firstTs: entry.firstTs,
    fields: { ...entry.last.fields, collapsed: true },
  };
}

// Lets the first DEDUPE_BURST_ROWS identical records of a window through, then counts the rest
// and writes one summary record (count, first and last time) when the window ends.
function passesDedupe(record) {
  const key = `${record.level}\u0001${record.component}\u0001${record.event}\u0001${
    record.jobId ?? ''
  }\u0001${record.message}`;
  let entry = state.dedupe.get(key);
  if (!entry || record.ts - entry.windowStart >= DEDUPE_WINDOW_MS) {
    if (entry?.suppressed) {
      state.buffer.push(summaryOf(entry));
    }
    if (!entry && state.dedupe.size >= DEDUPE_KEYS_CAP) {
      return true;
    }
    entry = { windowStart: record.ts, passed: 0, suppressed: 0, firstTs: 0, last: null };
    state.dedupe.set(key, entry);
  }
  if (entry.passed < DEDUPE_BURST_ROWS) {
    entry.passed += 1;
    return true;
  }
  entry.suppressed += 1;
  entry.firstTs ||= record.ts;
  entry.last = record;
  return false;
}

function sweepDedupe(now, force = false) {
  for (const [key, entry] of state.dedupe) {
    if (force || now - entry.windowStart >= DEDUPE_WINDOW_MS) {
      if (entry.suppressed) {
        state.buffer.push(summaryOf(entry));
      }
      state.dedupe.delete(key);
    }
  }
}

function pushDropRecords(now) {
  for (const reason of Object.keys(state.dropped)) {
    const droppedCount = state.dropped[reason];
    if (!droppedCount) {
      continue;
    }
    state.dropped[reason] = 0;
    state.buffer.push(
      buildRecord({
        ts: now,
        level: 'warn',
        component: 'log',
        event: 'log.records.dropped',
        message: 'Log records were dropped.',
        fields: { droppedCount, reason },
        process: state.processName,
        pid: process.pid,
        seq: ++state.seq,
      }),
    );
  }
}

function spoolPrefix() {
  return `${slug(state.processName)}-${process.pid}-${threadId}-${state.startMs}-`;
}

function ownSpoolBytes() {
  const prefix = spoolPrefix();
  let total = 0;
  for (const name of fs.readdirSync(state.spoolDirectory)) {
    if (name.startsWith(prefix)) {
      try {
        total += fs.statSync(path.join(state.spoolDirectory, name)).size;
      } catch {
        // Ingested and removed by the host between readdir and stat.
      }
    }
  }
  return total;
}

// Returns the spool file for `bytes` more bytes, rolling to a new file when the current one is
// full. Returns null when this process's unconsumed spool exceeds its cap (the host is not
// ingesting); the caller counts the records as dropped.
function spoolFileFor(bytes, now) {
  if (now < state.spoolBlockedUntil) {
    return null;
  }
  if (!state.fileName || state.fileBytes + bytes > SPOOL_ROLL_BYTES) {
    fs.mkdirSync(state.spoolDirectory, { recursive: true });
    if (ownSpoolBytes() > SPOOL_PROCESS_CAP_BYTES) {
      state.spoolBlockedUntil = now + 10_000;
      state.fileName = null;
      return null;
    }
    state.fileIndex += 1;
    state.fileName = path.join(state.spoolDirectory, `${spoolPrefix()}${state.fileIndex}.jsonl`);
    state.fileBytes = 0;
  }
  return state.fileName;
}

function serialize(batch) {
  let text = '';
  for (const record of batch) {
    text += `${JSON.stringify(record)}\n`;
  }
  return text;
}

function rememberInMemory(batch) {
  state.memory.push(...batch);
  if (state.memory.length > MEMORY_CAP_ROWS) {
    state.memory.splice(0, state.memory.length - MEMORY_CAP_ROWS);
  }
}

function prepareBatch(now, force) {
  sweepDedupe(now, force);
  pushDropRecords(now);
  return state.buffer.splice(0, state.buffer.length);
}

function flushAsync() {
  state.immediate = null;
  if (state.inflight) {
    return;
  }
  try {
    const now = Date.now();
    if (!state.buffer.length && !state.dedupe.size) {
      return;
    }
    const batch = prepareBatch(now, false);
    if (!batch.length) {
      return;
    }
    if (state.mode === 'memory') {
      rememberInMemory(batch);
      return;
    }
    const text = serialize(batch);
    const bytes = Buffer.byteLength(text);
    const file = spoolFileFor(bytes, now);
    if (!file) {
      state.dropped.spool += batch.length;
      return;
    }
    state.fileBytes += bytes;
    state.inflight = true;
    fs.appendFile(file, text, (error) => {
      state.inflight = false;
      if (error) {
        state.dropped.write += batch.length;
        state.fileName = null;
        return;
      }
      state.written += batch.length;
      if (state.buffer.length >= SPOOL_FLUSH_ROWS) {
        scheduleSoon();
      }
    });
  } catch {
    state.internalErrors += 1;
    state.inflight = false;
    state.fileName = null;
  }
}

/**
 * Writes everything buffered synchronously. Called automatically on process exit and on an
 * uncaught exception; call it yourself only right before a deliberate `process.exit()`.
 */
export function flushAppLogSync() {
  try {
    if (!state.mode || state.mode === 'off') {
      return;
    }
    const now = Date.now();
    const batch = prepareBatch(now, true);
    if (!batch.length) {
      return;
    }
    if (state.mode === 'memory') {
      rememberInMemory(batch);
      return;
    }
    const text = serialize(batch);
    const bytes = Buffer.byteLength(text);
    const file = spoolFileFor(bytes, now);
    if (!file) {
      return;
    }
    fs.appendFileSync(file, text);
    state.fileBytes += bytes;
    state.written += batch.length;
  } catch {
    state.internalErrors += 1;
  }
}

/** Resolves once everything buffered so far has been handed to the spool file (or memory). */
export async function flushAppLog() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!state.inflight) {
      flushAsync();
    }
    if (!state.inflight && !state.buffer.length) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function scheduleSoon() {
  if (!state.immediate) {
    state.immediate = setImmediate(flushAsync);
    state.immediate.unref?.();
  }
}

function installHooks() {
  if (state.hooksInstalled) {
    return;
  }
  state.hooksInstalled = true;
  state.interval = setInterval(flushAsync, SPOOL_FLUSH_MS);
  state.interval.unref();
  process.on('exit', flushAppLogSync);
  // The monitor observes a crash without changing how the process handles it.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    emit('runtime', 'error', 'process.exception.uncaught', {
      error,
      reason: origin === 'unhandledRejection' ? 'unhandledRejection' : 'uncaughtException',
    });
    flushAppLogSync();
  });
}

function emit(component, level, event, fields, message, context = null) {
  try {
    ensureConfigured();
    if (state.mode === 'off') {
      return;
    }
    const now = Date.now();
    const isValidEvent = isEventId(event);
    const { fields: clean, dropped } = sanitizeFields(fields, state.redact);
    if (!isValidEvent) {
      clean.invalidEvent = true;
    }
    state.droppedFieldsTotal += dropped.length;
    const merged = context ? { ...context, ...clean } : clean;
    const record = buildRecord({
      ts: now,
      level,
      component,
      event: isValidEvent ? event : 'log.event.invalid',
      message: sanitizeMessage(message, state.redact),
      fields: merged,
      dropped,
      process: state.processName,
      pid: process.pid,
      seq: 0,
      traceId: traceStorage.getStore()?.traceId ?? state.processTraceId,
      jobId: state.processJobId,
    });
    if (!passesDedupe(record)) {
      return;
    }
    if (!takeToken(now)) {
      state.dropped.rate += 1;
      return;
    }
    if (state.buffer.length >= BUFFER_CAP_ROWS) {
      state.dropped.buffer += 1;
      return;
    }
    record.seq = ++state.seq;
    state.buffer.push(record);
    installHooks();
    if (state.buffer.length >= SPOOL_FLUSH_ROWS) {
      scheduleSoon();
    }
  } catch {
    state.internalErrors += 1;
  }
}

/**
 * Adds records that were validated elsewhere (the host's /api/logs/ingest route uses this for
 * browser batches). Each record must come from runtime/log-fields.js buildRecord().
 */
export function appendValidatedRecords(records) {
  try {
    ensureConfigured();
    if (state.mode === 'off') {
      return 0;
    }
    let accepted = 0;
    for (const record of records) {
      if (!passesDedupe(record)) {
        continue;
      }
      if (!takeToken(record.ts) || state.buffer.length >= BUFFER_CAP_ROWS) {
        state.dropped.rate += 1;
        continue;
      }
      state.buffer.push({ ...record, seq: ++state.seq });
      accepted += 1;
    }
    installHooks();
    scheduleSoon();
    return accepted;
  } catch {
    state.internalErrors += 1;
    return 0;
  }
}

function sanitizeContext(context) {
  ensureConfigured();
  const { fields } = sanitizeFields(context, state.redact);
  return Object.keys(fields).length ? fields : null;
}

function componentFor(eventId) {
  const area = typeof eventId === 'string' ? eventId.split('.')[0] : '';
  return isLogComponent(area) ? area : 'runtime';
}

/**
 * Creates a logger for one component.
 *
 * @param {string} component a name from LOG_COMPONENTS, e.g. 'queue'. An unknown name logs as
 *   'unknown' (and one `log.component.unknown` warning) instead of throwing.
 * @param {object} [context] fields added to every record, e.g. `{ jobId }` (same allow-list)
 * @returns {{
 *   component: string,
 *   trace: (event: string, fields?: object, message?: string) => void,
 *   debug: (event: string, fields?: object, message?: string) => void,
 *   info: (event: string, fields?: object, message?: string) => void,
 *   warn: (event: string, fields?: object, message?: string) => void,
 *   error: (event: string, fields?: object, message?: string) => void,
 *   isEnabled: (level: string) => boolean,
 *   time: (event: string, fields?: object) => (extra?: object) => number,
 *   child: (context: object) => object,
 * }}
 */
export function createLogger(component, context = undefined) {
  let name = component;
  if (!isLogComponent(component)) {
    name = 'unknown';
    const label = typeof component === 'string' ? component.slice(0, 40) : typeof component;
    if (!state.unknownComponents.has(label)) {
      state.unknownComponents.add(label);
      emit('log', 'warn', 'log.component.unknown', {}, 'A logger used an unregistered component.');
    }
  }
  let contextFields = null;
  try {
    contextFields = context ? sanitizeContext(context) : null;
  } catch {
    state.internalErrors += 1;
  }
  let epoch = -1;
  let threshold = LOG_LEVELS[DEFAULT_LOG_LEVEL];

  function currentThreshold() {
    const now = Date.now();
    if (now >= state.nextLevelRefresh) {
      refreshLevels(now);
    }
    if (epoch !== state.levelEpoch) {
      epoch = state.levelEpoch;
      threshold = state.componentThresholds[name] ?? state.defaultThreshold;
    }
    return threshold;
  }

  const logger = {
    component: name,
    trace(event, fields, message) {
      if (LOG_LEVELS.trace >= currentThreshold()) {
        emit(name, 'trace', event, fields, message, contextFields);
      }
    },
    debug(event, fields, message) {
      if (LOG_LEVELS.debug >= currentThreshold()) {
        emit(name, 'debug', event, fields, message, contextFields);
      }
    },
    info(event, fields, message) {
      if (LOG_LEVELS.info >= currentThreshold()) {
        emit(name, 'info', event, fields, message, contextFields);
      }
    },
    warn(event, fields, message) {
      if (LOG_LEVELS.warn >= currentThreshold()) {
        emit(name, 'warn', event, fields, message, contextFields);
      }
    },
    error(event, fields, message) {
      if (LOG_LEVELS.error >= currentThreshold()) {
        emit(name, 'error', event, fields, message, contextFields);
      }
    },
    isEnabled(level) {
      try {
        return (LOG_LEVELS[level] ?? Infinity) >= currentThreshold();
      } catch {
        return false;
      }
    },
    /**
     * Starts a timer. The returned function logs `event` with `durationMs` at info (or at error
     * when `extra.error` is set) and returns the duration in milliseconds.
     */
    time(event, fields) {
      const started = performance.now();
      return (extra) => {
        const durationMs = Math.round(performance.now() - started);
        try {
          const isFailure = Boolean(extra && extra.error !== undefined && extra.error !== null);
          const merged = { ...fields, ...extra, durationMs };
          if (isFailure) {
            logger.error(event, merged);
          } else {
            logger.info(event, merged);
          }
        } catch {
          state.internalErrors += 1;
        }
        return durationMs;
      };
    },
    /** A logger for the same component with extra context fields, e.g. `log.child({ jobId })`. */
    child(extraContext) {
      return createLogger(name, { ...contextFields, ...extraContext });
    },
  };
  return logger;
}

/**
 * Wraps an async function so each call logs `<name>.started` (debug), `<name>.completed` (info,
 * with durationMs) or `<name>.failed` (error, with the error class and durationMs). The original
 * result is returned and the original error is rethrown unchanged.
 *
 * @param {Function} fn function to wrap
 * @param {string} name event prefix such as 'image.render' (2 to 5 segments)
 * @param {{ logger?: object, fields?: object }} [options] logger (default: component from the
 *   first segment of `name`, else 'runtime') and fields added to every record
 */
export function withLogging(fn, name, { logger, fields } = {}) {
  if (typeof fn !== 'function') {
    return fn;
  }
  const prefix = isEventId(name) && name.split('.').length <= 5 ? name : 'runtime.call';
  const target = logger ?? createLogger(componentFor(prefix));
  return async function loggedCall(...args) {
    const started = performance.now();
    target.debug(`${prefix}.started`, fields);
    try {
      const result = await fn.apply(this, args);
      target.info(`${prefix}.completed`, {
        ...fields,
        durationMs: Math.round(performance.now() - started),
      });
      return result;
    } catch (error) {
      target.error(`${prefix}.failed`, {
        ...fields,
        error,
        durationMs: Math.round(performance.now() - started),
      });
      throw error;
    }
  };
}

/** A new random trace id (16 hex characters). */
export function newTraceId() {
  return randomBytes(8).toString('hex');
}

export function isTraceId(value) {
  return typeof value === 'string' && TRACE_ID_PATTERN.test(value);
}

/**
 * Runs `fn` with a trace id attached to every record logged inside it (across awaits). An invalid
 * or missing id is replaced by a new one.
 */
export function runWithTrace(traceId, fn) {
  const id = isTraceId(traceId) ? traceId : newTraceId();
  return traceStorage.run({ traceId: id }, fn);
}

/** The trace id of the current async context, the process (FORGE_TRACE_ID), or null. */
export function currentTraceId() {
  return traceStorage.getStore()?.traceId ?? state.processTraceId ?? null;
}

/** `{ 'x-forge-trace': id }` for an outgoing HTTP request, or {} without a trace. */
export function traceHeaders(traceId = currentTraceId()) {
  return isTraceId(traceId) ? { [TRACE_HEADER]: traceId } : {};
}

/** `{ FORGE_TRACE_ID: id }` to merge into a child process environment, or {}. */
export function traceEnv(traceId = currentTraceId()) {
  return isTraceId(traceId) ? { [TRACE_ENV]: traceId } : {};
}

/** Reads and validates the trace header of an incoming request; null when absent or invalid. */
export function traceIdFromHeaders(headers) {
  const value = headers?.[TRACE_HEADER];
  return isTraceId(value) ? value : null;
}

/**
 * Optional process configuration. Call once at process start, before the first record, e.g.
 * `configureAppLog({ processName: 'host' })`. Every option is optional.
 *
 * @param {object} options
 * @param {string} [options.processName] label stored with each record (default: script name)
 * @param {'spool'|'memory'|'off'} [options.sink] where records go (default: spool, memory in tests)
 * @param {string} [options.runtimeDirectory] runtime folder (default FORGE_RUNTIME_DIR)
 * @param {string} [options.spoolDirectory] spool folder (default <runtime>/log-spool)
 * @param {() => string} [options.levelProvider] returns a level specification; the settings
 *   registry may install one. FORGE_LOG_LEVEL still wins.
 */
export function configureAppLog({
  processName,
  sink,
  runtimeDirectory,
  spoolDirectory,
  levelProvider,
} = {}) {
  try {
    if (typeof processName === 'string' && processName) {
      state.processName = processName.slice(0, 40);
      state.fileName = null;
    }
    if (typeof runtimeDirectory === 'string' && runtimeDirectory) {
      state.runtimeDirectory = runtimeDirectory;
      state.spoolDirectory = spoolDirectory || path.join(runtimeDirectory, 'log-spool');
      state.redact = null;
      state.mode = null;
      state.fileName = null;
    }
    if (typeof spoolDirectory === 'string' && spoolDirectory) {
      state.spoolDirectory = spoolDirectory;
      state.fileName = null;
    }
    if (typeof levelProvider === 'function') {
      state.levelProvider = levelProvider;
    }
    state.nextLevelRefresh = 0;
    ensureConfigured();
    if (sink === 'spool' || sink === 'memory' || sink === 'off') {
      state.mode = sink;
    }
  } catch {
    state.internalErrors += 1;
  }
}

/** Counters for diagnostics and tests. */
export function getAppLogStats() {
  return {
    mode: state.mode,
    processName: state.processName,
    buffered: state.buffer.length,
    written: state.written,
    pendingDropped: { ...state.dropped },
    droppedFieldsTotal: state.droppedFieldsTotal,
    internalErrors: state.internalErrors,
  };
}

/** Records kept by the 'memory' sink (the default under `node --test`). Newest last. */
export function readMemoryLogRecords() {
  flushAppLogSync();
  return state.memory.slice();
}

/** Clears the memory sink. For tests. */
export function clearMemoryLogRecords() {
  state.memory.length = 0;
}

/** Restores the initial state (keeps exit hooks installed). For tests only. */
export function resetAppLogForTests() {
  const hooksInstalled = state.hooksInstalled;
  const interval = state.interval;
  state = freshState();
  state.hooksInstalled = hooksInstalled;
  state.interval = interval;
}

// Modules shared with the browser log through runtime/shared-log.js; in Node they reach this
// logger. Loggers are cached per component so a shared call costs the same as a direct one.
const sharedLoggers = new Map();

function sharedLoggerFor(component, context) {
  if (context) {
    return createLogger(component, context);
  }
  if (!sharedLoggers.has(component)) {
    sharedLoggers.set(component, createLogger(component));
  }
  return sharedLoggers.get(component);
}

installSharedLogSink({
  log(component, level, event, fields, message, context) {
    sharedLoggerFor(component, context)[level]?.(event, fields, message);
  },
  isEnabled: (component, level) => sharedLoggerFor(component).isEnabled(level),
});
