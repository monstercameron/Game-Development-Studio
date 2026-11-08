// Test routes for the Errors review: /api/errors/test/*. They generate REAL errors on demand so the
// whole pipeline (capture, redaction, storage, review, fix and issue previews) can be checked
// without waiting for a fault. Nothing here runs at startup; each route acts only on an explicit
// POST that carries the confirmation text. Every generated error is marked "[Forge test error]".
// The routes never start an engine, load a model or touch the GPU.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from './app-log.js';

const log = createLogger('errors');

export const TEST_ERROR_MARKER = '[Forge test error]';
export const TEST_EMIT_CONFIRMATION = 'emit-test-error';
export const TEST_DELETE_CONFIRMATION = 'delete-test-errors';
export const TEST_ENGINE_ID = 'test';
export const TEST_ENGINE_LOG = `engine-${TEST_ENGINE_ID}.log`;
export const PYTHON_VARIANTS = Object.freeze(['traceback', 'asgi']);

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HELPER_TIMEOUT_MS = 15000;

/**
 * Deliberately fake sensitive values that the test errors embed, so redaction can be verified.
 * The home path is built from the real home folder because that is what redaction must hide.
 */
export function buildFakeSecrets() {
  return {
    path: path.join(os.homedir(), 'Documents', 'forge-test-private', 'notes.txt'),
    key: 'sk-test-FAKE0123456789abcdef0123456789',
    bearer: 'Bearer forgeTestBearerToken0123456789',
    email: 'forge-test-user@example.com',
  };
}

/**
 * Finds the Python used for the test helper. It follows the other Python helpers of the repo
 * (runtime/transcode.js): an explicit variable, then the Snapdargon-DJ runtime next to the repo,
 * then `python` on PATH. The helper uses only the standard library.
 */
export function resolveTestPython({ repoRoot, env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [
    env.FORGE_ERROR_TEST_PYTHON,
    env.FORGE_TRANSCODE_PYTHON,
    repoRoot ? path.join(path.dirname(repoRoot), 'Snapdargon-DJ', '.runtime', 'python.exe') : '',
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) || 'python';
}

// The nested calls exist so the stack trace has several real frames with line numbers.
function readTestPayload(secrets) {
  throw new Error(
    `${TEST_ERROR_MARKER} Deliberate server exception ` +
      `(file ${secrets.path}; key ${secrets.key}; header ${secrets.bearer}; ` +
      `contact ${secrets.email})`,
  );
}

function loadTestAsset(secrets) {
  return readTestPayload(secrets);
}

function runTestJob(secrets) {
  return loadTestAsset(secrets);
}

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || ''));
}

