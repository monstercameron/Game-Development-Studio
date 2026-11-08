// Studio behaviour settings: /api/settings on the studio host. It exposes the typed registry in
// runtime/core-settings.js to the Settings dialog and the MCP tools.
//
//   GET  /api/settings[?group=<id>]      list every setting (or one group) and the latest changes
//   POST|PATCH /api/settings             { changes: [{ key, value }] } (1 to 20, all or nothing),
//                                        or a single { key, value }; optional { via: 'ui' | 'mcp' }
//   POST /api/settings/reset             { key } or { group }; optional { via }
//
// Reads need a loopback Host. Writes also need the studio Origin and `X-Forge-Request: settings`
// (the same checks as /api/errors and /api/ai-assist), a body of at most 8 KiB, no unknown fields
// and at most 30 writes a minute. Credentials, consent, security checks, network exposure,
// folders, executables and destructive actions are not settings and cannot be reached here.
import { parsePreference } from './i18n-service.js';
import { createTranslationStore } from './i18n-store.js';
import { powerControl } from './power.js';
import {
  CHANGE_SOURCES,
  MAX_SETTING_CHANGES,
  SETTING_GROUPS,
  SettingsError,
  createSettings,
  defaultSettingsDirectory,
} from './core-settings.js';
import { createLogger, routeTemplate } from './app-log.js';

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const MAX_BODY_BYTES = 8 * 1024;
const WRITE_FIELDS = new Set(['changes', 'key', 'value', 'via']);
const RESET_FIELDS = new Set(['key', 'group', 'via']);
const log = createLogger('settings');

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new SettingsError(413, 'too_large', 'Request is too large.');
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
    throw new SettingsError(400, 'invalid_request', 'Invalid request.');
  }
}

function rejectUnknownFields(input, allowed) {
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      throw new SettingsError(400, 'unknown_field', `Unknown field: ${field.slice(0, 40)}.`);
    }
  }
}

