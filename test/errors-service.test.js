import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createAiAssistSettings } from '../runtime/ai-assist-settings.js';
import { extractSourceContext, resolveRepoSource } from '../runtime/error-fix.js';
import { errorsService } from '../runtime/errors-service.js';

// A fake key used only against the loopback fake OpenAI server below.
const FAKE_KEY = 'sk-fake-test-key-0123456789abcdefghijkl';
const ENVIRONMENT = {
  appVersion: '9.9.9',
  platform: 'win32',
  arch: 'arm64',
  nodeVersion: 'v24.0.0',
};

async function startFakeOpenAI(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, requests };
}

function fakeCredentials(key) {
  return {
    status: () => [{ provider: 'openai', saved: !!key }],
    get: async () => key,
  };
}

async function startService(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-errors-svc-'));
  const runtimeDir = path.join(root, 'runtime');
  const repoRoot = path.join(root, 'repo');
  await fs.mkdir(path.join(repoRoot, 'runtime'), { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  const logged = [];
  const logger = { info() {}, warn() {}, error: (message) => logged.push(String(message)) };
  const app = express();
  const server = http.createServer(app);
  const service = errorsService({
    runtimeDir,
    repoRoot,
    roots: { repo: repoRoot, runtime: runtimeDir, home: os.homedir(), user: 'forge-test-user' },
    credentials: fakeCredentials(options.key ?? ''),
    environment: ENVIRONMENT,
    scanIntervalMs: 0,
    aiAssistSettings: createAiAssistSettings({ directory: runtimeDir }),
    github: options.github,
    ...options.service,
  });
  service.configureServer({ middlewares: app, httpServer: server, config: { logger } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
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
  return { call, origin, service, runtimeDir, repoRoot, logger, logged };
}

async function seedError(call, overrides = {}) {
  const report = await call('POST', '/report', {
    kind: 'error',
    message: 'TypeError: boom',
    stack: 'TypeError: boom\n    at run (<repo>/runtime/sample.js:3:5)',
    page: '/images?prompt=secret',
    ...overrides,
  });
  assert.equal(report.status, 200, report.text);
  return report.data.id;
}

test('browser reports are validated, size limited, rate limited and stripped of queries', async (t) => {
  const { call } = await startService(t, { service: { reportLimitPerMinute: 3 } });
  assert.equal((await call('POST', '/report', { kind: 'nope', message: 'x' })).status, 400);
  assert.equal((await call('POST', '/report', { kind: 'error', message: '' })).status, 400);
  assert.equal(
    (await call('POST', '/report', { kind: 'error', message: 'x', prompt: 'private' })).status,
    400,
    'unknown fields are rejected',
  );
  assert.equal(
    (await call('POST', '/report', { kind: 'fetch', message: 'x', context: { body: 'x' } })).status,
    400,
  );
  assert.equal(
    (await call('POST', '/report', { kind: 'error', message: 'x', stack: 'y'.repeat(70000) }))
      .status,
    413,
  );
  const id = await seedError(call);
  const detail = await call('GET', `/${id}`);
  assert.equal(detail.data.error.page, '/images');
  assert.equal(detail.data.error.source, 'browser');
  await seedError(call, { message: 'second' });
  await seedError(call, { message: 'third' });
  assert.equal((await call('POST', '/report', { kind: 'error', message: 'fourth' })).status, 429);
});

test('mutations require the studio origin and request header', async (t) => {
  const { call } = await startService(t);
  assert.equal((await call('POST', '/opened', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await call('POST', '/opened', {}, { 'X-Forge-Request': 'runtime' })).status, 403);
  assert.equal((await call('POST', '/opened', {})).status, 200);
});

test('statuses, notes, clearing and deletion use explicit confirmation', async (t) => {
  const { call } = await startService(t);
  const id = await seedError(call);
  assert.equal((await call('GET', '/summary')).data.unread, 1);
  await call('POST', '/opened', {});
  assert.equal((await call('GET', '/summary')).data.unread, 0);
  assert.equal((await call('POST', `/${id}/viewed`, {})).data.error.status, 'reviewed');
  assert.equal((await call('POST', `/${id}/status`, { status: 'bogus' })).status, 400);
  const verified = await call('POST', `/${id}/status`, {
    status: 'verified',
    fixSource: 'self',
    fixNote: 'Mail me at me@example.com',
  });
  assert.equal(verified.data.error.status, 'verified');
  assert.equal(verified.data.error.fixNote, 'Mail me at <email>');
  assert.equal((await call('POST', `/${id}/note`, { note: 'checked' })).data.error.note, 'checked');
  assert.equal((await call('POST', '/clear', { statuses: ['resolved'] })).status, 400);
  assert.equal(
    (await call('POST', '/clear', { statuses: ['new'], confirm: 'clear' })).status,
    400,
    'new errors cannot be bulk-cleared',
  );
  assert.equal((await call('POST', `/${id}/delete`, {})).status, 400);
  assert.equal((await call('POST', `/${id}/delete`, { confirm: 'delete' })).data.removed, true);
  assert.equal((await call('GET', `/${id}`)).status, 404);
  const list = await call('GET', '?status=verified');
  assert.equal(list.data.total, 0);
  assert.equal((await call('GET', '?status=wrong')).status, 400);
});

test('server logger errors are captured and local paths are only shown on request', async (t) => {
  const { call, logger, repoRoot } = await startService(t);
  logger.error(`HTTP request failed: ENOENT ${path.join(repoRoot, 'runtime', 'x.js')}`);
  const list = await call('GET', '?source=server');
  assert.equal(list.data.total, 1);
  const id = list.data.errors[0].id;
  const redacted = await call('GET', `/${id}`);
  assert.match(redacted.data.error.message, /<repo>[\\/]runtime[\\/]x\.js/);
  assert.ok(!redacted.text.includes(repoRoot.replaceAll('\\', '\\\\')));
  const expanded = await call('GET', `/${id}?includePaths=1`);
  assert.equal(expanded.data.error.includesPaths, true);
  assert.ok(expanded.data.error.message.includes(path.join(repoRoot, 'runtime', 'x.js')));
});

test('without a saved key the fix flow asks for one and sends nothing', async (t) => {
  const fake = await startFakeOpenAI(t, (_req, res) => res.end('{}'));
  const { call } = await startService(t, { service: { openaiBaseUrl: fake.baseUrl } });
  const id = await seedError(call);
  const settings = await call('GET', '/settings');
  assert.equal(settings.data.hasKey, false);
  assert.equal(settings.data.model, 'gpt-6.1-sol');
  const preview = await call('POST', `/${id}/fix-preview`, {});
  assert.equal(preview.data.hasKey, false);
  const send = await call('POST', `/${id}/suggest-fix`, { digest: preview.data.digest });
  assert.equal(send.status, 400);
  assert.equal(send.data.code, 'no_key');
  assert.match(send.data.error, /Add your OpenAI key in Settings/);
  const verify = await call('POST', '/settings/verify-model', { model: 'gpt-6.1-sol' });
  assert.equal(verify.data.code, 'no_key');
  assert.equal(fake.requests.length, 0);
});

test('the sent request equals the preview, and the key never leaves the server', async (t) => {
  const fake = await startFakeOpenAI(t, (_req, res) => {
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
  const { call, repoRoot, runtimeDir, logged } = await startService(t, {
    key: FAKE_KEY,
    service: { openaiBaseUrl: fake.baseUrl },
  });
  await fs.writeFile(
    path.join(repoRoot, 'runtime', 'sample.js'),
    ['// one', 'const two = 2;', 'throw new TypeError("boom");', '// four', ''].join('\n'),
  );
  const id = await seedError(call);
  const preview = await call('POST', `/${id}/fix-preview`, {});
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.data.sourceFiles, [
    { path: 'runtime/sample.js', startLine: 1, endLine: 5 },
  ]);
  assert.match(preview.data.body.input, />\s+3 \| throw new TypeError/);
  assert.match(preview.data.notice, /sent to OpenAI/);
  assert.equal(preview.data.body.store, false);
  assert.equal((await call('POST', `/${id}/suggest-fix`, { digest: 'stale' })).status, 409);
  const sent = await call('POST', `/${id}/suggest-fix`, { digest: preview.data.digest });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].url, '/v1/responses');
  assert.equal(fake.requests[0].authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(fake.requests[0].body), preview.data.body);
  assert.equal(sent.data.error.suggestion, '## Explanation\nFix it.');
  assert.equal(sent.data.error.suggestionModel, 'gpt-6.1-sol');
  // The key appears in no response, log line or stored byte.
  for (const text of [preview.text, sent.text, (await call('GET', `/${id}`)).text, ...logged]) {
    assert.ok(!text.includes(FAKE_KEY));
  }
  for (const name of await fs.readdir(runtimeDir)) {
    const bytes = await fs.readFile(path.join(runtimeDir, name));
    assert.ok(!bytes.includes(FAKE_KEY), name);
  }
});

test('provider errors become actionable messages without echoing the key', async (t) => {
  let status = 401;
  const fake = await startFakeOpenAI(t, (_req, res) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }));
  });
  const { call } = await startService(t, {
    key: FAKE_KEY,
    service: { openaiBaseUrl: fake.baseUrl },
  });
  const id = await seedError(call);
  const { data } = await call('POST', `/${id}/fix-preview`, {});
  const expectations = {
    401: /Replace the OpenAI key/,
    403: /cannot use/,
    404: /could not find the model/,
    429: /rate limit or quota/,
    503: /server problem/,
  };
  for (const [code, pattern] of Object.entries(expectations)) {
    status = Number(code);
    const result = await call('POST', `/${id}/suggest-fix`, { digest: data.digest });
    assert.equal(result.status, status);
    assert.match(result.data.error, pattern);
    assert.ok(!result.text.includes(FAKE_KEY));
  }
});

