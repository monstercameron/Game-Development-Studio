// Interface translation service: /api/i18n on the studio host.
//
// Requests name only a language and namespaces. The strings sent to OpenAI are read here from
// the shipped English catalog (runtime/i18n-catalog.js); a client can never submit text to be
// translated, so projects, prompts, files and other user content cannot reach the provider.
// Nothing is sent without an explicit, previewed POST /translate. The OpenAI key comes from the
// credential store and stays in this process; responses and errors never include it.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiAssistSettings, validateAiAssistEntry } from './ai-assist-settings.js';
import { createLogger, routeTemplate } from './app-log.js';
import { credentialStore } from './credentials.js';
import {
  OPENAI_BASE_URL,
  ProviderError,
  digestOf,
  requestFixSuggestion,
  verifyModel,
} from './error-fix.js';
import { createEnglishCatalog } from './i18n-catalog.js';
import { createTranslationStore } from './i18n-store.js';
import {
  CHUNK_SIZE,
  REJECTION_REASONS,
  TRANSLATE_TIMEOUT_MS,
  buildTranslationRequest,
  chunk,
  parseTranslationOutput,
  validateTranslation,
} from './i18n-translate.js';
import { isRtlLocale } from '../src/i18n/i18n-core.js';
import { NAMESPACES, isValidKey, namespaceOf } from '../src/i18n/namespaces.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = createLogger('i18n');
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const FEATURE = 'ui-translate';
const PSEUDO_LOCALE = 'en-XA';
const MAX_NAMESPACES = 12;
export const TRANSLATE_NOTICE =
  'Only Forge’s own interface text from the shipped English catalog is sent to OpenAI. ' +
  'Projects, prompts, file names, assets and anything you typed are never sent.';

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    // log-coverage: ignore -- builds an error object, not a state change
    this.status = status;
    this.code = code;
  }
}

// Route template for logs, such as /api/i18n/translate: never the concrete URL or its query.
function routeOf(req) {
  return routeTemplate(`/api/i18n${String(req.url || '')}`);
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit) {
  let raw = '';
  for await (const chunkText of req) {
    raw += chunkText;
    if (raw.length > limit) {
      throw new RequestError(413, 'Request is too large.');
    }
  }
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error('not an object');
    }
    return value;
  } catch {
    throw new RequestError(400, 'Invalid request.');
  }
}

function rejectUnknownFields(input, allowed) {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new RequestError(400, `Unknown field: ${key.slice(0, 40)}.`, 'unknown_field');
    }
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

function languageName(code, displayLocale = 'en') {
  try {
    return new Intl.DisplayNames([displayLocale], { type: 'language', fallback: 'none' }).of(code);
  } catch (failure) {
    log.debug('i18n.language.name.unavailable', { errorClass: failure?.name });
    return undefined;
  }
}

/** A canonical BCP-47 target language that Intl knows, excluding English and the pseudo-locale. */
export function parseTargetLanguage(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 35) {
    throw new RequestError(400, 'Choose a language, for example de or pt-BR.', 'invalid_language');
  }
  let canonical;
  try {
    [canonical] = Intl.getCanonicalLocales(input.trim());
  } catch {
    throw new RequestError(
      400,
      'That is not a valid language code. Use a BCP 47 code such as fr, de-CH or zh-Hant.',
      'invalid_language',
    );
  }
  const language = canonical.split('-')[0].toLowerCase();
  if (language === 'en' || canonical === PSEUDO_LOCALE) {
    throw new RequestError(
      400,
      'English is the source language and needs no translation.',
      'english',
    );
  }
  if (!languageName(language)) {
    throw new RequestError(
      400,
      `Forge does not recognize the language ${canonical}.`,
      'unknown_language',
    );
  }
  return canonical;
}

/**
 * The canonical language preference for a BCP 47 code, 'en' or the pseudo-locale.
 * Throws a 400 RequestError when the input is not a known language.
 */
export function parsePreference(input) {
  if (input === 'en' || input === PSEUDO_LOCALE) {
    return input;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(String(input));
    if (canonical && languageName(canonical.split('-')[0])) {
      return canonical;
    }
  } catch (failure) {
    // The rejection is thrown below and logged by the route with its reason code.
    log.debug('i18n.preference.parse.failed', { errorClass: failure?.name });
  }
  throw new RequestError(400, 'Choose a valid language.', 'invalid_language');
}

/**
 * @param {object} options Overrides for tests: runtime folder, English catalog folder, the
 *   credential store, fetch, the OpenAI base URL, AI settings, rate limits and timeouts.
 */
