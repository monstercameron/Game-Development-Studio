// Structured application log service: /api/logs on the studio host. It owns
// .forge-runtime/logs.sqlite: it ingests the spool files every Forge process writes
// (runtime/log-ingest.js), applies retention, accepts browser batches and serves the review UI and
// the MCP tools. See docs/LOGGING.md.
//
//   POST   /api/logs/ingest   browser batches: { records: [...], droppedCount? }
//   GET    /api/logs          newest first; level, component, event, text, since, until, jobId,
//                             traceId, process, limit, cursor
//   GET    /api/logs/summary  counts by level/component, top events, drop counters, sizes
//   GET    /api/logs/tail     rows after a cursor (polling), same filters
//   GET    /api/logs/export   ?format=jsonl, same filters, redacted, at most 50,000 rows
//   DELETE /api/logs          { olderThanDays, confirm: true }
//
// Every route needs a loopback Host and, when an Origin is sent, the studio's own Origin. Reads
// and deletes need `X-Forge-Request: logs`; ingest needs `X-Forge-Request: app-log`. Bodies are
// size limited and ingest is rate limited.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendValidatedRecords,
  configureAppLog,
  createLogger,
  flushAppLogSync,
  getAppLogStats,
  newTraceId,
  runWithTrace,
  traceIdFromHeaders,
  TRACE_HEADER,
} from './app-log.js';
import { createLogIngester, INGEST_INTERVAL_MS } from './log-ingest.js';
import {
  LOG_LEVEL_NAMES,
  buildRecord,
  isEventId,
  isLogComponent,
  redactLogText,
  routeTemplate,
  sanitizeFields,
  sanitizeMessage,
} from './log-fields.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  LogQueryError,
  MAX_EXPORT_ROWS,
  createLogStore,
} from './log-store.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const MAX_INGEST_BYTES = 128 * 1024;
const MAX_INGEST_RECORDS = 100;
const MAX_DELETE_BYTES = 1024;
const RECORD_KEYS = new Set([
  'ts',
  'level',
  'component',
  'event',
  'message',
  'fields',
  'process',
  'pid',
  'seq',
  'traceId',
  'jobId',
  'durationMs',
  'count',
  'firstTs',
]);
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RETENTION_DELAY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const log = createLogger('log');

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    // log-coverage: ignore -- error object field, not a state change
    this.status = status;
  }
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new RequestError(413, 'Request is too large.');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!size) {
    return {};
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error('not an object');
    }
    return value;
  } catch {
    throw new RequestError(400, 'Invalid request.');
  }
}

function createRateLimiter({ limit, windowMs, now }) {
  const times = [];
  return () => {
    const current = now();
    while (times.length && current - times[0] > windowMs) {
      times.shift();
    }
    if (times.length >= limit) {
      return false;
    }
    times.push(current);
    return true;
  };
}

function defaultRoots(runtimeDir) {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // log-coverage: ignore -- some service accounts have no user record; home-folder
    // redaction still applies.
  }
  return {
    repo: repositoryRoot,
    projects: process.env.FORGE_PROJECTS_DIR || path.join(repositoryRoot, 'projects'),
    runtime: runtimeDir,
    home: os.homedir(),
    user,
  };
}

function parseTime(value, name) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const number = /^\d{1,15}$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(number)) {
    throw new RequestError(400, `${name} must be milliseconds since 1970 or an ISO date.`);
  }
  return number;
}

/**
 * Parses the shared filters from URL search parameters (used by the routes) or a plain object
 * (used by the MCP tools). Throws a RequestError with a 400 status for invalid input.
 */
export function parseLogFilters(input) {
  const get = (key) => (input instanceof URLSearchParams ? input.get(key) : input?.[key]);
  const getAll = (key) => {
    if (input instanceof URLSearchParams) {
      return input.getAll(key).flatMap((value) => value.split(','));
    }
    const value = input?.[key];
    if (Array.isArray(value)) {
      return value;
    }
    return typeof value === 'string' ? value.split(',') : [];
  };
  const level = get('level') || undefined;
  if (level !== undefined && !LOG_LEVEL_NAMES.includes(level)) {
    throw new RequestError(400, 'level must be trace, debug, info, warn or error.');
  }
  const components = getAll('component')
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, 20);
  for (const component of components) {
    if (!isLogComponent(component)) {
      throw new RequestError(400, 'component must be a registered component name.');
    }
  }
  const text = get('text');
  if (text !== undefined && text !== null && String(text).length > 200) {
    throw new RequestError(400, 'text must be at most 200 characters.');
  }
  return {
    level,
    components,
    eventPrefix: get('event') || undefined,
    text: text ? String(text) : undefined,
    since: parseTime(get('since'), 'since'),
    until: parseTime(get('until'), 'until'),
    jobId: get('jobId') || undefined,
    traceId: get('traceId') || undefined,
    process: get('process') || undefined,
  };
}