test('a slow provider times out and the request can be cancelled', async (t) => {
  const fake = await startFakeOpenAI(t, () => {
    // Never answers.
  });
  const { call } = await startService(t, {
    key: FAKE_KEY,
    service: { openaiBaseUrl: fake.baseUrl, fixTimeoutMs: 200 },
  });
  const id = await seedError(call);
  const { data } = await call('POST', `/${id}/fix-preview`, {});
  const result = await call('POST', `/${id}/suggest-fix`, { digest: data.digest });
  assert.equal(result.status, 504);
  assert.match(result.data.error, /timed out or was cancelled/);
});

test('model verification reports the provider message and offers available ids', async (t) => {
  const fake = await startFakeOpenAI(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models/gpt-6.1-sol') {
      res.statusCode = 404;
      return res.end(
        JSON.stringify({ error: { message: "The model 'gpt-6.1-sol' does not exist" } }),
      );
    }
    if (req.url === '/v1/models') {
      return res.end(
        JSON.stringify({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'bad id!' }] }),
      );
    }
    return res.end(JSON.stringify({ id: 'gpt-a' }));
  });
  const { call } = await startService(t, {
    key: FAKE_KEY,
    service: { openaiBaseUrl: fake.baseUrl },
  });
  const missing = await call('POST', '/settings/verify-model', { model: 'gpt-6.1-sol' });
  assert.equal(missing.data.exists, false);
  assert.equal(missing.data.message, "The model 'gpt-6.1-sol' does not exist");
  assert.deepEqual(missing.data.models, ['gpt-a', 'gpt-b']);
  const found = await call('POST', '/settings/verify-model', { model: 'gpt-a' });
  assert.equal(found.data.exists, true);
  assert.equal((await call('POST', '/settings', { model: 'bad id!' })).status, 400);
  assert.equal((await call('POST', '/settings', { model: 'gpt-a' })).data.model, 'gpt-a');
  assert.equal((await call('GET', '/settings')).data.model, 'gpt-a');
});

