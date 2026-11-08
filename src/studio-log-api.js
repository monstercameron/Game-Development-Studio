// Client helpers for the Studio log view (src/StudioLogView.jsx) and the /api/logs routes.
// Pure helpers (filters, grouping, formatting) are separate from the fetch calls so they can be
// tested without a browser.
export const LOG_REQUEST_HEADERS = Object.freeze({ 'X-Forge-Request': 'logs' });
export const LOG_RANGES = Object.freeze({
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  all: null,
});
export const DEFAULT_LOG_RANGE = '24h';
export const LOG_PAGE_ROWS = 100;

// URL search parameter names used by the Studio log view (prefixed to avoid clashing with the
// file log controls on the same page).
export const LOG_URL_KEYS = Object.freeze({
  level: 'logLevel',
  component: 'logComponent',
  event: 'logEvent',
  text: 'logText',
  range: 'logRange',
  jobId: 'logJob',
  traceId: 'logTrace',
});

const ID_PATTERN = /^[A-Za-z0-9._:+/-]{1,128}$/;
const EVENT_PREFIX_PATTERN = /^[a-z0-9_.-]{1,96}$/;
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

/** Reads and validates the view's filters from URL search parameters. */
export function readLogFilters(searchParams) {
  const get = (key) => searchParams.get(LOG_URL_KEYS[key]) ?? '';
  const level = get('level');
  const range = get('range');
  const event = get('event').toLowerCase();
  const jobId = get('jobId');
  const traceId = get('traceId');
  return {
    level: LEVELS.includes(level) ? level : 'info',
    component: /^[a-z0-9-]{1,40}$/.test(get('component')) ? get('component') : '',
    event: EVENT_PREFIX_PATTERN.test(event) ? event : '',
    text: get('text').slice(0, 200),
    range: Object.hasOwn(LOG_RANGES, range) ? range : DEFAULT_LOG_RANGE,
    jobId: ID_PATTERN.test(jobId) ? jobId : '',
    traceId: /^[A-Za-z0-9_-]{8,64}$/.test(traceId) ? traceId : '',
  };
}

/** Builds the query string for /api/logs, /tail, /summary and /export. */
export function buildLogQuery(filters, { now = Date.now(), extra = {} } = {}) {
  const params = new URLSearchParams();
  if (filters.level) {
    params.set('level', filters.level);
  }
  if (filters.component) {
    params.set('component', filters.component);
  }
  if (filters.event) {
    params.set('event', filters.event);
  }
  if (filters.text) {
    params.set('text', filters.text);
  }
  const rangeMs = LOG_RANGES[filters.range];
  if (rangeMs && !filters.traceId) {
    params.set('since', String(now - rangeMs));
  }
  if (filters.jobId) {
    params.set('jobId', filters.jobId);
  }
  if (filters.traceId) {
    params.set('traceId', filters.traceId);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  return params.toString();
}

function sameGroup(a, b) {
  return (
    a.level === b.level &&
    a.component === b.component &&
    a.event === b.event &&
    a.message === b.message &&
    (a.jobId ?? null) === (b.jobId ?? null)
  );
}

/**
 * Collapses consecutive identical records (same level, component, event, message and job) into
 * one group whose `total` sums the stored counts. Input and output are newest first.
 */
export function groupDuplicateRows(rows) {
  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && sameGroup(last.row, row)) {
      last.total += row.count || 1;
      last.rows.push(row);
      last.oldestTs = Math.min(last.oldestTs, row.firstTs ?? row.ts);
    } else {
      groups.push({
        key: `${row.id}`,
        row,
        rows: [row],
        total: row.count || 1,
        oldestTs: row.firstTs ?? row.ts,
      });
    }
  }
  return groups;
}

/** Formats a byte count with binary units, for the database size. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** One record as a JSON line, for copying. Records are already redacted by the server. */
export function formatRowsAsJsonLines(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

async function requestJson(url, { signal } = {}) {
  const response = await fetch(url, { headers: LOG_REQUEST_HEADERS, signal });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // log-coverage: ignore -- a non-JSON body (for example a proxy error page) is reported by
    // its status below.
  }
  if (!response.ok) {
    const error = new Error(body?.error || `The log service returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body ?? {};
}

export function fetchLogPage(filters, { cursor, signal } = {}) {
  return requestJson(
    `/api/logs?${buildLogQuery(filters, { extra: { limit: LOG_PAGE_ROWS, cursor } })}`,
    {
      signal,
    },
  );
}

export function fetchLogTail(filters, { afterId, signal } = {}) {
  return requestJson(`/api/logs/tail?${buildLogQuery(filters, { extra: { after: afterId } })}`, {
    signal,
  });
}

export function fetchLogSummary({ signal } = {}) {
  return requestJson('/api/logs/summary', { signal });
}

/** Downloads the filtered, redacted export as a .jsonl file. */
export async function downloadLogExport(filters) {
  const response = await fetch(
    `/api/logs/export?${buildLogQuery(filters, { extra: { format: 'jsonl' } })}`,
    {
      headers: LOG_REQUEST_HEADERS,
    },
  );
  if (!response.ok) {
    throw new Error(`The log service returned ${response.status}.`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `forge-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