function parseLimit(value, fallback, maximum) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new RequestError(400, `limit must be a whole number from 1 to ${maximum}.`);
  }
  return number;
}

/**
 * Validates one browser record and rebuilds it with the shared rules. Unknown keys, an invalid
 * event or component, or a wrong type reject the record (it is counted, not stored).
 */
export function parseBrowserRecord(input, { now, redact }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  for (const key of Object.keys(input)) {
    if (!RECORD_KEYS.has(key)) {
      return null;
    }
  }
  if (!LOG_LEVEL_NAMES.includes(input.level) || !isLogComponent(input.component)) {
    return null;
  }
  if (!isEventId(input.event)) {
    return null;
  }
  const rawFields = input.fields && typeof input.fields === 'object' ? { ...input.fields } : {};
  for (const key of ['jobId', 'traceId', 'durationMs']) {
    if (input[key] !== undefined && input[key] !== null) {
      rawFields[key] = input[key];
    }
  }
  // Names the browser already dropped are not re-validated as fields.
  delete rawFields.droppedFieldNames;
  const { fields, dropped } = sanitizeFields(rawFields, redact);
  const current = now();
  const ts =
    Number.isFinite(input.ts) && Math.abs(input.ts - current) < DAY_MS ? input.ts : current;
  const record = buildRecord({
    ts,
    level: input.level,
    component: input.component,
    event: input.event,
    message: sanitizeMessage(input.message, redact),
    fields,
    dropped,
    process: 'browser',
    pid: 0,
  });
  if (Number.isInteger(input.count) && input.count > 1 && input.count < 1_000_000) {
    record.count = input.count;
  }
  return record;
}

function redactRow(row, redact) {
  const fields = {};
  for (const [key, value] of Object.entries(row.fields ?? {})) {
    fields[key] = typeof value === 'string' ? redact(value) : value;
  }
  return { ...row, message: redact(row.message), fields };
}

function readRetentionSettings(getSetting) {
  const read = (key, fallback, minimum, maximum) => {
    try {
      const value = getSetting?.(key);
      return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
    } catch (error) {
      log.debug('log.settings.read.failed', { error, settingKey: key });
      return fallback;
    }
  };
  const envDays = Number(process.env.FORGE_LOG_RETENTION_DAYS);
  const envMiB = Number(process.env.FORGE_LOG_MAX_MIB);
  const days =
    Number.isFinite(envDays) && envDays >= 1
      ? envDays
      : read('logs.retentionDays', DEFAULT_RETENTION_DAYS, 1, 365);
  const mib =
    Number.isFinite(envMiB) && envMiB >= 16
      ? envMiB
      : read('logs.maxSizeMiB', DEFAULT_MAX_BYTES / 1048576, 16, 4096);
  return { maxAgeDays: days, maxBytes: mib * 1024 * 1024 };
}

/**
 * @param {object} [options] overrides for tests
 * @param {string} [options.runtimeDir] folder holding logs.sqlite and log-spool/
 * @param {number} [options.ingestIntervalMs] 0 disables the ingest timer
 * @param {number} [options.retentionIntervalMs] 0 disables the retention timer
 * @param {(key: string) => unknown} [options.getSetting] settings accessor (core-settings getSetting)
 * @param {(pid: number) => boolean} [options.isAlive]
 */
