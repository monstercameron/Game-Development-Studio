// Browser-side error capture for the Errors review. Uncaught errors, unhandled rejections,
// error-boundary catches, failed studio API calls (HTTP >= 500 or network failure) and error
// toasts are reported to /api/errors/report. Reports carry no request bodies or prompts.
import { redactText } from '../runtime/error-redaction.js';
import { createLog } from './app-log.js';

const log = createLog('errors');

const REPORT_PATH = '/api/errors/report';
const DEDUPE_MS = 30000;
const MAX_REPORTS_PER_MINUTE = 20;
const INSTALLED = Symbol.for('forge.errorCapture');
export const ERRORS_CHANGED_EVENT = 'forge:errors-changed';
export const CAUGHT_ERROR_EVENT = 'forge:caught-error';

let sendFetch = null;
const recent = new Map();
const sentTimes = [];

function currentPage() {
  try {
    return window.location.pathname;
    // log-coverage: ignore -- reading the location cannot fail on a page; a log would run per report
  } catch {
    return '';
  }
}

// Returns 'sent', or why the report is skipped: 'duplicate' or 'rate-limited'.
function reportDecision(key) {
  const now = Date.now();
  for (const [entry, time] of recent) {
    if (now - time > DEDUPE_MS) {
      recent.delete(entry);
    }
  }
  while (sentTimes.length && now - sentTimes[0] > 60000) {
    sentTimes.shift();
  }
  if (recent.has(key)) {
    return 'duplicate';
  }
  if (sentTimes.length >= MAX_REPORTS_PER_MINUTE) {
    return 'rate-limited';
  }
  recent.set(key, now);
  sentTimes.push(now);
  return 'sent';
}

function textOf(value, limit) {
  try {
    return redactText(String(value ?? ''), {}).slice(0, limit);
    // log-coverage: ignore -- pure text helper run for every report; a log adds no signal
  } catch {
    return '';
  }
}

/**
 * Sends one report. Failures to report are ignored on purpose: reporting must never cause a
 * second error loop, and the server may be the thing that is down.
 *
 * @param {{kind: string, message: string, stack?: string, componentStack?: string,
 *   context?: object}} report
 */
export function reportClientError(report) {
  const message = textOf(report.message, 4000).trim();
  if (!message) {
    log.debug('errors.capture.skipped', { kind: report.kind, reason: 'empty' });
    return false;
  }
  const body = {
    kind: report.kind,
    message,
    page: currentPage(),
    ...(report.stack ? { stack: textOf(report.stack, 40000) } : {}),
    ...(report.componentStack ? { componentStack: textOf(report.componentStack, 16000) } : {}),
    ...(report.context ? { context: report.context } : {}),
  };
  const decision = reportDecision(
    `${body.kind}\n${body.message}\n${(body.stack || '').slice(0, 300)}`,
  );
  if (decision !== 'sent') {
    log.debug('errors.capture.skipped', { kind: report.kind, reason: decision });
    return false;
  }
  const send = sendFetch || globalThis.fetch?.bind(globalThis);
  if (!send) {
    log.debug('errors.capture.skipped', { kind: report.kind, reason: 'no-transport' });
    return false;
  }
  Promise.resolve()
    .then(() =>
      send(REPORT_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'errors' },
        body: JSON.stringify(body),
      }),
    )
    .then((response) => {
      if (response?.ok) {
        log.debug('errors.capture.sent', { kind: report.kind });
        window.dispatchEvent(new Event(ERRORS_CHANGED_EVENT));
      } else {
        log.warn('errors.capture.rejected', { kind: report.kind, status: response?.status });
      }
    })
    .catch((error) => {
      // Deliberately dropped; see the function comment. Only the error class is logged.
      log.debug('errors.capture.failed', { kind: report.kind, errorClass: error?.name });
    });
  return true;
}

