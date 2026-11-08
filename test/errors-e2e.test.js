// End-to-end test of the Errors review pipeline against the REAL studio host: a Vite server (the
// same host the studio runs on) with the real errors service plugin, a real SQLite error store,
// the real Python helper, the real log scanner and the real browser capture code. Only the
// outside world is replaced: OpenAI by a fake server on loopback and `gh` by test/fixtures/fake-gh.mjs.
// All state lives in a temporary folder. No engine is started and no model or GPU is used.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'vite';
import { createAiAssistSettings } from '../runtime/ai-assist-settings.js';
import {
  formatErrorMarkdown,
  formatErrorText,
  formatErrorsMarkdown,
  formatFixPrompt,
  formatStackOnly,
} from '../runtime/error-format.js';
import { createGitHubClient } from '../runtime/error-issues.js';
import { describeLoggedError, errorsService } from '../runtime/errors-service.js';
import {
  TEST_ERROR_MARKER,
  buildFakeSecrets,
  createErrorTestRoutes,
  resolveTestPython,
} from '../runtime/errors-test-routes.js';
import { prepareCopy } from '../src/error-copy.js';
import { loadJsx } from './fixtures/load-jsx.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const FAKE_OPENAI_KEY = 'sk-fake-openai-key-0123456789abcdefghijkl';
const ENVIRONMENT = {
  appVersion: '9.9.9',
  platform: 'win32',
  arch: 'arm64',
  nodeVersion: 'v24.0.0',
};
const secrets = buildFakeSecrets();
// Values that must never reach a list, detail, copy, GPT preview or GitHub issue preview.
const LEAKS = [
  secrets.path,
  os.homedir(),
  secrets.key,
  'forgeTestBearerToken0123456789',
  secrets.email,
];
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pythonCommand = resolveTestPython({ repoRoot });
const hasPython =
  spawnSync(pythonCommand, ['-I', '-c', 'print(1)'], { windowsHide: true }).status === 0;

function assertNoLeaks(text, label) {
  for (const leak of LEAKS) {
    assert.ok(!text.includes(leak), `${label} contains ${leak.slice(0, 12)}…`);
    assert.ok(!text.includes(leak.replaceAll('\\', '\\\\')), `${label} contains escaped ${leak}`);
  }
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startFakeOpenAI(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'gpt-6.1-sol',
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '## Explanation\nFix it.' }] },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, requests };
}