export function logsService({
  runtimeDir = process.env.FORGE_RUNTIME_DIR || path.join(repositoryRoot, '.forge-runtime'),
  ingestIntervalMs = INGEST_INTERVAL_MS,
  retentionIntervalMs = RETENTION_INTERVAL_MS,
  getSetting,
  isAlive,
  ingestLimitPer10s = 60,
  now = () => Date.now(),
  roots,
} = {}) {
  const spoolDirectory = process.env.FORGE_LOG_DIR || path.join(runtimeDir, 'log-spool');
  const localRoots = roots || defaultRoots(runtimeDir);
  const redact = (text) => redactLogText(text, localRoots);
  const allowIngest = createRateLimiter({ limit: ingestLimitPer10s, windowMs: 10_000, now });
  let store = null;
  let ingester = null;
  let settingsAccessor = getSetting ?? null;
  let lastRetention = null;
  const timers = [];

  function getStore() {
    if (!store) {
      store = createLogStore({ directory: runtimeDir, now });
      ingester = createLogIngester({ store, spoolDirectory, ...(isAlive ? { isAlive } : {}) });
    }
    return store;
  }

  /** Moves pending spool lines (including this host's own buffer) into the database. */
  function ingestNow() {
    flushAppLogSync();
    getStore();
    return ingester.drain(10);
  }

  async function loadSettingsAccessor() {
    if (settingsAccessor) {
      return;
    }
    try {
      const module = await import('./core-settings.js');
      settingsAccessor = module.getSetting;
    } catch (error) {
      log.debug('log.settings.unavailable', { error });
    }
  }

  function runRetention() {
    try {
      ingestNow();
      const limits = readRetentionSettings(settingsAccessor);
      const result = getStore().prune(limits);
      lastRetention = { at: now(), ...result };
      if (result.deletedByAge || result.deletedBySize) {
        log.info('log.retention.completed', {
          deletedCount: result.deletedByAge + result.deletedBySize,
          deletedByAgeCount: result.deletedByAge,
          deletedBySizeCount: result.deletedBySize,
          usedBytes: result.usedBytes,
          wasVacuumed: result.isVacuumed,
        });
      }
      return lastRetention;
    } catch (error) {
      log.warn('log.retention.failed', { error });
      return null;
    }
  }

  function summary(filters) {
    ingestNow();
    const limits = readRetentionSettings(settingsAccessor);
    return {
      ...getStore().summary(filters),
      ingest: { ...ingester.stats },
      retention: {
        maxAgeDays: limits.maxAgeDays,
        maxBytes: limits.maxBytes,
        last: lastRetention,
      },
      hostLogger: getAppLogStats(),
    };
  }

  function query(filters, { limit, cursor } = {}) {
    ingestNow();
    const result = getStore().query(filters, { limit, cursor });
    return { ...result, rows: result.rows.map((row) => redactRow(row, redact)) };
  }

  function tail(filters, { afterId, limit } = {}) {
    ingestNow();
    const result = getStore().tail(filters, { afterId, limit });
    return { ...result, rows: result.rows.map((row) => redactRow(row, redact)) };
  }

  function requireHeader(req, value) {
    if (req.headers['x-forge-request'] !== value) {
      throw new RequestError(403, 'Missing studio request header.');
    }
  }

  async function route(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/ingest') {
      if (req.method !== 'POST') {
        throw new RequestError(405, 'Use POST.');
      }
      requireHeader(req, 'app-log');
      if (!allowIngest()) {
        throw new RequestError(429, 'Too many log batches. Try again shortly.');
      }
      const input = await readJson(req, MAX_INGEST_BYTES);
      if (!Array.isArray(input.records) || input.records.length > MAX_INGEST_RECORDS) {
        throw new RequestError(400, `records must be an array of at most ${MAX_INGEST_RECORDS}.`);
      }
      const records = [];
      let rejected = 0;
      for (const item of input.records) {
        const record = parseBrowserRecord(item, { now, redact });
        if (record) {
          records.push(record);
        } else {
          rejected += 1;
        }
      }
      const accepted = appendValidatedRecords(records);
      const reportedDrops = Number.isInteger(input.droppedCount) ? input.droppedCount : 0;
      if (rejected || reportedDrops > 0) {
        getStore().addCounter('browser_rejected_records', rejected);
        getStore().addCounter('browser_dropped_records', Math.min(reportedDrops, 1_000_000));
      }
      return json(res, 202, { accepted, rejected });
    }
    requireHeader(req, 'logs');
    if (pathname === '/' && req.method === 'GET') {
      const filters = parseLogFilters(url.searchParams);
      const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
      return json(res, 200, query(filters, { limit, cursor: url.searchParams.get('cursor') }));
    }
    if (pathname === '/summary' && req.method === 'GET') {
      return json(res, 200, summary(parseLogFilters(url.searchParams)));
    }
    if (pathname === '/tail' && req.method === 'GET') {
      const afterRaw = url.searchParams.get('after');
      const afterId = afterRaw ? Number(afterRaw) : 0;
      if (!Number.isInteger(afterId) || afterId < 0) {
        throw new RequestError(400, 'after must be a row id.');
      }
      const filters = parseLogFilters(url.searchParams);
      const limit = parseLimit(url.searchParams.get('limit'), 200, 500);
      return json(res, 200, tail(filters, { afterId, limit }));
    }
    if (pathname === '/export' && req.method === 'GET') {
      const format = url.searchParams.get('format') || 'jsonl';
      if (format !== 'jsonl') {
        throw new RequestError(400, 'format must be jsonl.');
      }
      const filters = parseLogFilters(url.searchParams);
      const limit = parseLimit(url.searchParams.get('limit'), MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
      ingestNow();
      const stamp = new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="forge-log-${stamp}.jsonl"`,
        'Cache-Control': 'no-store',
      });
      for (const row of getStore().exportRows(filters, { limit })) {
        res.write(`${JSON.stringify(redactRow(row, redact))}\n`);
      }
      res.end();
      log.info('log.export.completed', { format: 'jsonl' });
      return undefined;
    }
    if (pathname === '/' && req.method === 'DELETE') {
      const origin = req.headers.origin;
      if (!origin) {
        throw new RequestError(403, 'Deleting logs needs the studio Origin.');
      }
      const input = await readJson(req, MAX_DELETE_BYTES);
      for (const key of Object.keys(input)) {
        if (key !== 'olderThanDays' && key !== 'confirm') {
          throw new RequestError(400, `Unknown field: ${key.slice(0, 40)}.`);
        }
      }
      const days = input.olderThanDays;
      if (!Number.isInteger(days) || days < 0 || days > 3650) {
        throw new RequestError(400, 'olderThanDays must be a whole number from 0 to 3650.');
      }
      if (input.confirm !== true) {
        throw new RequestError(400, 'Set confirm to true to delete log rows.');
      }
      ingestNow();
      const deleted = getStore().deleteOlderThan(days);
      log.info('log.rows.deleted', { deletedCount: deleted, olderThanDays: days, source: 'user' });
      return json(res, 200, { deleted });
    }
    throw new RequestError(404, 'Not found.');
  }

  // GET /api/logs (without our header) and /api/logs/stream belong to the older file-log
  // snapshot routes in diagnostics.js, registered later; they are passed through unchanged.
  function isFileLogRoute(req) {
    const pathname =
      new URL(req.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/stream') {
      return true;
    }
    return pathname === '/' && req.method === 'GET' && req.headers['x-forge-request'] !== 'logs';
  }

  function guarded(handler) {
    return async (req, res, next) => {
      if (isFileLogRoute(req)) {
        return next?.();
      }
      if (!LOOPBACK_HOST.test(req.headers.host || '')) {
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      try {
        await handler(req, res);
      } catch (failure) {
        if (res.headersSent || res.destroyed) {
          return undefined;
        }
        if (failure instanceof RequestError || failure instanceof LogQueryError) {
          return json(res, failure.status, { error: failure.message });
        }
        log.error('log.request.failed', { error: failure, route: '/api/logs' });
        json(res, 500, { error: 'The log service failed. Check Diagnostics.' });
      }
      return undefined;
    };
  }

  // Records method, route template, status and duration of every /api request, and attaches the
  // caller's trace id (or a new one) to everything logged while the request is handled.
  const httpLog = createLogger('http');
  function requestLogging(req, res, next) {
    const pathname = (req.originalUrl || req.url || '').split('?')[0];
    if (!pathname.startsWith('/api/') || pathname === '/api/logs/ingest') {
      next();
      return;
    }
    const traceId = traceIdFromHeaders(req.headers) ?? newTraceId();
    const started = performance.now();
    try {
      res.setHeader(TRACE_HEADER, traceId);
    } catch {
      // log-coverage: ignore -- headers may already be sent by an upgrade handler; the trace
      // still applies to the logs.
    }
    res.once('finish', () => {
      const fields = {
        method: req.method,
        route: routeTemplate(pathname),
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        traceId,
      };
      if (res.statusCode >= 500) {
        httpLog.warn('http.request.failed', fields);
      } else if (res.statusCode >= 400 && res.statusCode !== 404) {
        httpLog.info('http.request.rejected', fields);
      } else {
        httpLog.debug('http.request.completed', fields);
      }
    });
    runWithTrace(traceId, next);
  }

  function attach(server) {
    configureAppLog({ processName: 'host' });
    server.middlewares.use(requestLogging);
    server.middlewares.use('/api/logs', guarded(route));
    loadSettingsAccessor();
    log.info('log.service.started', { pid: process.pid });
    if (ingestIntervalMs > 0) {
      const timer = setInterval(() => {
        try {
          getStore();
          ingester.ingestOnce();
        } catch (error) {
          log.warn('log.ingest.failed', { error });
        }
      }, ingestIntervalMs);
      timer.unref?.();
      timers.push(timer);
    }
    if (retentionIntervalMs > 0) {
      const first = setTimeout(
        runRetention,
        Math.min(FIRST_RETENTION_DELAY_MS, retentionIntervalMs),
      );
      first.unref?.();
      const timer = setInterval(runRetention, retentionIntervalMs);
      timer.unref?.();
      timers.push(first, timer);
    }
    server.httpServer?.once('close', () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      try {
        ingestNow();
      } catch (error) {
        // The database may be locked or gone at shutdown; the spool is kept for the next start.
        log.warn('log.ingest.shutdown.failed', { error });
      }
      store?.close();
      store = null;
      ingester = null;
    });
  }

  return {
    name: 'forge-logs',
    configureServer: attach,
    configurePreviewServer: attach,
    getStore,
    ingestNow,
    runRetention,
    query,
    tail,
    summary,
    close() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      store?.close();
      store = null;
      ingester = null;
    },
  };
}