function parseVia(input) {
  const via = input.via ?? 'ui';
  if (!CHANGE_SOURCES.includes(via)) {
    throw new SettingsError(400, 'invalid_request', 'via must be ui or mcp.');
  }
  return via;
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

/**
 * @param {object} [options] Overrides for tests: runtime folder, environment, an existing
 *   settings store, the adapters for keep awake and the language, and the write rate limit.
 */
export function settingsService({
  runtimeDir = defaultSettingsDirectory(),
  env = process.env,
  settings: provided,
  power,
  language,
  writeLimitPerMinute = 30,
  now = () => Date.now(),
} = {}) {
  let logger = null;
  let translationStore = null;
  const allowWrite = createRateLimiter({ limit: writeLimitPerMinute, windowMs: 60000, now });

  function preferenceStore() {
    translationStore ||= createTranslationStore({ directory: runtimeDir });
    return translationStore;
  }

  // Keep awake is owned by runtime/power.js; the language preference by the i18n store.
  const adapters = {
    power: power ?? {
      get: () => powerControl()?.status().awake ?? false,
      async set(enabled) {
        const control = powerControl();
        if (!control) {
          throw new SettingsError(503, 'unavailable', 'The keep-awake service is not running.');
        }
        await control.setAwake(enabled);
      },
    },
    language: language ?? {
      get: () => preferenceStore().getPreference(),
      set(value) {
        if (value === null) {
          preferenceStore().clearPreference();
        } else {
          preferenceStore().setPreference(value);
        }
      },
      normalize: (value) => parsePreference(value),
    },
  };

  const settings =
    provided ??
    createSettings({
      directory: runtimeDir,
      env,
      adapters,
      // The audit table is the durable record; this line is for the console and Diagnostics.
      onChange: ({ via, changes }) =>
        logger?.info?.(
          JSON.stringify({ source: 'settings', event: 'settings_changed', via, changes }),
        ),
    });

  function snapshot(group) {
    return {
      groups: SETTING_GROUPS,
      settings: settings.list({ group }),
      recentChanges: settings.recentChanges(10),
    };
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET') {
      if (pathname !== '/') {
        return json(res, 404, { error: 'Not found.' });
      }
      for (const name of url.searchParams.keys()) {
        if (name !== 'group') {
          throw new SettingsError(400, 'unknown_field', `Unknown parameter: ${name.slice(0, 40)}.`);
        }
      }
      return json(res, 200, snapshot(url.searchParams.get('group') ?? undefined));
    }
    const isReset = pathname === '/reset';
    const isWrite = pathname === '/' && (req.method === 'POST' || req.method === 'PATCH');
    if (!isWrite && !(isReset && req.method === 'POST')) {
      return json(res, pathname === '/' || isReset ? 405 : 404, {
        error: pathname === '/' || isReset ? 'Method not allowed.' : 'Not found.',
      });
    }
    if (
      req.headers.origin !== `http://${req.headers.host}` ||
      req.headers['x-forge-request'] !== 'settings'
    ) {
      log.warn('settings.request.rejected', {
        route: routeTemplate(req.url),
        status: 403,
        reason: 'origin_check',
      });
      return json(res, 403, { error: 'Local studio requests only.' });
    }
    const input = await readJson(req);
    if (!allowWrite()) {
      log.warn('settings.request.rejected', {
        route: routeTemplate(req.url),
        status: 429,
        reason: 'rate_limited',
      });
      return json(res, 429, { error: 'Too many settings changes. Try again in a minute.' });
    }
    if (isReset) {
      rejectUnknownFields(input, RESET_FIELDS);
      const outcome = await settings.reset(
        { key: input.key, group: input.group },
        { via: parseVia(input) },
      );
      return json(res, 200, { ...outcome, ...snapshot() });
    }
    rejectUnknownFields(input, WRITE_FIELDS);
    const hasSingle = Object.hasOwn(input, 'key') || Object.hasOwn(input, 'value');
    if (hasSingle === Object.hasOwn(input, 'changes')) {
      throw new SettingsError(400, 'invalid_request', 'Send either changes or a key and value.');
    }
    const changes = hasSingle ? [{ key: input.key, value: input.value }] : input.changes;
    if (Array.isArray(changes) && changes.length > MAX_SETTING_CHANGES) {
      throw new SettingsError(
        400,
        'invalid_request',
        `Send at most ${MAX_SETTING_CHANGES} changes at once.`,
      );
    }
    const outcome = await settings.set(changes, { via: parseVia(input) });
    return json(res, 200, { ...outcome, ...snapshot() });
  }

  function guarded(handler) {
    return async (req, res) => {
      if (!LOOPBACK_HOST.test(req.headers.host || '')) {
        log.warn('settings.request.rejected', {
          route: routeTemplate(req.url),
          status: 403,
          reason: 'host_check',
        });
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      try {
        await handler(req, res);
      } catch (failure) {
        if (res.headersSent || res.destroyed) {
          return;
        }
        if (failure instanceof SettingsError) {
          log.warn('settings.request.rejected', {
            route: routeTemplate(req.url),
            status: failure.status,
            reason: failure.code,
          });
          return json(res, failure.status, {
            error: failure.message,
            code: failure.code,
            ...(failure.problems.length ? { problems: failure.problems } : {}),
          });
        }
        // Unexpected failures return a generic message; details stay out of the response.
        log.error('settings.request.failed', {
          route: routeTemplate(req.url),
          errorClass: failure?.name,
          errorCode: failure?.code,
        });
        logger?.error?.(`Settings request failed: ${failure.message}`);
        json(res, 500, { error: 'The settings service failed. Check Diagnostics.' });
      }
    };
  }

  function attach(server) {
    logger = server.config?.logger ?? null;
    // log-coverage: ignore -- rejections and failures are logged inside guarded(), not here
    server.middlewares.use('/api/settings', guarded(route));
    server.httpServer?.once('close', () => {
      translationStore?.close();
      translationStore = null;
    });
  }

  return {
    name: 'forge-settings',
    configureServer: attach,
    configurePreviewServer: attach,
    settings,
  };
}
