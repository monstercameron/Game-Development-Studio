// HTTP routes for the Vegetation page under /api/vegetation (loopback only).
//
//   GET  /status          SeedThree checkout state, the running fetch, and "Describe it" status
//   GET  /schema          species, controls, budgets and measured triangle counts (when ready)
//   POST /fetch           explicit Fetch/Update of the pinned SeedThree checkout (single flight)
//   POST /describe        description -> suggested settings (never queues anything)
//   POST /describe/check  asks OpenAI whether the configured model id exists
//
// Nothing here is called as a side effect of a render. Writes need the studio Origin and
// `X-Forge-Request: vegetation`. Jobs themselves go through /api/runtime/jobs like every other
// render. The OpenAI key is read from the credential store for one request and never returned.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiAssistSettings } from './ai-assist-settings.js';
import { credentialStore } from './credentials.js';
import { OPENAI_BASE_URL, ProviderError, verifyModel } from './error-fix.js';
import {
  CheckoutError,
  checkoutDirectory,
  fetchSeedThree,
  inspectCheckout,
  readLinkedRepository,
} from './vegetation-checkout.js';
import {
  DESCRIBE_NOTICE_LOCAL,
  DESCRIBE_NOTICE_OPENAI,
  DESCRIPTION_MAX_CHARS,
  DescribeError,
  LOCAL_CHAT_URL,
  describePlant,
} from './vegetation-describe.js';
import {
  VegetationUnavailableError,
  loadMeasuredBudgets,
  loadSchemaSync,
  quickCheckoutStatus,
} from './vegetation-runner.js';
import { createLogger } from './app-log.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const FEATURE = 'vegetation-describe';
const log = createLogger('vegetation');

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

// Error details that may be logged: the class and code only. Messages can contain paths or
// provider text, so they are never passed to the logger.
function errorFields(failure) {
  return { errorClass: failure?.constructor?.name, errorCode: failure?.code };
}

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    // log-coverage: ignore -- stores the HTTP status on an error object, not a state change
    this.status = status;
    this.code = code;
  }
}

async function readJson(req, limit = 8192) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) {
      throw new RequestError(413, 'Request is too large.');
    }
  }
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new RequestError(400, 'Invalid request body.');
  }
}

function isLocalWrite(req) {
  return (
    req.headers.origin === `http://${req.headers.host}` &&
    req.headers['x-forge-request'] === 'vegetation'
  );
}

/**
 * @param {object} options Overrides for tests: the credential store, fetch, URLs, settings, and
 *   the functions that inspect or fetch the checkout.
 */
