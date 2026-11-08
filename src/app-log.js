// Browser side of Forge's structured application log (docs/LOGGING.md).
//
//   import { createLog } from './app-log.js';
//   const log = createLog('image');
//   log.info('ui.render.queued', { jobId });
//
// The same event, field and redaction rules as the Node logger apply (runtime/log-fields.js).
// Records are batched and posted to /api/logs/ingest; the server validates them again. A failed
// or offline send is dropped silently after a bounded retry buffer: logging never shows an error,
// never throws and never writes to the console in a production build.
import {
  LOG_LEVELS,
  buildRecord,
  isEventId,
  isLogComponent,
  redactLogText,
  routeTemplate,
  sanitizeFields,
  sanitizeMessage,
} from '../runtime/log-fields.js';
import { installSharedLogSink } from '../runtime/shared-log.js';

export const INGEST_PATH = '/api/logs/ingest';
export const BATCH_ROWS = 20;
export const FLUSH_MS = 2000;
export const PENDING_CAP_ROWS = 200;
export const MAX_SEND_ROWS = 100;
// Identical records (same level, component, event and job) beyond DEDUPE_BURST_ROWS inside one
// window are dropped and counted, so a loop cannot flood the ingest route.
const DEDUPE_WINDOW_MS = 10_000;
const DEDUPE_BURST_ROWS = 10;
const LEVEL_STORAGE_KEY = 'forge.logLevel';
const CONSOLE_STORAGE_KEY = 'forge.logConsole';

const redact = (text) => redactLogText(text);

const state = {
  pending: [],
  timer: null,
  sending: false,
  dropped: 0,
  seq: 0,
  threshold: null,
  dedupe: new Map(),
  traceId: null,
  sender: null,
  isCaptureInstalled: false,
};

function readStorage(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function currentThreshold() {
  if (state.threshold === null) {
    const stored = readStorage(LEVEL_STORAGE_KEY);
    state.threshold = LOG_LEVELS[stored] ?? LOG_LEVELS.info;
  }
  return state.threshold;
}

function isDevelopmentBuild() {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function echoToConsole(record) {
  if (isDevelopmentBuild() && readStorage(CONSOLE_STORAGE_KEY) === '1') {
    console.debug(`[${record.component}] ${record.event}`, record.fields);
  }
}

function passesDedupe(record) {
  const key = `${record.level}|${record.component}|${record.event}|${record.jobId ?? ''}`;
  const entry = state.dedupe.get(key);
  if (!entry || record.ts - entry.start >= DEDUPE_WINDOW_MS) {
    if (state.dedupe.size > 500) {
      state.dedupe.clear();
    }
    state.dedupe.set(key, { start: record.ts, passed: 1 });
    return true;
  }
  entry.passed += 1;
  if (entry.passed > DEDUPE_BURST_ROWS) {
    state.dropped += 1;
    return false;
  }
  return true;
}

async function defaultSender(records, { isUnloading = false } = {}) {
  if (typeof fetch !== 'function') {
    return false;
  }
  const response = await fetch(INGEST_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'app-log' },
    body: JSON.stringify({ records, droppedCount: state.dropped }),
    keepalive: isUnloading,
  });
  return response.ok;
}

function schedule() {
  if (state.timer || typeof setTimeout !== 'function') {
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    flushBrowserLog();
  }, FLUSH_MS);
}

/**
 * Sends the pending batch. Failures are dropped silently (counted and reported with the next
 * successful batch). Resolves to true when the server accepted the batch.
 */
export async function flushBrowserLog({ isUnloading = false } = {}) {
  if (state.sending || !state.pending.length) {
    return false;
  }
  const batch = state.pending.splice(0, MAX_SEND_ROWS);
  state.sending = true;
  try {
    const sender = state.sender ?? defaultSender;
    const isAccepted = await sender(batch, { isUnloading });
    if (isAccepted) {
      state.dropped = 0;
    } else {
      state.dropped += batch.length;
    }
    return Boolean(isAccepted);
  } catch {
    // Offline, server restarting, or the route is missing: logging must stay silent.
    state.dropped += batch.length;
    return false;
  } finally {
    state.sending = false;
    if (state.pending.length) {
      schedule();
    }
  }
}