function createLimiter({ limit, windowMs, now }) {
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

function reply(status, data) {
  return { status, data };
}

function runHelper({ python, helper, variant, run, logFile, timeoutMs, spawnImpl }) {
  return new Promise((resolve) => {
    let descriptor;
    try {
      // Append like an engine's stderr; the scanner reads the file from its saved offset.
      descriptor = fs.openSync(logFile, 'a');
    } catch (error) {
      log.warn('errors.test.log.open.failed', { errorCode: error.code || 'error' });
      resolve({ failed: true, reason: `Could not open the test log (${error.code || 'error'}).` });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fs.closeSync(descriptor);
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(python, ['-I', helper, '--variant', variant, '--run', String(run)], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', descriptor],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (error) {
      log.warn('errors.test.spawn.failed', { errorCode: error.code || 'error' });
      finish({ failed: true, reason: `Python could not start (${error.code || 'error'}).` });
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish({ failed: true, reason: 'The Python test helper did not finish in time.' });
    }, timeoutMs);
    child.on('error', (error) => {
      log.warn('errors.test.spawn.failed', { errorCode: error.code || 'error' });
      finish({
        failed: true,
        reason:
          error.code === 'ENOENT'
            ? 'Python was not found. Set FORGE_ERROR_TEST_PYTHON to a python.exe.'
            : `Python could not start (${error.code || 'error'}).`,
      });
    });
    child.on('close', (exitCode) => finish({ failed: false, exitCode }));
  });
}

/**
 * @param {object} options
 * @param {() => object} options.getStore Opens the error store.
 * @param {() => object|null} options.getLogger The studio host logger whose error() is captured.
 * @param {() => Promise<void>} options.scan Reads new log bytes now.
 * @param {string} options.runtimeDir Folder that holds the engine logs.
 * @param {string} options.repoRoot Repository root (the helper lives in runtime/).
 * @returns {(pathname: string, input: object, request: {remoteAddress?: string}) =>
 *   Promise<{status: number, data: object}>}
 */
export function createErrorTestRoutes({
  getStore,
  getLogger,
  scan,
  runtimeDir,
  repoRoot,
  python = resolveTestPython({ repoRoot }),
  limitPerMinute = 20,
  timeoutMs = HELPER_TIMEOUT_MS,
  spawnImpl = spawn,
  now = () => Date.now(),
}) {
  const allow = createLimiter({ limit: limitPerMinute, windowMs: 60000, now });
  const helper = path.join(repoRoot, 'runtime', 'error_test_helper.py');
  let run = 0;

  function checkRequest(input, confirmation, request) {
    if (!isLoopbackAddress(request?.remoteAddress)) {
      log.warn('errors.test.rejected', { reason: 'not_loopback' });
      return reply(403, { error: 'Test errors can be created from this computer only.' });
    }
    if (input.confirm !== confirmation) {
      log.warn('errors.test.rejected', { reason: 'not_confirmed' });
      return reply(400, { error: 'Confirm the request to run this test.', code: 'confirm' });
    }
    return null;
  }

  function emitServer() {
    const logger = getLogger();
    if (!logger?.error) {
      return reply(503, { error: 'The studio host has no logger that records errors.' });
    }
    run++;
    try {
      runTestJob(buildFakeSecrets());
    } catch (error) {
      // The same call the host makes for an unhandled middleware error: the message plus the
      // original error, whose stack the capture stores.
      logger.error(
        `Unhandled error in POST /api/errors/test/server (run ${run}): ${error.message}`,
        {
          error,
        },
      );
    }
    return reply(200, { sent: true, kind: 'server', source: 'server', run });
  }

  async function emitPython(input) {
    const variant = input.variant === undefined ? 'traceback' : input.variant;
    if (!PYTHON_VARIANTS.includes(variant)) {
      return reply(400, { error: 'Choose traceback or asgi.' });
    }
    if (!fs.existsSync(helper)) {
      return reply(503, { error: 'runtime/error_test_helper.py is missing from this checkout.' });
    }
    fs.mkdirSync(runtimeDir, { recursive: true });
    run++;
    const result = await runHelper({
      python,
      helper,
      variant,
      run,
      logFile: path.join(runtimeDir, TEST_ENGINE_LOG),
      timeoutMs,
      spawnImpl,
    });
    if (result.failed) {
      return reply(503, { error: result.reason });
    }
    // The 20 second timer would find it too; scanning now makes the row appear immediately.
    await scan();
    return reply(200, {
      sent: true,
      kind: 'python',
      variant,
      source: `engine:${TEST_ENGINE_ID}`,
      run,
    });
  }

  function failApi() {
    run++;
    return reply(500, {
      error: `${TEST_ERROR_MARKER} Deliberate HTTP 500 from the studio test route (run ${run}).`,
      code: 'test_api_failure',
    });
  }

  function deleteTestErrors() {
    return reply(200, { removed: getStore().removeMarked(TEST_ERROR_MARKER) });
  }

  return async function handleTestRoute(pathname, input, request) {
    const isDelete = pathname === '/test/delete';
    const rejected = checkRequest(
      input,
      isDelete ? TEST_DELETE_CONFIRMATION : TEST_EMIT_CONFIRMATION,
      request,
    );
    if (rejected) {
      return rejected;
    }
    if (isDelete) {
      return deleteTestErrors();
    }
    if (!['/test/server', '/test/python', '/test/api-failure'].includes(pathname)) {
      return reply(404, { error: 'Not found.' });
    }
    // The path suffix is the kind: server, python or api-failure.
    const kind = pathname.slice('/test/'.length);
    if (!allow()) {
      log.warn('errors.test.rejected', { reason: 'rate_limited', kind });
      return reply(429, { error: 'Too many test errors. Wait a minute and try again.' });
    }
    log.info('errors.test.accepted', { kind });
    if (pathname === '/test/server') {
      return emitServer();
    }
    if (pathname === '/test/python') {
      return emitPython(input);
    }
    return failApi();
  };
}