/** Error toasts in Forge start with these words; validation hints and successes do not. */
export function isErrorNotice(text) {
  return (
    typeof text === 'string' && /^(could not|couldn't|cannot|failed|unable to)\b/i.test(text.trim())
  );
}

/** Reports a toast only when it is an error. Returns whether it was reported. */
export function reportNoticeError(text) {
  if (!isErrorNotice(text)) {
    return false;
  }
  return reportClientError({ kind: 'notice', message: text });
}

function errorDetails(value) {
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, stack: value.stack || '' };
  }
  try {
    return { message: String(value), stack: '' };
    // log-coverage: ignore -- runs inside window error handlers; a log here risks a feedback loop
  } catch {
    return { message: 'A non-Error value was thrown.', stack: '' };
  }
}

function isStudioApi(url, origin) {
  // The errors API is not tracked, so reporting cannot loop. The deliberate test route that
  // returns HTTP 500 (Diagnostics, Test the error pipeline) is the one exception.
  const isErrorsApi =
    url.pathname.startsWith('/api/errors') && !url.pathname.startsWith('/api/errors/test/');
  // Log routes are excluded too: a failed log send must not become an error report, or a log
  // call would report its own failure (docs/LOGGING.md).
  return (
    url.origin === origin &&
    url.pathname.startsWith('/api/') &&
    !isErrorsApi &&
    !url.pathname.startsWith('/api/client-logs') &&
    !url.pathname.startsWith('/api/logs/')
  );
}

function requestTarget(input, base) {
  try {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    return new URL(href, base);
    // log-coverage: ignore -- an unparsable request URL is an ordinary input here, not a failed decision
  } catch {
    return null;
  }
}

/** Wraps fetch so failed studio API calls are reported. Responses and errors pass through. */
export function wrapFetch(originalFetch, win) {
  return async function forgeFetch(input, init) {
    const url = requestTarget(input, win.location.href);
    const tracked = url && isStudioApi(url, win.location.origin);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    try {
      const response = await originalFetch(input, init);
      if (tracked && response && response.status >= 500) {
        let detail = '';
        try {
          const type = response.headers?.get?.('content-type') || '';
          if (type.includes('json') && typeof response.clone === 'function') {
            const data = await response.clone().json();
            detail = typeof data?.error === 'string' ? `: ${data.error.slice(0, 500)}` : '';
          }
        } catch (error) {
          log.debug('errors.detail.unreadable', {
            status: response.status,
            errorClass: error?.name,
          });
          detail = '';
        }
        reportClientError({
          kind: 'fetch',
          message: `${method} ${url.pathname} failed with HTTP ${response.status}${detail}`,
          context: { method, path: url.pathname, status: response.status },
        });
      }
      return response;
    } catch (error) {
      if (tracked && error?.name !== 'AbortError') {
        reportClientError({
          kind: 'fetch',
          message: `${method} ${url.pathname} could not reach the studio: ${error?.message || 'network error'}`,
          context: { method, path: url.pathname, status: 0 },
        });
      }
      throw error;
    }
  };
}

/** Installs the window listeners and the fetch wrapper once per window. */
export function installErrorCapture(win = window) {
  if (!win || win[INSTALLED]) {
    return;
  }
  win[INSTALLED] = true;
  log.info('errors.capture.installed');
  const originalFetch = win.fetch?.bind(win);
  if (originalFetch) {
    sendFetch = originalFetch;
    win.fetch = wrapFetch(originalFetch, win);
  }
  win.addEventListener('error', (event) => {
    const details = errorDetails(event.error ?? event.message);
    reportClientError({ kind: 'error', ...details });
  });
  win.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.name === 'AbortError') {
      return;
    }
    reportClientError({ kind: 'rejection', ...errorDetails(event.reason) });
  });
  // Error boundaries announce caught render errors with this event (see PageErrorBoundary).
  win.addEventListener(CAUGHT_ERROR_EVENT, (event) => {
    const detail = event.detail || {};
    reportClientError({
      kind: 'boundary',
      ...errorDetails(detail.error),
      componentStack: detail.componentStack || '',
      context: detail.name ? { boundary: String(detail.name).slice(0, 100) } : undefined,
    });
  });
}

if (typeof window !== 'undefined' && window.document) {
  installErrorCapture(window);
}