function emit(component, level, event, fields, message, context) {
  try {
    const isValidEvent = isEventId(event);
    const { fields: clean, dropped } = sanitizeFields(fields, redact);
    if (!isValidEvent) {
      clean.invalidEvent = true;
    }
    const record = buildRecord({
      ts: Date.now(),
      level,
      component,
      event: isValidEvent ? event : 'log.event.invalid',
      message: sanitizeMessage(message, redact),
      fields: context ? { ...context, ...clean } : clean,
      dropped,
      process: 'browser',
      pid: 0,
      seq: ++state.seq,
      traceId: state.traceId,
    });
    if (!passesDedupe(record)) {
      return;
    }
    echoToConsole(record);
    if (state.pending.length >= PENDING_CAP_ROWS) {
      state.pending.shift();
      state.dropped += 1;
    }
    state.pending.push(record);
    if (state.pending.length >= BATCH_ROWS) {
      flushBrowserLog();
    } else {
      schedule();
    }
  } catch {
    state.dropped += 1;
  }
}

/**
 * Creates a browser logger for one component (a name from LOG_COMPONENTS, e.g. 'image', 'ui').
 * Methods: trace/debug/info/warn/error(eventId, fields?, message?), isEnabled(level),
 * time(eventId, fields?) -> stop(extra?) and child(context).
 *
 * @param {string} component
 * @param {object} [context] fields added to every record (same allow-list)
 * @param {{ sampleRate?: number }} [options] keep only this fraction (0..1) of trace/debug/info
 *   records, for noisy events such as hover or scroll
 */
export function createLog(component, context = undefined, { sampleRate = 1 } = {}) {
  const name = isLogComponent(component) ? component : 'unknown';
  let contextFields = null;
  try {
    const sanitized = context ? sanitizeFields(context, redact).fields : {};
    contextFields = Object.keys(sanitized).length ? sanitized : null;
  } catch {
    contextFields = null;
  }
  const keepFraction = Number.isFinite(sampleRate) ? Math.min(1, Math.max(0, sampleRate)) : 1;

  function write(level, event, fields, message) {
    if (LOG_LEVELS[level] < currentThreshold()) {
      return;
    }
    if (keepFraction < 1 && LOG_LEVELS[level] < LOG_LEVELS.warn && Math.random() >= keepFraction) {
      return;
    }
    emit(name, level, event, fields, message, contextFields);
  }

  const log = {
    component: name,
    trace: (event, fields, message) => write('trace', event, fields, message),
    debug: (event, fields, message) => write('debug', event, fields, message),
    info: (event, fields, message) => write('info', event, fields, message),
    warn: (event, fields, message) => write('warn', event, fields, message),
    error: (event, fields, message) => write('error', event, fields, message),
    isEnabled: (level) => (LOG_LEVELS[level] ?? Infinity) >= currentThreshold(),
    time(event, fields) {
      const started = performance.now();
      return (extra) => {
        const durationMs = Math.round(performance.now() - started);
        const hasError = Boolean(extra && extra.error !== undefined && extra.error !== null);
        write(hasError ? 'error' : 'info', event, { ...fields, ...extra, durationMs });
        return durationMs;
      };
    },
    child: (extraContext) =>
      createLog(name, { ...contextFields, ...extraContext }, { sampleRate: keepFraction }),
  };
  return log;
}

/** Sets the browser threshold for this tab ('trace'..'error'); stored in localStorage. */
export function setBrowserLogLevel(level) {
  if (!(level in LOG_LEVELS)) {
    return;
  }
  state.threshold = LOG_LEVELS[level];
  try {
    globalThis.localStorage?.setItem(LEVEL_STORAGE_KEY, level);
  } catch {
    // Private windows may block storage; the level still applies to this page.
  }
}

/** Trace id attached to every browser record and to /api requests made through fetch. */
export function setBrowserTraceId(traceId) {
  state.traceId =
    typeof traceId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(traceId) ? traceId : null;
}

const uiLog = createLog('ui');
const httpLog = createLog('http');