/** Starts the real Vite host with the real errors service in a temporary state folder. */
async function startHost(t, { service = {}, openai, github = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-errors-e2e-'));
  const runtimeDir = path.join(root, 'runtime');
  const ghState = path.join(root, 'gh');
  const tempRoot = path.join(root, 'tmp');
  await Promise.all(
    [runtimeDir, ghState, tempRoot].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  await fs.writeFile(
    path.join(ghState, 'scenario.json'),
    JSON.stringify({ remote: 'https://github.com/owner/forge.git', labels: ['bug'] }),
  );
  const hostLines = [];
  const customLogger = {
    hasWarned: false,
    info() {},
    warn() {},
    warnOnce() {},
    error: (message) => hostLines.push(String(message)),
    clearScreen() {},
    hasErrorLogged: () => false,
  };
  const plugin = errorsService({
    runtimeDir,
    credentials: {
      status: () => [{ provider: 'openai', saved: true }],
      get: async () => FAKE_OPENAI_KEY,
    },
    openaiBaseUrl: openai?.baseUrl,
    environment: ENVIRONMENT,
    scanIntervalMs: 0,
    aiAssistSettings: createAiAssistSettings({ directory: runtimeDir }),
    github: github
      ? createGitHubClient({
          repoRoot: root,
          gh: [process.execPath, FAKE_GH, ghState, 'gh'],
          git: [process.execPath, FAKE_GH, ghState, 'git'],
          tempRoot,
        })
      : undefined,
    ...service,
  });
  const port = await freePort();
  const host = await createServer({
    configFile: false,
    root,
    cacheDir: path.join(root, 'cache'),
    appType: 'custom',
    customLogger,
    server: { host: '127.0.0.1', port, strictPort: true, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [plugin],
  });
  await host.listen();
  const origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await host.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`${origin}/api/errors${route}`, {
      method,
      headers:
        method === 'POST'
          ? {
              Origin: origin,
              'X-Forge-Request': 'errors',
              'Content-Type': 'application/json',
              ...headers,
            }
          : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, data: text ? JSON.parse(text) : null };
  };
  const emit = (kind, body = {}) =>
    call('POST', `/test/${kind}`, { confirm: 'emit-test-error', ...body });
  const sourceRows = async (source) => (await call('GET', `?source=${source}`)).data.errors;
  return { origin, call, emit, sourceRows, runtimeDir, root, ghState, tempRoot, hostLines, plugin };
}

async function ghCalls(ghState) {
  const text = await fs.readFile(path.join(ghState, 'calls.jsonl'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('logged host errors are split into a message and a stack, without color codes', () => {
  const escape = String.fromCharCode(27);
  const logged = `${escape}[31mInternal server error: boom\n    at a (/x/a.js:1:2)\n    at b (/x/b.js:3:4)${escape}[39m`;
  const described = describeLoggedError(logged, undefined);
  assert.equal(described.message, 'Internal server error: boom');
  assert.match(described.stack, /^Internal server error: boom\n {4}at a \(\/x\/a\.js:1:2\)/);
  const error = new Error('attached');
  assert.equal(describeLoggedError('plain failure', { error }).stack, error.stack);
  assert.deepEqual(describeLoggedError('plain failure', {}), { message: 'plain failure' });
});

test('every test route refuses non-loopback callers before doing anything', async () => {
  let loggerCalls = 0;
  const handle = createErrorTestRoutes({
    getStore: () => {
      throw Error('the store must not be opened');
    },
    getLogger: () => ({ error: () => loggerCalls++ }),
    scan: async () => {},
    runtimeDir: os.tmpdir(),
    repoRoot,
  });
  const confirmed = { confirm: 'emit-test-error' };
  for (const route of ['/test/server', '/test/python', '/test/api-failure']) {
    assert.equal((await handle(route, confirmed, { remoteAddress: '10.1.2.3' })).status, 403);
  }
  assert.equal((await handle('/test/delete', { confirm: 'delete-test-errors' }, {})).status, 403);
  assert.equal((await handle('/test/server', {}, { remoteAddress: '127.0.0.1' })).status, 400);
  assert.equal(loggerCalls, 0);
});

test('a studio start creates no test errors, and the routes check origin, header, host and rate', async (t) => {
  const { call, emit, origin, runtimeDir } = await startHost(t, {
    service: { testRoutes: { limitPerMinute: 3 } },
  });
  assert.equal((await call('GET', '')).data.total, 0, 'nothing is generated at startup');
  assert.deepEqual(
    await fs.readdir(runtimeDir).then((names) => names.filter((n) => n.endsWith('.log'))),
    [],
  );
  const body = { confirm: 'emit-test-error' };
  assert.equal(
    (await call('POST', '/test/api-failure', body, { Origin: 'http://evil.example' })).status,
    403,
  );
  assert.equal(
    (await call('POST', '/test/api-failure', body, { 'X-Forge-Request': 'runtime' })).status,
    403,
  );
  assert.equal(
    (await fetch(`${origin}/api/errors/test/api-failure`)).status,
    404,
    'GET is not a route',
  );
  assert.equal((await call('POST', '/test/api-failure', {})).status, 400, 'needs the confirmation');
  assert.equal((await call('POST', '/test/api-failure', { confirm: 'yes' })).status, 400);
  assert.equal((await call('POST', '/test/unknown', body)).status, 404);
  // A non-loopback Host header is refused by the whole errors API.
  const foreign = await new Promise((resolve, reject) => {
    const request = http.request(
      `${origin}/api/errors/test/api-failure`,
      {
        method: 'POST',
        headers: {
          Host: 'studio.example.com',
          Origin: 'http://studio.example.com',
          'X-Forge-Request': 'errors',
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end('{"confirm":"emit-test-error"}');
  });
  assert.equal(foreign, 403);
  // The first three confirmed requests pass, the fourth is rate limited.
  const failure = await emit('api-failure');
  assert.equal(failure.status, 500);
  assert.equal(failure.data.code, 'test_api_failure');
  assert.ok(failure.data.error.startsWith(TEST_ERROR_MARKER));
  assert.equal((await emit('api-failure')).status, 500);
  assert.equal((await emit('api-failure')).status, 500);
  assert.equal((await emit('api-failure')).status, 429);
  assert.equal((await call('GET', '')).data.total, 0, 'the route itself does not store a row');
});

test('the test routes can be turned off', async (t) => {
  const { emit } = await startHost(t, { service: { testRoutes: false } });
  assert.equal((await emit('server')).status, 404);
});

test(
  'the whole pipeline works against the real host: capture, dedupe, redaction, copy, GPT and GitHub',
  { timeout: 120000, skip: !hasPython && 'no Python interpreter for the engine-style test' },
  async (t) => {
    const openai = await startFakeOpenAI(t);
    const host = await startHost(t, { openai });
    const { call, emit, sourceRows, runtimeDir, root, ghState, tempRoot, hostLines } = host;

    await t.test(
      'a server exception is recorded with its stack, and repeats are counted',
      async () => {
        const first = await emit('server');
        assert.equal(first.status, 200, first.text);
        assert.equal((await emit('server')).status, 200);
        const rows = await sourceRows('server');
        assert.equal(rows.length, 1, 'the second trigger has the same fingerprint');
        assert.equal(rows[0].count, 2);
        const { error } = (await call('GET', `/${rows[0].id}`)).data;
        assert.equal(error.source, 'server');
        assert.equal(error.status, 'new');
        assert.ok(error.message.includes(TEST_ERROR_MARKER));
        for (const frame of ['readTestPayload', 'loadTestAsset', 'runTestJob', 'emitServer']) {
          assert.match(
            error.stack,
            new RegExp(
              `at ${frame} \\(<repo>[\\\\/]runtime[\\\\/]errors-test-routes\\.js:\\d+:\\d+\\)`,
            ),
            frame,
          );
        }
        assert.ok(
          hostLines.some((line) => line.includes(secrets.key)),
          'control: the host logger got the raw fake key',
        );
        assert.equal(
          hostLines.filter((line) => line.includes('/api/errors/test/server')).length,
          2,
          'the original host logger still receives every error',
        );
      },
    );

    await t.test('a Python traceback in an engine log becomes an engine:test row', async () => {
      const first = await emit('python');
      assert.equal(first.status, 200, first.text);
      assert.equal(first.data.source, 'engine:test');
      assert.equal((await emit('python')).status, 200);
      const rows = await sourceRows('engine:test');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].count, 2, 'the two tracebacks share a fingerprint, each read once');
      assert.equal((await sourceRows('engine')).length, 1, 'the engine filter includes it');
      const log = await fs.readFile(path.join(runtimeDir, 'engine-test.log'), 'utf8');
      assert.ok(log.includes(secrets.key), 'control: the raw engine log really holds the fake key');
      assert.equal(
        log.split('Traceback (most recent call last):').length - 1,
        6,
        'two chains of three',
      );
      const { error } = (await call('GET', `/${rows[0].id}`)).data;
      assert.ok(error.message.startsWith(`RuntimeError: ${TEST_ERROR_MARKER}`));
      assert.match(
        error.stack,
        /The above exception was the direct cause of the following exception/,
      );
      for (const frame of ['parse_worker_option', 'load_worker_settings', 'start_test_worker']) {
        assert.match(
          error.stack,
          new RegExp(
            `File "<repo>[\\\\/]runtime[\\\\/]error_test_helper\\.py", line \\d+, in ${frame}`,
          ),
          frame,
        );
      }
      assert.match(error.stack, /ValueError: invalid literal for int/);
      assert.equal(error.context.log, 'engine-test.log');
      // Listing again must not read the same bytes twice.
      assert.equal((await sourceRows('engine:test'))[0].count, 2);
    });

    await t.test(
      'browser reports, including a failed API call, arrive through the ingest route',
      async () => {
        const failure = await emit('api-failure');
        assert.equal(failure.status, 500);
        const report = await call('POST', '/report', {
          kind: 'fetch',
          message: `POST /api/errors/test/api-failure failed with HTTP 500: ${failure.data.error}`,
          context: { method: 'POST', path: '/api/errors/test/api-failure', status: 500 },
          page: '/diagnostics?source=secret',
        });
        assert.equal(report.status, 200, report.text);
        const uncaught = {
          kind: 'error',
          message: `Error: ${TEST_ERROR_MARKER} Browser uncaught exception (file ${secrets.path}; key ${secrets.key}; header ${secrets.bearer}; contact ${secrets.email})`,
          stack: `Error: ${TEST_ERROR_MARKER} Browser uncaught exception\n    at throwTestException (${pathToFileURL(path.join(repoRoot, 'src', 'ErrorPipelineTest.jsx')).href}:42:11)`,
          page: '/diagnostics',
        };
        const stored = await call('POST', '/report', uncaught);
        assert.equal((await call('POST', '/report', uncaught)).data.id, stored.data.id);
        const rows = await sourceRows('browser');
        assert.equal(rows.length, 2);
        assert.equal(rows.find((row) => row.message.startsWith('Error:')).count, 2);
        const fetchRow = (await call('GET', `/${report.data.id}`)).data.error;
        assert.equal(fetchRow.page, '/diagnostics', 'the query string is dropped');
        assert.equal(fetchRow.context.status, 500);
        assert.ok(fetchRow.message.includes(TEST_ERROR_MARKER));
      },
    );

    await t.test('secrets, the home folder and emails never appear in any output', async () => {
      const list = await call('GET', '');
      assert.equal(list.data.total, 4);
      assertNoLeaks(list.text, 'list');
      const everything = [list.text];
      const details = [];
      for (const row of list.data.errors) {
        for (const query of ['', '?includePaths=1']) {
          const detail = await call('GET', `/${row.id}${query}`);
          // The opt-in view may show the real repository folder, never secrets or the home folder
          // outside the repository.
          for (const leak of [secrets.key, 'forgeTestBearerToken0123456789', secrets.email]) {
            assert.ok(!detail.text.includes(leak), `detail${query} leaked a secret`);
          }
          if (!query) {
            assertNoLeaks(detail.text, 'detail');
            details.push(detail.data.error);
          }
        }
      }
      const exported = await call('GET', '/export?status=new');
      assert.equal(exported.data.errors.length, 4);
      everything.push(exported.text);
      for (const error of details) {
        everything.push(
          formatErrorText(error),
          formatErrorMarkdown(error),
          formatStackOnly(error),
          formatFixPrompt(error),
          prepareCopy(formatErrorText(error)),
        );
      }
      everything.push(formatErrorsMarkdown(exported.data.errors));
      for (const text of everything) {
        assertNoLeaks(text, 'copy output');
      }
      assert.ok(
        details.some((error) => error.message.includes('<home>')),
        'the placeholder is shown',
      );
      assert.ok(details.some((error) => error.message.includes('[redacted-key]')));
      assert.ok(details.some((error) => error.message.includes('Bearer [redacted]')));
      assert.ok(details.some((error) => error.message.includes('<email>')));
      // Stored bytes are redacted too. The engine log is the engine's own file and is not checked.
      for (const name of (await fs.readdir(runtimeDir)).filter((n) =>
        n.startsWith('errors.sqlite'),
      )) {
        const bytes = await fs.readFile(path.join(runtimeDir, name));
        for (const leak of [secrets.key, secrets.email, 'forgeTestBearerToken0123456789']) {
          assert.ok(!bytes.includes(leak), `${name} stores ${leak}`);
        }
      }
    });

    await t.test('the GPT preview and the request actually sent contain no secrets', async () => {
      const pythonRow = (await sourceRows('engine:test'))[0];
      const preview = await call('POST', `/${pythonRow.id}/fix-preview`, {});
      assert.equal(preview.status, 200, preview.text);
      assertNoLeaks(preview.text, 'GPT preview body');
      assert.ok(preview.data.body.input.includes(TEST_ERROR_MARKER), 'the preview holds the error');
      assert.ok(preview.data.body.input.includes('<home>'));
      assert.ok(
        preview.data.sourceFiles.some((file) => file.path === 'runtime/error_test_helper.py'),
      );
      const sent = await call('POST', `/${pythonRow.id}/suggest-fix`, {
        digest: preview.data.digest,
      });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(openai.requests.length, 1);
      assert.equal(openai.requests[0].authorization, `Bearer ${FAKE_OPENAI_KEY}`);
      assertNoLeaks(openai.requests[0].body, 'request received by OpenAI');
      assert.deepEqual(JSON.parse(openai.requests[0].body), preview.data.body);
      assert.equal(sent.data.error.suggestion, '## Explanation\nFix it.');
      assert.ok(!sent.text.includes(FAKE_OPENAI_KEY));
    });

    await t.test('statuses change, a resolved error that repeats is a regression', async () => {
      const [row] = await sourceRows('server');
      assert.equal((await call('POST', `/${row.id}/viewed`, {})).data.error.status, 'reviewed');
      assert.equal(
        (await call('POST', `/${row.id}/status`, { status: 'resolved' })).data.error.status,
        'resolved',
      );
      await emit('server');
      const again = (await call('GET', `/${row.id}`)).data.error;
      assert.equal(again.status, 'new', 'it happened again');
      assert.equal(again.count, 3);
      await call('POST', `/${row.id}/status`, { status: 'ignored' });
      await emit('server');
      assert.equal((await call('GET', `/${row.id}`)).data.error.status, 'ignored');
      assert.equal(
        (await call('POST', `/${row.id}/issue-preview`, {})).status,
        409,
        'no issue before the fix is verified',
      );
    });

    await t.test('Fix worked unlocks a redacted GitHub issue preview and posting', async () => {
      const [row] = await sourceRows('engine:test');
      const fixed = await call('POST', `/${row.id}/status`, {
        status: 'verified',
        fixSource: 'self',
        fixNote: `Reinstalled the helper. Reach me at ${secrets.email}`,
      });
      assert.equal(fixed.data.error.status, 'verified');
      const preview = await call('POST', `/${row.id}/issue-preview`, {});
      assert.equal(preview.status, 200, preview.text);
      assert.equal(preview.data.available, true);
      assert.equal(preview.data.repo, 'owner/forge');
      assertNoLeaks(preview.data.body, 'issue body');
      assertNoLeaks(preview.data.title, 'issue title');
      assert.ok(preview.data.title.includes(TEST_ERROR_MARKER));
      assert.match(preview.data.body, /error_test_helper\.py", line \d+/);
      const created = await call('POST', `/${row.id}/issue`, {
        mode: 'create',
        digest: preview.data.digest,
      });
      assert.equal(created.status, 200, created.text);
      const createCall = (await ghCalls(ghState)).find(
        (entry) => entry.args[0] === 'issue' && entry.args[1] === 'create',
      );
      assert.equal(createCall.body, preview.data.body, 'the posted body is the previewed body');
      assertNoLeaks(createCall.body, 'body posted through gh');
      assert.deepEqual(await fs.readdir(tempRoot), [], 'the temporary body file is deleted');
      assert.equal((await call('GET', `/${row.id}`)).data.error.issueNumber, 42);
    });

    await t.test('Delete test errors removes only marked rows and needs confirmation', async () => {
      const real = await call('POST', '/report', {
        kind: 'error',
        message: 'TypeError: a real fault in the gallery',
        stack: 'TypeError: a real fault\n    at render (http://127.0.0.1:5173/src/Gallery.jsx:9:1)',
      });
      assert.equal((await call('POST', '/test/delete', {})).status, 400);
      assert.equal((await call('POST', '/test/delete', { confirm: 'delete' })).status, 400);
      assert.equal(
        (await call('GET', '')).data.total,
        5,
        'nothing was deleted without confirmation',
      );
      const deleted = await call('POST', '/test/delete', { confirm: 'delete-test-errors' });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.data.removed, 4);
      const left = await call('GET', '');
      assert.equal(left.data.total, 1);
      assert.equal(left.data.errors[0].id, real.data.id);
      assert.equal(
        (await call('POST', '/test/delete', { confirm: 'delete-test-errors' })).data.removed,
        0,
      );
    });

    assert.ok(root);
  },
);

test(
  'a uvicorn-style "Exception in ASGI application" log entry is one engine:test error',
  { skip: !hasPython && 'no Python interpreter for the engine-style test' },
  async (t) => {
    const { emit, sourceRows, call } = await startHost(t);
    const result = await emit('python', { variant: 'asgi' });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.data.variant, 'asgi');
    const rows = await sourceRows('engine:test');
    assert.equal(rows.length, 1);
    const { error } = (await call('GET', `/${rows[0].id}`)).data;
    assert.ok(error.message.startsWith(`RuntimeError: ${TEST_ERROR_MARKER}`));
    assert.equal(error.context.logLine, 'Exception in ASGI application');
    assert.match(
      error.stack,
      /File "<repo>[\\/]runtime[\\/]error_test_helper\.py", line \d+, in main/,
    );
    assert.equal((await emit('python', { variant: 'bogus' })).status, 400);
  },
);

test('an unavailable Python is reported, not hidden', async (t) => {
  const { emit, sourceRows } = await startHost(t, {
    service: { testRoutes: { python: path.join(os.tmpdir(), 'forge-no-such-python.exe') } },
  });
  const result = await emit('python');
  assert.equal(result.status, 503);
  assert.match(result.data.error, /Python was not found/);
  assert.equal((await sourceRows('engine:test')).length, 0);
});

test(
  'the real browser capture code and the Diagnostics test buttons report to the real host',
  { timeout: 60000 },
  async (t) => {
    const { origin, call, sourceRows } = await startHost(t);
    const { JSDOM, VirtualConsole } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
      url: `${origin}/diagnostics`,
      virtualConsole: new VirtualConsole(),
    });
    const previous = {
      window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
      document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
      fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
      Event: Object.getOwnPropertyDescriptor(globalThis, 'Event'),
      navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
      act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
    const hostFetch = globalThis.fetch;
    // A browser sends the page's Origin with same-origin requests; Node's fetch does not.
    dom.window.fetch = (input, init = {}) =>
      hostFetch(new URL(String(input), origin), {
        ...init,
        headers: { ...init.headers, Origin: origin },
      });
    Object.defineProperties(globalThis, {
      window: { configurable: true, writable: true, value: dom.window },
      document: { configurable: true, writable: true, value: dom.window.document },
      Event: { configurable: true, writable: true, value: dom.window.Event },
      navigator: { configurable: true, value: dom.window.navigator },
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    dom.window.Element.prototype.getClientRects = () => [{ width: 800, height: 600 }];
    const capture = await import('../src/error-capture.js');
    capture.installErrorCapture(dom.window);
    // From here a page calls fetch through the wrapper that reports failed studio API calls.
    globalThis.fetch = (...args) => dom.window.fetch(...args);
    const React = (await import('react')).default;
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { module, cleanup } = await loadJsx('ErrorPipelineTest.jsx');
    const root = createRoot(document.getElementById('root'));
    const consoleError = console.error;
    t.after(async () => {
      console.error = consoleError;
      await act(async () => root.unmount());
      await cleanup();
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (key === 'act') {
          globalThis.IS_REACT_ACT_ENVIRONMENT = descriptor;
        } else if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete globalThis[key];
        }
      }
    });
    console.error = () => {};
    await act(async () => root.render(React.createElement(module.default, { onOpenErrors() {} })));

    const buttonNamed = (text) =>
      [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text);
    const press = async (text) => {
      await act(async () => {
        buttonNamed(text).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
    };
    const waitFor = async (check, label) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const value = await check();
        if (value) {
          return value;
        }
        await act(() => sleep(50));
      }
      throw Error(`Timed out: ${label}`);
    };
    const statusOf = (id) => document.getElementById(`error-test-status-${id}`).textContent;

    await press('Browser: uncaught exception');
    const uncaught = await waitFor(
      async () => (await sourceRows('browser')).find((row) => row.message.includes('uncaught')),
      'uncaught exception row',
    );
    const uncaughtDetail = (await call('GET', `/${uncaught.id}`)).data.error;
    assert.ok(uncaughtDetail.message.startsWith(`Error: ${TEST_ERROR_MARKER}`));
    assert.match(uncaughtDetail.stack, /throwTestException/);
    assert.match(
      uncaughtDetail.stack,
      /ErrorPipelineTest\.mjs:\d+:\d+/,
      'the stack has line numbers',
    );
    await waitFor(() => statusOf('uncaught').startsWith('Sent.'), 'Sent status');

    await press('Browser: React render error');
    await waitFor(
      () => document.body.textContent.includes('Could not open the error test sandbox'),
      'boundary fallback',
    );
    const boundary = await waitFor(
      async () => (await sourceRows('browser')).find((row) => row.message.includes('render error')),
      'render error row',
    );
    const boundaryDetail = (await call('GET', `/${boundary.id}`)).data.error;
    assert.equal(boundaryDetail.count, 1, 'reported once');
    assert.match(boundaryDetail.stack, /Component stack:[\s\S]*BrokenTestWidget/);
    assert.equal(boundaryDetail.context.boundary, 'the error test sandbox');
    assert.ok(buttonNamed('Browser: failed API call'), 'the page around the sandbox still works');

    await press('Browser: failed API call');
    const apiRow = await waitFor(
      async () => (await sourceRows('browser')).find((row) => row.message.includes('HTTP 500')),
      'failed API call row',
    );
    const apiDetail = (await call('GET', `/${apiRow.id}`)).data.error;
    assert.equal(apiDetail.context.path, '/api/errors/test/api-failure');
    assert.equal(apiDetail.context.status, 500);
    assert.match(
      apiDetail.message,
      /^POST \/api\/errors\/test\/api-failure failed with HTTP 500: \[Forge test error\]/,
    );

    // jsdom has no native unhandled rejection, so the handler gets the event a browser sends.
    const rejection = new dom.window.Event('unhandledrejection');
    rejection.reason = new Error(`${TEST_ERROR_MARKER} Browser unhandled promise rejection`);
    dom.window.dispatchEvent(rejection);
    await waitFor(
      async () => (await sourceRows('browser')).some((row) => row.message.includes('rejection')),
      'rejection row',
    );

    await press('Server: thrown exception with stack');
    await waitFor(async () => (await sourceRows('server')).length === 1, 'server row');
    await waitFor(() => statusOf('server').startsWith('Sent.'), 'server Sent status');
    if (hasPython) {
      await press('Engine-style Python traceback');
      await waitFor(async () => (await sourceRows('engine:test')).length === 1, 'engine row');
    }

    const summary = await call('GET', '/summary');
    assert.ok(summary.data.unread >= 5);
    assertNoLeaks((await call('GET', '')).text, 'list after clicking the buttons');

    await press('Delete test errors');
    await press('Yes, delete test errors');
    await waitFor(async () => (await call('GET', '')).data.total === 0, 'all test errors deleted');
    assert.match(document.body.textContent, /Deleted \d+ test errors?\. Real errors were kept\./);
  },
);

test('tools/emit-test-error.mjs creates and deletes test errors in a running studio', async (t) => {
  const { origin, sourceRows, call } = await startHost(t);
  const port = new URL(origin).port;
  const script = fileURLToPath(new URL('../tools/emit-test-error.mjs', import.meta.url));
  // Asynchronous on purpose: the host runs inside this process and must keep answering.
  const cli = async (...args) => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
        windowsHide: true,
      });
      return { status: 0, stdout };
    } catch (error) {
      return { status: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  };

  assert.equal((await cli('--port', port, '--kind', 'bogus')).status, 2);
  assert.equal((await cli('--port', 'abc', '--kind', 'server')).status, 2);
  assert.equal(
    (await cli('--kind', 'server', '--host', 'example.com')).status,
    2,
    'no host option',
  );

  const server = await cli('--port', port, '--kind', 'server');
  assert.equal(server.status, 0, server.stdout + server.stderr);
  assert.equal((await sourceRows('server')).length, 1);

  const report = await cli('--port', port, '--kind', 'browser-report');
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const [row] = await sourceRows('browser');
  const { error } = (await call('GET', `/${row.id}`)).data;
  assert.ok(error.message.includes(TEST_ERROR_MARKER));
  assertNoLeaks(JSON.stringify(error), 'CLI browser report');
  assert.ok(error.message.includes('[redacted-key]') && error.message.includes('<email>'));

  if (hasPython) {
    const python = await cli('--port', port, '--kind', 'python', '--variant', 'asgi');
    assert.equal(python.status, 0, python.stdout + python.stderr);
    assert.equal((await sourceRows('engine:test')).length, 1);
  }

  const deleted = await cli('--port', port, '--kind', 'delete');
  assert.equal(deleted.status, 0, deleted.stdout + deleted.stderr);
  assert.equal((await call('GET', '')).data.total, 0);

  const closed = await cli('--port', String(Number(port) + 1000), '--kind', 'server');
  assert.equal(closed.status, 1);
  assert.match(closed.stdout, /Could not reach the studio/);
});
