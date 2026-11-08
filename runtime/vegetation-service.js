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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const FEATURE = 'vegetation-describe';

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
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
    } catch {
      return false;
    }
  }

  async function localChatRunning() {
    try {
      const response = await fetchImpl(new URL('health', `${localChatUrl}/`), {
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      return response.ok;
    } catch {
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
    fetching = (async () => {
      try {
        await fetchCheckout({ root, onStep: (step) => (fetchState.step = step) });
        fetchState.step = 'Done';
      } catch (failure) {
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
      return send(res, 403, { error: 'Local studio requests only.' });
    }
    if (pathname === '/status' && !isWrite) {
      return send(res, 200, {
        checkout: await inspect({
          root,
          directory: checkoutDirectory({ root }),
          linked: readLinkedRepository({ root }),
        }),
        fetch: { ...fetchState },
        describe: await describeStatus(),
      });
    }
    if (pathname === '/schema' && !isWrite) {
      const quick = quickCheckoutStatus({ root });
      if (!quick.ready) {
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
      try {
        const result = await verifyModel({
          model: choice.model,
          key: await savedKey(),
          fetchImpl,
          baseUrl: openaiBaseUrl,
        });
        return send(res, 200, result);
      } catch (failure) {
        if (failure instanceof ProviderError) {
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
        return send(res, 200, { suggestion });
      } catch (failure) {
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
        return send(res, 403, { error: 'Local studio requests only.' });
      }
      try {
        await route(req, res);
      } catch (failure) {
        if (res.headersSent || res.destroyed) {
          return undefined;
        }
        if (failure instanceof RequestError) {
          return send(res, failure.status, {
            error: failure.message,
            ...(failure.code ? { code: failure.code } : {}),
          });
        }
        console.error('Vegetation service:', failure.message);
        return send(res, 500, { error: 'The Vegetation service could not complete this request.' });
      }
      return undefined;
    });
  }
  return { name: 'forge-vegetation', configureServer: attach, configurePreviewServer: attach };
}