function pageOf(pathname) {
  const first =
    String(pathname || '/')
      .split(/[?#]/)[0]
      .split('/')
      .filter(Boolean)[0] ?? '';
  return /^[a-z][a-z0-9-]{0,40}$/.test(first) ? first : first ? ':param' : 'home';
}

function logRoute() {
  uiLog.info('ui.route.changed', { page: pageOf(globalThis.location?.pathname) });
}

function apiRouteOf(input) {
  try {
    const raw = typeof input === 'string' ? input : input?.url;
    const url = new URL(raw, globalThis.location?.href ?? 'http://localhost/');
    if (url.origin !== globalThis.location?.origin || !url.pathname.startsWith('/api/')) {
      return null;
    }
    return url.pathname === INGEST_PATH ? null : routeTemplate(url.pathname);
  } catch {
    return null;
  }
}

function methodOf(input, init) {
  const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
  return /^[A-Z]{3,7}$/.test(method) ? method : 'OTHER';
}

function wrapFetch() {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original.isForgeLogged) {
    return;
  }
  const logged = async function loggedFetch(input, init) {
    const route = apiRouteOf(input);
    if (!route) {
      return original.call(this, input, init);
    }
    const method = methodOf(input, init);
    const started = performance.now();
    try {
      const response = await original.call(this, input, init);
      const durationMs = Math.round(performance.now() - started);
      if (!response.ok) {
        httpLog.warn('http.request.failed', { method, route, status: response.status, durationMs });
      } else {
        httpLog.debug('http.request.completed', {
          method,
          route,
          status: response.status,
          durationMs,
        });
      }
      return response;
    } catch (error) {
      const isAbort = error?.name === 'AbortError';
      httpLog[isAbort ? 'debug' : 'warn'](
        isAbort ? 'http.request.aborted' : 'http.request.failed',
        {
          method,
          route,
          errorClass: typeof error?.name === 'string' ? error.name : 'Error',
          durationMs: Math.round(performance.now() - started),
        },
      );
      throw error;
    }
  };
  logged.isForgeLogged = true;
  globalThis.fetch = logged;
}

// Only an explicit data-log-action name, or a button's id, is recorded: never text or values.
function handleClick(event) {
  try {
    const target = event.target?.closest?.('[data-log-action], button[id], a[data-log-action]');
    if (!target) {
      return;
    }
    const actionId = target.getAttribute('data-log-action') || target.id;
    if (actionId && /^[A-Za-z0-9._:-]{1,80}$/.test(actionId)) {
      uiLog.info('ui.action.clicked', { actionId, page: pageOf(globalThis.location?.pathname) });
    }
  } catch {
    // A detached or exotic event target is ignored.
  }
}

/**
 * Installs automatic capture once per page: route changes (page name only), failed /api requests
 * (method, route template, status, duration; never bodies or query strings), clicks on elements
 * with `data-log-action` or buttons with an id (the name only) and a final flush on page hide.
 */
export function installAppLogCapture() {
  if (state.isCaptureInstalled || typeof window === 'undefined') {
    return;
  }
  state.isCaptureInstalled = true;
  try {
    wrapFetch();
    for (const method of ['pushState', 'replaceState']) {
      const original = window.history[method];
      window.history[method] = function patchedHistory(...args) {
        const before = window.location.pathname;
        const result = original.apply(this, args);
        if (window.location.pathname !== before) {
          logRoute();
        }
        return result;
      };
    }
    window.addEventListener('popstate', logRoute);
    document.addEventListener('click', handleClick, { capture: true });
    window.addEventListener('pagehide', () => {
      flushBrowserLog({ isUnloading: true });
    });
    logRoute();
  } catch {
    // Capture is best effort; explicit createLog() calls still work.
  }
}

/** For tests: replaces the transport and clears pending state. */
export function configureBrowserLogForTests({ sender = null, level = null } = {}) {
  state.sender = sender;
  state.pending.length = 0;
  state.dropped = 0;
  state.dedupe.clear();
  state.threshold = level ? LOG_LEVELS[level] : null;
}

/** For tests and diagnostics: pending records and the dropped count. */
export function getBrowserLogState() {
  return { pending: state.pending.slice(), dropped: state.dropped };
}

// Modules shared with Node (runtime/*.js imported by src/) log through runtime/shared-log.js; in
// the browser they reach this logger.
const sharedLogs = new Map();

function sharedLogFor(component, context) {
  if (context) {
    return createLog(component, context);
  }
  if (!sharedLogs.has(component)) {
    sharedLogs.set(component, createLog(component));
  }
  return sharedLogs.get(component);
}

installSharedLogSink({
  log(component, level, event, fields, message, context) {
    sharedLogFor(component, context)[level]?.(event, fields, message);
  },
  isEnabled: (component, level) => sharedLogFor(component).isEnabled(level),
});