export function i18nService({
  runtimeDir = process.env.FORGE_RUNTIME_DIR || path.join(repositoryRoot, '.forge-runtime'),
  catalogDirectory,
  credentials = credentialStore,
  fetchImpl = fetch,
  openaiBaseUrl = OPENAI_BASE_URL,
  aiAssistSettings,
  translateLimitPerHour = 30,
  requestTimeoutMs = TRANSLATE_TIMEOUT_MS,
  chunkSize = CHUNK_SIZE,
  now = () => Date.now(),
} = {}) {
  const english = createEnglishCatalog(catalogDirectory ? { directory: catalogDirectory } : {});
  const store = createTranslationStore({ directory: runtimeDir });
  const aiSettings = aiAssistSettings || createAiAssistSettings({ directory: runtimeDir });
  const allowTranslate = createRateLimiter({
    limit: translateLimitPerHour,
    windowMs: 3600000,
    now,
  });
  const allowVerify = createRateLimiter({ limit: 20, windowMs: 60000, now });
  let running = null;

  const settings = () => aiSettings.get(FEATURE);

  function hasSavedKey() {
    try {
      return credentials.status().some((item) => item.provider === 'openai' && item.saved);
    } catch (failure) {
      log.debug('i18n.credentials.status.failed', {
        errorClass: failure?.name,
        errorCode: failure?.code,
      });
      return false;
    }
  }

  async function savedKey() {
    let key;
    try {
      key = await credentials.get('openai');
    } catch (failure) {
      log.warn('i18n.credentials.unlock.failed', {
        errorClass: failure?.name,
        errorCode: failure?.code,
      });
      throw new RequestError(
        500,
        'Could not unlock the saved OpenAI key. Check that the studio runs under the Windows account that saved it.',
      );
    }
    if (!key) {
      throw new RequestError(
        400,
        'Add your OpenAI key in Settings, API keys, to translate.',
        'no_key',
      );
    }
    return key;
  }

  function parseNamespaces(input) {
    if (!Array.isArray(input) || !input.length || input.length > MAX_NAMESPACES) {
      throw new RequestError(400, `Choose 1 to ${MAX_NAMESPACES} pages to translate.`);
    }
    const available = new Set(english.namespaces());
    const unique = [...new Set(input)];
    for (const namespace of unique) {
      if (typeof namespace !== 'string' || !NAMESPACES.includes(namespace)) {
        throw new RequestError(400, 'Choose a known page.', 'unknown_namespace');
      }
    }
    return unique.filter((namespace) => available.has(namespace));
  }

  /** Current entries for a language and namespace, with what is translated, stale or missing. */
  function namespaceState(lang, namespace) {
    const source = english.read(namespace);
    const translations = store.translations(lang, namespace);
    const overrides = store.overrides(lang, namespace);
    const state = { namespace, total: source.size, cached: 0, stale: 0, missing: 0, overrides: 0 };
    const pending = [];
    const served = {};
    let machine = null;
    for (const [key, entry] of source) {
      const override = overrides.get(key);
      if (override && !validateTranslation(entry.value, override.value, lang)) {
        state.overrides += 1;
        served[key] = { value: override.value, source: entry.value, kind: 'override' };
        continue;
      }
      const rows = translations.get(key) || [];
      const current = rows.find((row) => row.sourceHash === entry.hash);
      if (current) {
        state.cached += 1;
        served[key] = {
          value: current.value,
          source: entry.value,
          kind: 'machine',
          model: current.model,
        };
        if (!machine || current.createdAt > machine.translatedAt) {
          machine = { model: current.model, translatedAt: current.createdAt };
        }
        continue;
      }
      if (rows.length) {
        state.stale += 1;
      } else {
        state.missing += 1;
      }
      pending.push({ key, namespace, value: entry.value, sourceHash: entry.hash });
    }
    return { state, pending, served, machine };
  }

  function plan(lang, namespaces) {
    const states = namespaces.map((namespace) => namespaceState(lang, namespace));
    const items = states.flatMap((item) => item.pending);
    return { states: states.map((item) => item.state), items };
  }

  function preview(lang, namespaces) {
    const { model, provider } = settings();
    const { states, items } = plan(lang, namespaces);
    const characters = items.reduce(
      (sum, item) =>
        sum +
        (typeof item.value === 'string'
          ? item.value.length
          : Object.values(item.value).join('').length),
      0,
    );
    // The digest covers exactly what /translate will send: language, model and each string.
    const digest = digestOf({
      lang,
      model,
      items: items.map((item) => [item.key, item.sourceHash]),
    });
    return {
      lang,
      languageName: languageName(lang) || lang,
      nativeName: languageName(lang, lang) || lang,
      dir: isRtlLocale(lang) ? 'rtl' : 'ltr',
      namespaces: states,
      strings: items.length,
      characters,
      requests: Math.ceil(items.length / chunkSize),
      model,
      provider,
      hasKey: hasSavedKey(),
      notice: TRANSLATE_NOTICE,
      digest,
    };
  }

  async function translate(res, input) {
    rejectUnknownFields(input, ['lang', 'namespaces', 'digest']);
    const lang = parseTargetLanguage(input.lang);
    const namespaces = parseNamespaces(input.namespaces);
    const current = preview(lang, namespaces);
    if (input.digest !== current.digest) {
      throw new RequestError(
        409,
        'The strings or model changed since the preview. Review the new preview before sending.',
        'preview_changed',
      );
    }
    if (current.provider !== 'openai') {
      throw new RequestError(
        400,
        'Interface translation uses OpenAI only; the local provider is not supported. Set the provider to OpenAI in Settings, AI assist.',
        'provider_unsupported',
      );
    }
    if (running) {
      throw new RequestError(
        409,
        'A translation is already running. Wait for it or cancel it.',
        'busy',
      );
    }
    const key = await savedKey();
    if (!allowTranslate()) {
      throw new RequestError(
        429,
        'Too many translation requests. Try again later.',
        'rate_limited',
      );
    }
    const { items } = plan(lang, namespaces);
    const startedAt = performance.now();
    const elapsedMs = () => Math.round(performance.now() - startedAt);
    log.info('i18n.translate.requested', {
      locale: lang,
      provider: current.provider,
      modelId: current.model,
      namespaceCount: namespaces.length,
      stringCount: items.length,
      requestCount: current.requests,
    });
    const abort = new AbortController();
    running = abort;
    res.on('close', () => {
      if (!res.writableFinished) {
        abort.abort();
      }
    });
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const send = (event) => {
      if (!res.destroyed) {
        res.write(`${JSON.stringify(event)}\n`);
      }
    };
    const report = {
      lang,
      model: current.model,
      total: items.length,
      translated: 0,
      keptEnglish: 0,
      rejected: [],
      reasons: {},
      cancelled: false,
      error: null,
    };
    const reject = (list) => {
      for (const item of list) {
        report.keptEnglish += 1;
        report.rejected.push(item);
        // Reason codes (see REJECTION_REASONS); the browser shows them in the UI language.
        report.reasons[item.reason] = (report.reasons[item.reason] || 0) + 1;
      }
    };
    try {
      send({ type: 'start', total: items.length, requests: current.requests });
      const chunks = chunk(items, chunkSize);
      for (const [index, part] of chunks.entries()) {
        if (abort.signal.aborted) {
          report.cancelled = true;
          break;
        }
        const body = buildTranslationRequest({
          locale: lang,
          languageName: current.languageName,
          model: current.model,
          items: part,
        });
        let result;
        try {
          result = await requestFixSuggestion({
            body,
            key,
            fetchImpl,
            baseUrl: openaiBaseUrl,
            signal: abort.signal,
            timeoutMs: requestTimeoutMs,
          });
        } catch (failure) {
          if (abort.signal.aborted) {
            report.cancelled = true;
            break;
          }
          if (failure instanceof ProviderError) {
            log.warn('i18n.translate.request.failed', {
              locale: lang,
              requestIndex: index + 1,
              httpStatus: failure.status,
            });
            report.error = { message: failure.message, code: `openai_${failure.status}` };
            break;
          }
          throw failure;
        }
        const parsed = parseTranslationOutput(result.text, part, lang);
        const rows = part
          .filter((item) => parsed.accepted.has(item.key))
          .map((item) => ({ ...item, value: parsed.accepted.get(item.key) }));
        store.saveTranslations(lang, rows, result.model || current.model);
        report.translated += rows.length;
        reject(parsed.rejected);
        const missingCount = parsed.rejected.filter((item) => item.reason === 'missing').length;
        if (missingCount) {
          log.warn('i18n.translate.keys.missing', {
            locale: lang,
            requestIndex: index + 1,
            missingCount,
          });
        }
        log.debug('i18n.translate.batch.completed', {
          locale: lang,
          requestIndex: index + 1,
          translatedCount: rows.length,
          keptEnglishCount: parsed.rejected.length,
        });
        send({
          type: 'progress',
          request: index + 1,
          requests: chunks.length,
          done: Math.min(items.length, (index + 1) * chunkSize),
          total: items.length,
          translated: report.translated,
          keptEnglish: report.keptEnglish,
        });
      }
      // Strings not translated because of a cancel or provider error stay pending for next time.
      report.notTranslated = report.total - report.translated - report.keptEnglish;
      report.rejected = report.rejected.slice(0, 200);
      const summary = {
        locale: lang,
        durationMs: elapsedMs(),
        translatedCount: report.translated,
        keptEnglishCount: report.keptEnglish,
        notTranslatedCount: report.notTranslated,
      };
      if (report.error) {
        log.warn('i18n.translate.failed', { ...summary, errorCode: report.error.code });
      } else if (report.cancelled) {
        log.info('i18n.translate.cancelled', summary);
      } else {
        log.info('i18n.translate.completed', summary);
      }
      send({ type: 'done', report });
    } catch (failure) {
      log.error('i18n.translate.failed', {
        locale: lang,
        durationMs: elapsedMs(),
        errorClass: failure?.name,
        errorCode: failure?.code,
      });
      send({
        type: 'error',
        error: 'The translation service failed. Check Diagnostics.',
        report,
      });
    } finally {
      running = null;
      res.end();
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET') {
      if (pathname === '/languages') {
        const byLanguage = new Map();
        for (const row of store.summary()) {
          const item = byLanguage.get(row.lang) || {
            code: row.lang,
            name: languageName(row.lang) || row.lang,
            nativeName: languageName(row.lang, row.lang) || row.lang,
            dir: isRtlLocale(row.lang) ? 'rtl' : 'ltr',
            translations: 0,
            overrides: 0,
            namespaces: [],
          };
          item.translations += row.translations;
          item.overrides += row.overrides;
          item.namespaces.push(row.namespace);
          byLanguage.set(row.lang, item);
        }
        const { model, provider } = settings();
        return json(res, 200, {
          languages: [...byLanguage.values()],
          namespaces: english.namespaces(),
          model,
          provider,
          hasKey: hasSavedKey(),
        });
      }
      if (pathname === '/catalog') {
        const lang = url.searchParams.get('lang') || '';
        const namespace = url.searchParams.get('ns') || '';
        if (!NAMESPACES.includes(namespace)) {
          throw new RequestError(400, 'Choose a known page.', 'unknown_namespace');
        }
        const target = parseTargetLanguage(lang);
        const { state, served, machine } = namespaceState(target, namespace);
        return json(res, 200, {
          lang: target,
          ns: namespace,
          dir: isRtlLocale(target) ? 'rtl' : 'ltr',
          entries: served,
          machine,
          state,
        });
      }
      if (pathname === '/strings') {
        // English source and current translation of each string, for manual review and edits.
        const namespace = url.searchParams.get('ns') || '';
        if (!NAMESPACES.includes(namespace)) {
          throw new RequestError(400, 'Choose a known page.', 'unknown_namespace');
        }
        const target = parseTargetLanguage(url.searchParams.get('lang') || '');
        const { served, pending } = namespaceState(target, namespace);
        const stored = store.translations(target, namespace);
        const stale = new Set(
          pending.filter((item) => stored.has(item.key)).map((item) => item.key),
        );
        const strings = [...english.read(namespace)].map(([key, entry]) => ({
          key,
          english: entry.value,
          value: served[key]?.value ?? null,
          kind: served[key]?.kind || (stale.has(key) ? 'stale' : 'missing'),
        }));
        return json(res, 200, { lang: target, ns: namespace, strings });
      }
      if (pathname === '/preference') {
        return json(res, 200, { locale: store.getPreference() });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'POST' && req.method !== 'DELETE') {
      log.warn('i18n.request.rejected', {
        route: routeOf(req),
        httpStatus: 405,
        reason: 'method_not_allowed',
      });
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if (
      req.headers.origin !== `http://${req.headers.host}` ||
      req.headers['x-forge-request'] !== 'i18n'
    ) {
      log.warn('i18n.request.rejected', {
        route: routeOf(req),
        httpStatus: 403,
        reason: 'origin_mismatch',
      });
      return json(res, 403, { error: 'Local studio requests only.' });
    }
    if (req.method === 'DELETE') {
      if (pathname !== '/cache') {
        return json(res, 404, { error: 'Not found.' });
      }
      const input = await readJson(req, 4096);
      rejectUnknownFields(input, ['lang', 'namespaces', 'includeOverrides', 'confirm']);
      if (input.confirm !== 'delete') {
        throw new RequestError(400, 'Confirm the deletion.', 'confirm');
      }
      const lang = parseTargetLanguage(input.lang);
      const namespaces = input.namespaces === undefined ? [] : parseNamespaces(input.namespaces);
      const removed = store.reset(lang, {
        namespaces,
        includeOverrides: input.includeOverrides === true,
      });
      return json(res, 200, { removed });
    }
    if (pathname === '/translate') {
      return translate(res, await readJson(req, 4096));
    }
    const input = await readJson(req, 16 * 1024);
    if (pathname === '/preview') {
      rejectUnknownFields(input, ['lang', 'namespaces']);
      return json(
        res,
        200,
        preview(parseTargetLanguage(input.lang), parseNamespaces(input.namespaces)),
      );
    }
    if (pathname === '/preference') {
      rejectUnknownFields(input, ['locale']);
      const locale = parsePreference(input.locale);
      store.setPreference(locale);
      return json(res, 200, { locale });
    }
    if (pathname === '/override') {
      rejectUnknownFields(input, ['lang', 'key', 'value']);
      const lang = parseTargetLanguage(input.lang);
      if (!isValidKey(input.key)) {
        throw new RequestError(400, 'Choose a string from the interface catalog.', 'unknown_key');
      }
      const namespace = namespaceOf(input.key);
      const entry = english.read(namespace).get(input.key);
      if (!entry) {
        throw new RequestError(400, 'Choose a string from the interface catalog.', 'unknown_key');
      }
      if (input.value !== null) {
        const reason = validateTranslation(entry.value, input.value, lang);
        if (reason) {
          throw new RequestError(
            400,
            `The translation was not saved: ${REJECTION_REASONS[reason] || reason}.`,
            `invalid_${reason}`,
          );
        }
      }
      store.setOverride(lang, {
        key: input.key,
        namespace,
        sourceHash: entry.hash,
        value: input.value,
      });
      return json(res, 200, { key: input.key, value: input.value });
    }
    if (pathname === '/verify-model') {
      rejectUnknownFields(input, ['model']);
      const model = input.model === undefined ? settings().model : input.model;
      try {
        validateAiAssistEntry({ feature: FEATURE, provider: 'openai', model });
      } catch (failure) {
        throw new RequestError(400, failure.message);
      }
      if (!hasSavedKey()) {
        return json(res, 200, {
          exists: null,
          code: 'no_key',
          message: 'Add your OpenAI key in Settings to check this model.',
          models: [],
        });
      }
      if (!allowVerify()) {
        throw new RequestError(
          429,
          'Too many model checks. Try again in a minute.',
          'rate_limited',
        );
      }
      const key = await savedKey();
      try {
        return json(res, 200, await verifyModel({ model, key, fetchImpl, baseUrl: openaiBaseUrl }));
      } catch (failure) {
        if (failure instanceof ProviderError) {
          throw new RequestError(failure.status, failure.message, `openai_${failure.status}`);
        }
        throw failure;
      }
    }
    return json(res, 404, { error: 'Not found.' });
  }

  function guarded(handler) {
    return async (req, res) => {
      if (!LOOPBACK_HOST.test(req.headers.host || '')) {
        log.warn('i18n.request.rejected', {
          route: routeOf(req),
          httpStatus: 403,
          reason: 'not_loopback',
        });
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      try {
        await handler(req, res);
      } catch (failure) {
        if (failure instanceof RequestError) {
          log.warn('i18n.request.rejected', {
            route: routeOf(req),
            httpStatus: failure.status,
            reason: failure.code || 'invalid_request',
          });
        } else {
          log.error('i18n.request.failed', {
            route: routeOf(req),
            errorClass: failure?.name,
            errorCode: failure?.code,
          });
        }
        if (res.headersSent || res.destroyed) {
          return;
        }
        if (failure instanceof RequestError) {
          return json(res, failure.status, {
            error: failure.message,
            ...(failure.code ? { code: failure.code } : {}),
          });
        }
        // Unexpected failures return a generic message; details stay out of the response.
        json(res, 500, { error: 'The translation service failed. Check Diagnostics.' });
      }
    };
  }

  function attach(server) {
    // log-coverage: ignore -- route registration only; guarded() logs every rejection and failure.
    server.middlewares.use('/api/i18n', guarded(route));
    server.httpServer?.once('close', () => {
      running?.abort();
      store.close();
    });
  }

  return {
    name: 'forge-i18n',
    configureServer: attach,
    configurePreviewServer: attach,
    store,
  };
}
