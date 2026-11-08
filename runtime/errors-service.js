// Errors review service: /api/errors on the studio host. It collects errors from the browser,
// the render queue, the studio server and engine logs into .forge-runtime/errors.sqlite, and
// offers two explicit, previewed outbound actions: an OpenAI fix suggestion (key from the
// existing credential store, used only in this process) and a GitHub issue through `gh`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiAssistSettings, validateAiAssistEntry } from './ai-assist-settings.js';
import { createLogger } from './app-log.js';
import { credentialStore } from './credentials.js';
import { buildIssueContent } from './error-format.js';
import {
  OPENAI_BASE_URL,
  ProviderError,
  buildFixRequest,
  digestOf,
  extractSourceContext,
  requestFixSuggestion,
  verifyModel,
} from './error-fix.js';
import { GitHubError, createGitHubClient } from './error-issues.js';
import { expandPlaceholders, redactText } from './error-redaction.js';
import { scanJobs, scanLogs } from './error-scanner.js';
import { ERROR_STATUSES, FIX_SOURCES, createErrorStore } from './error-store.js';
import { createErrorTestRoutes } from './errors-test-routes.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const REPORT_KINDS = ['error', 'rejection', 'boundary', 'fetch', 'notice'];
const REPORT_KEYS = new Set(['kind', 'message', 'stack', 'componentStack', 'page', 'context']);
const CONTEXT_KEYS = new Set(['method', 'path', 'status', 'name', 'boundary']);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
export const FIX_NOTICE =
  'The redacted error text and the listed source lines are sent to OpenAI. Nothing else is sent.';
export const ISSUE_NOTICE = 'This will be posted publicly on GitHub as';
const log = createLogger('errors');
// Reason codes for rejections that carry no code of their own. They describe the rule, never
// the rejected value.
const REJECTION_REASONS = Object.freeze({
  400: 'invalid_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  429: 'rate_limited',
});

// Log fields carry only the class and code of a failure, never its message or stack.
function failureFields(error) {
  return { errorClass: error?.name, errorCode: error?.code };
}

// Numeric ids become :id and any segment that is not a plain word becomes :param, so a log
// line never holds a user-supplied path segment or a query string.
function routeTemplate(prefix, pathname) {
  const segments = pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (/^\d{1,12}$/.test(segment)) {
        return ':id';
      }
      return /^[a-z-]{1,40}$/.test(segment) ? segment : ':param';
    });
  return [prefix, ...segments].join('/');
}

function logRejected(route, status, reason) {
  log.warn('errors.request.rejected', { route, status, reason });
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

class RequestError extends Error {
  constructor(status, message, code) {
    super(message);
    // log-coverage: ignore -- stores the HTTP status on the error object; not a state change
    this.status = status;
    this.code = code;
  }
}

async function readJson(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
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

function optionalString(value, name, limit) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string' || value.length > limit) {
    throw new RequestError(400, `${name} must be text of at most ${limit} characters.`);
  }
  return value;
}

