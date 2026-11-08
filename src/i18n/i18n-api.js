// Browser client for the local /api/i18n service (runtime/i18n-service.js). Requests carry only
// a language code, page namespaces and the preview digest; never interface or user text.

import { createLog } from '../app-log.js';

const log = createLog('i18n');

const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Forge-Request': 'i18n' };

export class I18nApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Error class, code and HTTP status for log fields. The message is never logged: it can echo
 * service text.
 */
export function errorLogFields(error) {
  return {
    errorClass: typeof error?.name === 'string' ? error.name : undefined,
    errorCode: typeof error?.code === 'string' && error.code ? error.code : undefined,
    status: Number.isInteger(error?.status) && error.status > 0 ? error.status : undefined,
  };
}

/** JSON request to /api/i18n; throws I18nApiError with the service's message. */
export async function i18nRequest(path, { method = 'GET', body, signal, fetchImpl = fetch } = {}) {
  let response;
  try {
    // log-coverage: ignore -- /api responses are logged by the fetch wrapper in src/app-log.js.
    response = await fetchImpl(`/api/i18n${path}`, {
      method,
      headers: method === 'GET' ? undefined : WRITE_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    throw new I18nApiError('The studio translation service could not be reached.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new I18nApiError(data.error || `The translation service returned ${response.status}.`, {
      status: response.status,
      code: data.code || '',
    });
  }
  return data;
}

async function* readLines(response) {
  if (!response.body?.getReader) {
    // Fallback for fetch implementations without streams: events arrive at the end.
    yield* (await response.text()).split('\n');
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    yield* lines;
  }
  buffer += decoder.decode();
  if (buffer) {
    yield buffer;
  }
}

/**
 * Starts the previewed translation and calls onEvent for each progress event. Resolves with the
 * final report. Aborting `signal` cancels the remaining requests on the server.
 */
export async function streamTranslation({
  lang,
  namespaces,
  digest,
  signal,
  onEvent,
  fetchImpl = fetch,
}) {
  let response;
  try {
    // log-coverage: ignore -- /api responses are logged by the fetch wrapper; the caller logs the outcome.
    response = await fetchImpl('/api/i18n/translate', {
      method: 'POST',
      headers: WRITE_HEADERS,
      body: JSON.stringify({ lang, namespaces, digest }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    throw new I18nApiError('The studio translation service could not be reached.');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new I18nApiError(data.error || `The translation service returned ${response.status}.`, {
      status: response.status,
      code: data.code || '',
    });
  }
  let report = null;
  for await (const line of readLines(response)) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A malformed progress line is skipped; the final report still decides the outcome.
      log.debug('i18n.stream.line.skipped');
      continue;
    }
    onEvent?.(event);
    if (event.type === 'done') {
      report = event.report;
    } else if (event.type === 'error') {
      throw new I18nApiError(event.error, { code: 'service_failed' });
    }
  }
  if (!report) {
    throw new I18nApiError('The translation ended before Forge received a report.', {
      code: 'incomplete',
    });
  }
  return report;
}