export function vegetationService({
  root = appRoot,
  runtimeDir = process.env.FORGE_RUNTIME_DIR || path.join(appRoot, '.forge-runtime'),
  credentials = credentialStore,
  fetchImpl = fetch,
  openaiBaseUrl = OPENAI_BASE_URL,
  localChatUrl = LOCAL_CHAT_URL,
  aiAssistSettings,
  inspect = inspectCheckout,
  fetchCheckout = fetchSeedThree,
  loadSchema = loadSchemaSync,
  loadMeasured = loadMeasuredBudgets,
  describe = describePlant,
} = {}) {
  const settings = aiAssistSettings || createAiAssistSettings({ directory: runtimeDir });
  const fetchState = { running: false, step: '', error: '', finishedAt: null };
  let fetching = null;

  function hasSavedKey() {
    try {
      return credentials.status().some((item) => item.provider === 'openai' && item.saved);
    } catch (failure) {
      log.warn('vegetation.key.status.failed', {
        ...errorFields(failure),
        reason: 'treated_as_missing',
      });
      return false;
    }
  }

  async function localChatRunning() {
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(new URL('health', `${localChatUrl}/`), {
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      log.debug('vegetation.local-chat.health.completed', {
        httpStatus: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });
      return response.ok;
    } catch (failure) {
      log.debug('vegetation.local-chat.health.failed', {
        ...errorFields(failure),
        durationMs: Date.now() - startedAt,
      });
      return false;
    }
  }

  async function describeStatus() {
    const choice = settings.get(FEATURE);
    const hasKey = hasSavedKey();
    const usesOpenAI = choice.provider === 'openai';
    return {
      provider: choice.provider,
      model: choice.model,
      hasOpenAIKey: hasKey,
      // Reading the local engine's health is harmless; starting it is always the person's choice.
      localChatRunning: usesOpenAI ? null : await localChatRunning(),
      notice: usesOpenAI ? DESCRIBE_NOTICE_OPENAI : DESCRIBE_NOTICE_LOCAL,
      maxChars: DESCRIPTION_MAX_CHARS,
      state: usesOpenAI ? (hasKey ? 'ready' : 'needs_key') : 'local',
    };
  }

  async function savedKey() {
    let key;
    try {
      key = await credentials.get('openai');
    } catch {
      throw new RequestError(
        500,
        'Could not unlock the saved OpenAI key. Check that the studio runs under the Windows account that saved it.',
      );
    }
    if (!key) {
      throw new RequestError(400, 'Add your OpenAI key in Settings to use Describe it.', 'no_key');
    }
    return key;
  }

  function startFetch() {
    if (fetching) {
      return fetching;
    }
    fetchState.running = true;
    fetchState.step = 'Starting';
    fetchState.error = '';
    log.info('vegetation.checkout.fetch.started');
    const startedAt = Date.now();
    fetching = (async () => {
      try {
        await fetchCheckout({
          root,
          onStep: (step) => {
            fetchState.step = step;
          },
        });
        fetchState.step = 'Done';
        log.info('vegetation.checkout.fetch.completed', { durationMs: Date.now() - startedAt });
      } catch (failure) {
        if (failure instanceof CheckoutError) {
          log.warn('vegetation.checkout.fetch.failed', {
            ...errorFields(failure),
            reason: failure.code,
            durationMs: Date.now() - startedAt,
          });
        } else {
          log.error('vegetation.checkout.fetch.failed', {
            ...errorFields(failure),
            durationMs: Date.now() - startedAt,
          });
        }
        fetchState.error =
          failure instanceof CheckoutError
            ? failure.message
            : `Fetching failed: ${failure.message}`;
      } finally {
        fetchState.running = false;
        fetchState.finishedAt = new Date().toISOString();
        fetching = null;
      }
    })();
    return fetching;
  }

  async function route(req, res) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
    const isWrite = req.method === 'POST';
    if (!isWrite && req.method !== 'GET') {
      return send(res, 405, { error: 'Method not allowed.' });
    }
    if (isWrite && !isLocalWrite(req)) {
      log.warn('vegetation.request.rejected', {
        method: req.method,
        status: 403,
        reason: 'not_studio_origin',
      });
      return send(res, 403, { error: 'Local studio requests only.' });
    }
    if (pathname === '/status' && !isWrite) {
      const checkout = await inspect({
        root,
        directory: checkoutDirectory({ root }),
        linked: readLinkedRepository({ root }),
      });
      log.debug('vegetation.checkout.inspected', { state: checkout.state });
      return send(res, 200, {
        checkout,
        fetch: { ...fetchState },
        describe: await describeStatus(),
      });
    }
    if (pathname === '/schema' && !isWrite) {
      const quick = quickCheckoutStatus({ root });
      if (!quick.ready) {
        log.debug('vegetation.schema.unavailable', { reason: quick.code });
        return send(res, 409, { error: quick.message, code: quick.code });
      }
      try {
        const schema = loadSchema({ root });
        const measured = await loadMeasured({ root }).catch(() => null);
        return send(res, 200, { schema, measured });
      } catch (failure) {
        if (failure instanceof VegetationUnavailableError) {
          return send(res, 409, { error: failure.message, code: failure.code });
        }
        throw failure;
      }
    }
    if (pathname === '/fetch' && isWrite) {
      startFetch();
      return send(res, 202, { fetch: { ...fetchState } });
    }
    if (pathname === '/describe' && !isWrite) {
      return send(res, 200, await describeStatus());
    }
    if (pathname === '/describe/check' && isWrite) {
      const choice = settings.get(FEATURE);
      if (choice.provider !== 'openai') {
        return send(res, 200, {
          exists: null,
          message: 'The local chat model has no model id to check.',
        });
      }
      if (!hasSavedKey()) {
        return send(res, 200, {
          exists: null,
          code: 'no_key',
          message: 'Add your OpenAI key in Settings to check this model.',
        });
      }
      const stopCheck = log.time('vegetation.model.check.completed', { provider: 'openai' });
      try {
        const result = await verifyModel({
          model: choice.model,
          key: await savedKey(),
          fetchImpl,
          baseUrl: openaiBaseUrl,
        });
        stopCheck({ outcome: 'completed' });
        return send(res, 200, result);
      } catch (failure) {
        if (failure instanceof ProviderError) {
          log.warn('vegetation.model.check.failed', {
            provider: 'openai',
            status: failure.status,
          });
          return send(res, failure.status >= 400 ? failure.status : 502, {
            error: failure.message,
          });
        }
        throw failure;
      }
    }
    if (pathname === '/describe' && isWrite) {
      const input = await readJson(req);
      const quick = quickCheckoutStatus({ root });
      if (!quick.ready) {
        throw new RequestError(409, quick.message, quick.code);
      }
      const choice = settings.get(FEATURE);
      const key = choice.provider === 'openai' ? await savedKey() : '';
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const startedAt = Date.now();
      log.info('vegetation.describe.started', { provider: choice.provider, model: choice.model });
      try {
        const suggestion = await describe({
          description: input.description,
          species: typeof input.species === 'string' ? input.species : null,
          schema: loadSchema({ root }),
          provider: choice.provider,
          model: choice.model,
          key,
          fetchImpl,
          openaiBaseUrl,
          localUrl: localChatUrl,
          signal: abort.signal,
        });
        log.info('vegetation.describe.completed', {
          provider: choice.provider,
          durationMs: Date.now() - startedAt,
        });
        return send(res, 200, { suggestion });
      } catch (failure) {
        if (abort.signal.aborted) {
          // The browser closed the request; the rejected promise is expected, not an error.
          log.info('vegetation.describe.cancelled', { durationMs: Date.now() - startedAt });
        }
        if (failure instanceof DescribeError) {
          throw new RequestError(failure.status, failure.message, failure.code);
        }
        throw failure;
      }
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function attach(server) {
    server.middlewares.use('/api/vegetation', async (req, res) => {
      if (!LOOPBACK_HOST.test(req.headers.host || '')) {
        log.warn('vegetation.request.rejected', {
          method: req.method,
          status: 403,
          reason: 'not_loopback',
        });
        return send(res, 403, { error: 'Local studio requests only.' });
      }
      try {
        await route(req, res);
      } catch (failure) {
        if (res.headersSent || res.destroyed) {
          return undefined;
        }
        if (failure instanceof RequestError && failure.status < 500) {
          log.warn('vegetation.request.rejected', {
            method: req.method,
            status: failure.status,
            reason: failure.code || 'invalid_request',
          });
          return send(res, failure.status, {
            error: failure.message,
            ...(failure.code ? { code: failure.code } : {}),
          });
        }
        if (failure instanceof RequestError) {
          log.error('vegetation.request.failed', {
            method: req.method,
            status: failure.status,
            reason: failure.code || 'unknown',
          });
          return send(res, failure.status, {
            error: failure.message,
            ...(failure.code ? { code: failure.code } : {}),
          });
        }
        log.error('vegetation.request.failed', {
          ...errorFields(failure),
          method: req.method,
          status: 500,
        });
        return send(res, 500, { error: 'The Vegetation service could not complete this request.' });
      }
      return undefined;
    });
  }
  return { name: 'forge-vegetation', configureServer: attach, configurePreviewServer: attach };
}