/** Validates one browser report. Unknown fields are rejected rather than stored. */
export function parseBrowserReport(input) {
  for (const key of Object.keys(input)) {
    if (!REPORT_KEYS.has(key)) {
      throw new RequestError(400, `Unknown report field: ${key.slice(0, 40)}.`);
    }
  }
  if (!REPORT_KINDS.includes(input.kind)) {
    throw new RequestError(400, 'Choose a valid report kind.');
  }
  const message = optionalString(input.message, 'message', 4000).trim();
  if (!message) {
    throw new RequestError(400, 'A message is required.');
  }
  const stack = optionalString(input.stack, 'stack', 40000);
  const componentStack = optionalString(input.componentStack, 'componentStack', 16000);
  let page = optionalString(input.page, 'page', 500);
  // Only the route path is kept; query strings can carry search text or asset names.
  page = page.startsWith('/') ? page.split(/[?#]/)[0].slice(0, 300) : '';
  const context = { kind: input.kind };
  if (input.context !== undefined) {
    if (!input.context || typeof input.context !== 'object' || Array.isArray(input.context)) {
      throw new RequestError(400, 'context must be an object.');
    }
    for (const [key, value] of Object.entries(input.context)) {
      if (!CONTEXT_KEYS.has(key)) {
        throw new RequestError(400, `Unknown context field: ${key.slice(0, 40)}.`);
      }
      if (key === 'status') {
        if (!Number.isInteger(value) || value < 0 || value > 599) {
          throw new RequestError(400, 'context.status must be an HTTP status.');
        }
        // log-coverage: ignore -- copies a validated HTTP status into a response context object
        context.status = value;
      } else if (key === 'method') {
        if (!HTTP_METHODS.includes(value)) {
          throw new RequestError(400, 'context.method must be an HTTP method.');
        }
        context.method = value;
      } else if (key === 'path') {
        const text = optionalString(value, 'context.path', 300);
        if (!text.startsWith('/api/')) {
          throw new RequestError(400, 'context.path must be a studio API path.');
        }
        context.path = text.split(/[?#]/)[0];
      } else {
        context[key] = optionalString(value, `context.${key}`, 100);
      }
    }
  }
  return {
    source: 'browser',
    kind: input.kind,
    message,
    stack: componentStack ? `${stack}\n\nComponent stack:${componentStack}` : stack,
    page,
    context,
  };
}

// Vite logs errors as logger.error(text, { error }) and often puts the stack in the text. Colors
// are removed, and the first stack frame starts the stack so the message stays one short line.
const ESCAPE = String.fromCharCode(27);
const ANSI_COLORS = new RegExp(`${ESCAPE}\\[[0-9;]*m`, 'g');
const STACK_FRAME = /^\s+at\s\S/;

export function describeLoggedError(message, options) {
  const lines = message.replace(ANSI_COLORS, '').slice(0, 4000).split('\n');
  const firstFrame = lines.findIndex((line) => STACK_FRAME.test(line));
  if (firstFrame > 0) {
    return {
      message: lines.slice(0, firstFrame).join('\n').trim() || lines[0],
      stack: lines.slice(Math.max(0, firstFrame - 1)).join('\n'),
    };
  }
  const attached = options && typeof options === 'object' ? options.error : null;
  return {
    message: lines.join('\n'),
    ...(attached instanceof Error && attached.stack ? { stack: attached.stack } : {}),
  };
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

function readAppVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch (error) {
    log.debug('errors.version.read.failed', failureFields(error));
    return 'unknown';
  }
}

function defaultRoots(runtimeDir, projectsRoot) {
  let user;
  try {
    user = os.userInfo().username;
  } catch (error) {
    // Some service accounts have no user record; home-folder redaction still applies.
    log.debug('errors.user.lookup.failed', failureFields(error));
    user = '';
  }
  return {
    repo: repositoryRoot,
    projects: projectsRoot,
    runtime: runtimeDir,
    home: os.homedir(),
    user,
  };
}

/**
 * @param {object} options Overrides for tests: directories, the credential store, fetch, the
 *   OpenAI base URL, the GitHub client, scan interval (0 disables the timer), rate limits and
 *   testRoutes (options for /api/errors/test/*, or false to turn those routes off).
 */
export function errorsService({
  runtimeDir = process.env.FORGE_RUNTIME_DIR || path.join(repositoryRoot, '.forge-runtime'),
  projectsRoot = process.env.FORGE_PROJECTS_DIR || path.join(repositoryRoot, 'projects'),
  repoRoot = repositoryRoot,
  roots,
  credentials = credentialStore,
  fetchImpl = fetch,
  openaiBaseUrl = OPENAI_BASE_URL,
  github,
  aiAssistSettings,
  scanIntervalMs = 20000,
  reportLimitPerMinute = 60,
  fixTimeoutMs,
  testRoutes = {},
  environment,
  now = () => Date.now(),
} = {}) {
  let store = null;
  let timer = null;
  let scanning = null;
  let lastScanAt = 0;
  let scanProblems = [];
  let hostLogger = null;
  const localRoots = roots || defaultRoots(runtimeDir, projectsRoot);
  const env = environment || {
    appVersion: readAppVersion(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };
  const gitHub = github || createGitHubClient({ repoRoot });
  const aiSettings = aiAssistSettings || createAiAssistSettings({ directory: runtimeDir });
  const fixSettings = () => aiSettings.get('error-fix');
  const allowReport = createRateLimiter({ limit: reportLimitPerMinute, windowMs: 60000, now });

  function getStore() {
    store ||= createErrorStore({ directory: runtimeDir, roots: localRoots });
    return store;
  }

  const handleTestRoute =
    testRoutes === false
      ? null
      : createErrorTestRoutes({
          getStore,
          getLogger: () => hostLogger,
          // A scan that was already running may have read the log before the helper wrote to it.
          scan: async () => {
            await scan();
            await scan();
          },
          runtimeDir,
          repoRoot,
          now,
          ...testRoutes,
        });

  function scan() {
    scanning ||= (async () => {
      try {
        const errorStore = getStore();
        const logs = await scanLogs(errorStore, { runtimeDir, now });
        const jobs = scanJobs(errorStore, { jobsFile: path.join(runtimeDir, 'jobs.sqlite'), now });
        scanProblems = [...logs.problems, ...jobs.problems].slice(0, 20);
        errorStore.prune();
      } catch (error) {
        log.warn('errors.scan.failed', failureFields(error));
        scanProblems = [`scan: ${error.code || 'failed'}`];
      } finally {
        lastScanAt = now();
        scanning = null;
      }
    })();
    return scanning;
  }

  async function freshScan() {
    if (now() - lastScanAt > 5000) {
      await scan();
    }
  }

  // Display-time redaction runs again so rows stored by an older rule set are covered too.
  function present(error, { includePaths = false } = {}) {
    const clean = (text) => {
      const redacted = redactText(text, localRoots);
      return includePaths ? expandPlaceholders(redacted, localRoots) : redacted;
    };
    const context = Object.fromEntries(
      Object.entries(error.context || {}).map(([key, value]) => [
        key,
        typeof value === 'string' ? clean(value) : value,
      ]),
    );
    return {
      ...error,
      message: clean(error.message),
      stack: clean(error.stack),
      page: error.page ? clean(error.page) : null,
      note: clean(error.note),
      fixNote: clean(error.fixNote),
      suggestion: clean(error.suggestion),
      context,
      includesPaths: includePaths,
    };
  }

  function requireError(id) {
    const error = getStore().get(id);
    if (!error) {
      throw new RequestError(404, 'This error no longer exists. It may have been cleared.');
    }
    return error;
  }

  function hasSavedKey() {
    try {
      return credentials.status().some((item) => item.provider === 'openai' && item.saved);
    } catch (error) {
      log.warn('errors.key.status.failed', failureFields(error));
      return false;
    }
  }

  async function savedKey() {
    let key;
    try {
      key = await credentials.get('openai');
    } catch (error) {
      log.warn('errors.key.unlock.failed', failureFields(error));
      throw new RequestError(
        500,
        'Could not unlock the saved OpenAI key. Check that the studio runs under the Windows account that saved it.',
      );
    }
    if (!key) {
      throw new RequestError(400, 'Add your OpenAI key in Settings to ask for a fix.', 'no_key');
    }
    return key;
  }

  function saveAiSetting(entry) {
    try {
      return aiSettings.set(entry);
    } catch (failure) {
      throw new RequestError(400, failure.message);
    }
  }

  // Shared AI assist settings (all features), used by the Settings dialog.
  async function aiAssistRoute(req, res) {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
    if (pathname !== '/settings') {
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'GET') {
      return json(res, 200, { features: aiSettings.list(), hasOpenAIKey: hasSavedKey() });
    }
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if (
      req.headers.origin !== `http://${req.headers.host}` ||
      req.headers['x-forge-request'] !== 'ai-assist'
    ) {
      logRejected(routeTemplate('/api/ai-assist', pathname), 403, 'origin_mismatch');
      return json(res, 403, { error: 'Local studio requests only.' });
    }
    const input = await readJson(req, 4096);
    return json(res, 200, { feature: saveAiSetting(input) });
  }

  function fixPreview(id) {
    const error = present(requireError(id));
    const sourceContext = extractSourceContext(error.stack, { repoRoot, roots: localRoots });
    const body = buildFixRequest(error, {
      model: fixSettings().model,
      environment: env,
      sourceContext,
    });
    return {
      body,
      digest: digestOf(body),
      sourceFiles: sourceContext.map(({ path: file, startLine, endLine }) => ({
        path: file,
        startLine,
        endLine,
      })),
      notice: FIX_NOTICE,
    };
  }

  async function issuePreview(id) {
    const error = present(requireError(id));
    if (error.status !== 'verified') {
      throw new RequestError(409, 'Mark the fix as worked before creating a GitHub issue.');
    }
    const content = buildIssueContent(error, env);
    let repo = null;
    try {
      repo = await gitHub.repository();
      await gitHub.authStatus();
      const duplicates = await gitHub.findDuplicates(repo, error.fingerprint);
      const labels = (await gitHub.hasLabel(repo, 'bug')) ? ['bug'] : [];
      const preview = { repo: repo.slug, title: content.title, body: content.body, labels };
      return {
        available: true,
        ...preview,
        duplicates,
        digest: digestOf(preview),
        notice: `${ISSUE_NOTICE} ${repo.slug}.`,
      };
    } catch (failure) {
      if (failure instanceof GitHubError) {
        return {
          available: false,
          code: failure.code,
          message: failure.message,
          repo: repo?.slug || null,
          title: content.title,
          body: content.body,
          labels: [],
          duplicates: [],
        };
      }
      throw failure;
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const errorStore = getStore();
    if (req.method === 'GET') {
      if (pathname === '/summary') {
        await freshScan();
        return json(res, 200, { ...errorStore.summary(), scanProblems });
      }
      if (pathname === '/') {
        await freshScan();
        const status = url.searchParams.get('status') || '';
        const source = url.searchParams.get('source') || '';
        if (status && !ERROR_STATUSES.includes(status)) {
          throw new RequestError(400, 'Choose a valid status.');
        }
        if (
          source &&
          !['browser', 'queue', 'server', 'engine'].includes(source) &&
          !/^engine:[a-z0-9-]{1,40}$/.test(source)
        ) {
          throw new RequestError(400, 'Choose a valid source.');
        }
        const result = errorStore.list({
          status,
          source,
          query: url.searchParams.get('q') || '',
          limit: Number(url.searchParams.get('limit')) || 100,
          offset: Number(url.searchParams.get('offset')) || 0,
        });
        return json(res, 200, {
          ...result,
          errors: result.errors.map((error) => ({
            ...error,
            message: redactText(error.message, localRoots),
          })),
          summary: errorStore.summary(),
          scanProblems,
        });
      }
      if (pathname === '/export') {
        const status = url.searchParams.get('status') || 'new';
        if (!ERROR_STATUSES.includes(status)) {
          throw new RequestError(400, 'Choose a valid status.');
        }
        const ids = errorStore.list({ status, limit: 50 }).errors.map((error) => error.id);
        return json(res, 200, { errors: ids.map((id) => present(errorStore.get(id))) });
      }
      if (pathname === '/settings') {
        const settings = fixSettings();
        return json(res, 200, { ...settings, hasKey: hasSavedKey() });
      }
      const detail = /^\/(\d{1,12})$/.exec(pathname);
      if (detail) {
        const error = requireError(Number(detail[1]));
        return json(res, 200, {
          error: present(error, { includePaths: url.searchParams.get('includePaths') === '1' }),
        });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed.' });
    }
    if (
      req.headers.origin !== `http://${req.headers.host}` ||
      req.headers['x-forge-request'] !== 'errors'
    ) {
      logRejected(routeTemplate('/api/errors', pathname), 403, 'origin_mismatch');
      return json(res, 403, { error: 'Local studio requests only.' });
    }
    if (pathname === '/report') {
      const input = await readJson(req, 64 * 1024);
      const report = parseBrowserReport(input);
      if (!allowReport()) {
        logRejected(routeTemplate('/api/errors', pathname), 429, 'rate_limited');
        return json(res, 429, { error: 'Too many error reports. Some were dropped.' });
      }
      const result = errorStore.record(report);
      return json(res, 200, { id: result.id, created: result.created });
    }
    if (pathname.startsWith('/test/')) {
      if (!handleTestRoute) {
        return json(res, 404, { error: 'Not found.' });
      }
      const result = await handleTestRoute(pathname, await readJson(req, 4096), {
        remoteAddress: req.socket?.remoteAddress,
      });
      return json(res, result.status, result.data);
    }
    const input = await readJson(req, 16 * 1024);
    if (pathname === '/opened') {
      errorStore.markOpened();
      return json(res, 200, { ok: true });
    }
    if (pathname === '/clear') {
      if (input.confirm !== 'clear' || !Array.isArray(input.statuses)) {
        throw new RequestError(400, 'Confirm which statuses to clear.');
      }
      const statuses = input.statuses.filter((status) =>
        ['resolved', 'ignored', 'verified'].includes(status),
      );
      if (!statuses.length || statuses.length !== input.statuses.length) {
        throw new RequestError(400, 'Only resolved, verified or ignored errors can be cleared.');
      }
      return json(res, 200, { removed: errorStore.clear(statuses) });
    }
    if (pathname === '/settings') {
      const settings = saveAiSetting({
        feature: 'error-fix',
        provider: input.provider ?? fixSettings().provider,
        model: input.model,
      });
      return json(res, 200, { ...settings, hasKey: hasSavedKey() });
    }
    if (pathname === '/settings/verify-model') {
      const model = input.model === undefined ? fixSettings().model : input.model;
      try {
        validateAiAssistEntry({ feature: 'error-fix', provider: 'openai', model });
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
      const key = await savedKey();
      return json(res, 200, await verifyModel({ model, key, fetchImpl, baseUrl: openaiBaseUrl }));
    }
    const action = /^\/(\d{1,12})\/([a-z-]+)$/.exec(pathname);
    if (!action) {
      return json(res, 404, { error: 'Not found.' });
    }
    const id = Number(action[1]);
    const name = action[2];
    if (name === 'viewed') {
      requireError(id);
      errorStore.markReviewed(id);
      return json(res, 200, { error: present(errorStore.get(id)) });
    }
    if (name === 'status') {
      requireError(id);
      if (!ERROR_STATUSES.includes(input.status)) {
        throw new RequestError(400, 'Choose a valid status.');
      }
      if (
        input.status === 'verified' &&
        input.fixSource !== undefined &&
        !FIX_SOURCES.includes(input.fixSource)
      ) {
        throw new RequestError(400, 'Choose who fixed the error.');
      }
      errorStore.setStatus(id, input.status, {
        fixNote: optionalString(input.fixNote, 'fixNote', 4000),
        fixSource: input.fixSource,
      });
      return json(res, 200, { error: present(errorStore.get(id)) });
    }
    if (name === 'note') {
      requireError(id);
      errorStore.setNote(id, optionalString(input.note, 'note', 4000));
      return json(res, 200, { error: present(errorStore.get(id)) });
    }
    if (name === 'delete') {
      if (input.confirm !== 'delete') {
        throw new RequestError(400, 'Confirm the deletion.');
      }
      return json(res, 200, { removed: errorStore.remove(id) });
    }
    if (name === 'fix-preview') {
      return json(res, 200, { ...fixPreview(id), hasKey: hasSavedKey() });
    }
    if (name === 'suggest-fix') {
      const preview = fixPreview(id);
      if (input.digest !== preview.digest) {
        throw new RequestError(
          409,
          'The error or model changed since the preview. Review the new preview before sending.',
          'preview_changed',
        );
      }
      if (fixSettings().provider !== 'openai') {
        throw new RequestError(
          400,
          'Error fix suggestions use OpenAI only. Set the provider to OpenAI in Settings, AI assist.',
          'provider_unsupported',
        );
      }
      const key = await savedKey();
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        const suggestion = await requestFixSuggestion({
          body: preview.body,
          key,
          fetchImpl,
          baseUrl: openaiBaseUrl,
          signal: abort.signal,
          ...(fixTimeoutMs ? { timeoutMs: fixTimeoutMs } : {}),
        });
        const at = errorStore.saveSuggestion(id, {
          suggestion: redactText(suggestion.text, localRoots),
          model: suggestion.model,
        });
        return json(res, 200, { error: present(errorStore.get(id)), model: suggestion.model, at });
      } catch (failure) {
        if (failure instanceof ProviderError) {
          throw new RequestError(
            failure.status >= 400 && failure.status < 600 ? failure.status : 502,
            failure.message,
            `openai_${failure.status}`,
          );
        }
        throw failure;
      }
    }
    if (name === 'issue-preview') {
      return json(res, 200, await issuePreview(id));
    }
    if (name === 'issue') {
      const preview = await issuePreview(id);
      if (!preview.available) {
        throw new RequestError(409, preview.message, preview.code);
      }
      if (input.digest !== preview.digest) {
        throw new RequestError(
          409,
          'The issue text changed since the preview. Review it again before posting.',
          'preview_changed',
        );
      }
      const repo = { slug: preview.repo };
      let result;
      try {
        if (input.mode === 'comment') {
          const number = Number(input.number);
          if (!preview.duplicates.some((issue) => issue.number === number)) {
            throw new RequestError(400, 'Choose one of the matching issues to comment on.');
          }
          result = await gitHub.commentOnIssue(repo, number, preview.body);
        } else if (input.mode === 'create') {
          result = await gitHub.createIssue(repo, {
            title: preview.title,
            body: preview.body,
            labels: preview.labels,
          });
        } else {
          throw new RequestError(400, 'Choose create or comment.');
        }
      } catch (failure) {
        if (failure instanceof GitHubError) {
          throw new RequestError(502, failure.message, failure.code);
        }
        throw failure;
      }
      errorStore.saveIssue(id, result);
      return json(res, 200, { error: present(errorStore.get(id)), issue: result });
    }
    return json(res, 404, { error: 'Not found.' });
  }

  function guarded(handler, prefix) {
    return async (req, res) => {
      const requestPath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const routeLabel = routeTemplate(prefix, requestPath);
      if (!LOOPBACK_HOST.test(req.headers.host || '')) {
        logRejected(routeLabel, 403, 'non_loopback_host');
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      try {
        await handler(req, res);
      } catch (failure) {
        if (res.headersSent || res.destroyed) {
          log.debug('errors.response.abandoned', { route: routeLabel, ...failureFields(failure) });
          return;
        }
        if (failure instanceof RequestError) {
          const reason = failure.code || REJECTION_REASONS[failure.status] || 'rejected';
          if (failure.status >= 500) {
            log.error('errors.request.failed', {
              route: routeLabel,
              status: failure.status,
              reason,
            });
          } else {
            logRejected(routeLabel, failure.status, reason);
          }
          return json(res, failure.status, {
            error: failure.message,
            ...(failure.code ? { code: failure.code } : {}),
          });
        }
        // Unexpected failures return a generic message; details stay out of the response.
        log.error('errors.request.failed', {
          route: routeLabel,
          status: 500,
          ...failureFields(failure),
        });
        json(res, 500, { error: 'The errors service failed. Check Diagnostics.' });
      }
    };
  }

  function attach(server) {
    server.middlewares.use('/api/errors', guarded(route, '/api/errors'));
    server.middlewares.use('/api/ai-assist', guarded(aiAssistRoute, '/api/ai-assist'));
    const logger = server.config?.logger;
    if (logger?.error) {
      const original = logger.error;
      hostLogger = logger;
      logger.error = function captureServerError(message, ...args) {
        try {
          if (typeof message === 'string' && message.trim()) {
            getStore().record({ source: 'server', ...describeLoggedError(message, args[0]) });
          }
        } catch (error) {
          // Capturing must never break the original logger.
          log.debug('errors.capture.failed', failureFields(error));
        }
        return original.call(this, message, ...args);
      };
      server.httpServer?.once('close', () => {
        logger.error = original;
        hostLogger = null;
      });
    }
    if (scanIntervalMs > 0) {
      // scan() records its own failures in scanProblems and never rejects.
      timer = setInterval(scan, scanIntervalMs);
      timer.unref?.();
      log.info('errors.scan.started', { intervalMs: scanIntervalMs });
    }
    server.httpServer?.once('close', () => {
      if (timer) {
        log.info('errors.scan.stopped');
      }
      clearInterval(timer);
      store?.close();
      store = null;
    });
  }
  return {
    name: 'forge-errors',
    configureServer: attach,
    configurePreviewServer: attach,
    scan,
    getStore,
  };
}