test('shared AI assist settings list every feature and validate entries', async (t) => {
  const { origin } = await startService(t);
  const read = await (await fetch(`${origin}/api/ai-assist/settings`)).json();
  assert.deepEqual(
    read.features.map((item) => [item.feature, item.provider, item.model]),
    [
      ['error-fix', 'openai', 'gpt-6.1-sol'],
      ['vegetation-describe', 'openai', 'gpt-6-luna'],
      ['ui-translate', 'openai', 'gpt-6-luna'],
    ],
  );
  const post = (body, kind = 'ai-assist') =>
    fetch(`${origin}/api/ai-assist/settings`, {
      method: 'POST',
      headers: { Origin: origin, 'X-Forge-Request': kind, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ feature: 'error-fix', provider: 'openai', model: 'x' }, 'errors')).status,
    403,
  );
  assert.equal((await post({ feature: 'other', provider: 'openai', model: 'x' })).status, 400);
  assert.equal((await post({ feature: 'error-fix', provider: 'cloud', model: 'x' })).status, 400);
  assert.equal(
    (await post({ feature: 'error-fix', provider: 'openai', model: 'a'.repeat(81) })).status,
    400,
  );
  const saved = await (
    await post({ feature: 'vegetation-describe', provider: 'local', model: 'qwen/q3:8b' })
  ).json();
  assert.equal(saved.feature.provider, 'local');
  assert.equal(saved.feature.model, 'qwen/q3:8b');
});

test('source context refuses paths outside the repository and sensitive folders', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-errors-src-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  for (const folder of [
    'runtime',
    'models',
    'projects/p',
    '.forge-runtime',
    'node_modules/x',
    'runtime/credentials',
  ]) {
    await fs.mkdir(path.join(repo, folder), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'outside.js'), 'secret\n');
  for (const file of [
    'runtime/ok.js',
    'models/m.py',
    'projects/p/a.js',
    '.forge-runtime/x.js',
    'node_modules/x/i.js',
    'runtime/credentials/k.js',
    'runtime/data.sqlite',
  ]) {
    await fs.writeFile(path.join(repo, file), 'line\n');
  }
  assert.ok(resolveRepoSource(repo, 'runtime/ok.js'));
  for (const relative of [
    '../outside.js',
    'models/m.py',
    'projects/p/a.js',
    '.forge-runtime/x.js',
    'node_modules/x/i.js',
    'runtime/credentials/k.js',
    'runtime/data.sqlite',
    path.join(root, 'outside.js'),
    'runtime/missing.js',
  ]) {
    assert.equal(resolveRepoSource(repo, relative), null, relative);
  }
  try {
    await fs.symlink(path.join(root, 'outside.js'), path.join(repo, 'runtime', 'link.js'));
    assert.equal(
      resolveRepoSource(repo, 'runtime/link.js'),
      null,
      'links that leave the repository',
    );
  } catch (error) {
    // Creating symlinks needs Developer Mode or admin rights on Windows.
    t.diagnostic(`symlink case skipped: ${error.code}`);
  }
  const excerpts = extractSourceContext(
    [
      'File "<repo>/models/m.py", line 1, in f',
      'File "<repo>/../outside.js", line 1, in g',
      'File "<repo>/runtime/ok.js", line 1, in h',
    ].join('\n'),
    { repoRoot: repo },
  );
  assert.deepEqual(
    excerpts.map((item) => item.path),
    ['runtime/ok.js'],
  );
});

test('MCP error tools are read-only and call the redacted routes', async () => {
  const { registerErrorsTools } = await import('../runtime/mcp-errors-tools.js');
  const tools = new Map();
  const reads = [];
  registerErrorsTools(
    { registerTool: (name, definition, handler) => tools.set(name, { definition, handler }) },
    { read: (route) => reads.push(route), readonly: { readOnlyHint: true } },
  );
  assert.deepEqual([...tools.keys()], ['forge_errors_list', 'forge_error_detail']);
  for (const { definition } of tools.values()) {
    assert.equal(definition.annotations.readOnlyHint, true);
  }
  tools
    .get('forge_errors_list')
    .handler({ status: 'new', source: 'engine', query: 'cuda', limit: 5 });
  tools.get('forge_error_detail').handler({ id: 12 });
  assert.deepEqual(reads, [
    '/api/errors?limit=5&status=new&source=engine&q=cuda',
    '/api/errors/12',
  ]);
});
