import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createTranslationStore } from '../runtime/i18n-store.js';
import { settingsService } from '../runtime/settings-service.js';

async function startService(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-http-'));
  const closers = [];
  // Hooks run in the order they were added: close servers and stores first, then the folder.
  t.after(async () => {
    for (const close of closers) {
      await close();
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const service = settingsService({ runtimeDir: directory, env: {}, ...options });
  const app = express();
  const server = http.createServer(app);
  const logs = [];
  const errors = [];
  service.configureServer({
    middlewares: app,
    httpServer: server,
    config: { logger: { info: (line) => logs.push(line), error: (line) => errors.push(line) } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  // node:http instead of fetch, so a test can send any Host, Origin or header combination.
  function call(method, url, { body, headers = {}, host, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: url,
          headers: {
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(host ? { Host: host } : {}),
            ...headers,
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => {
            text += chunk;
          });
          response.on('end', () => {
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              data = text;
            }
            resolve({ status: response.statusCode, data });
          });
        },
      );
      request.on('error', reject);
      request.end(payload);
    });
  }
  const trusted = { Origin: origin, 'X-Forge-Request': 'settings' };
  return {
    service,
    directory,
    onClose: (close) => closers.push(close),
    logs,
    errors,
    origin,
    call,
    trusted,
    post: (url, body, headers = trusted) => call('POST', url, { body, headers }),
    get: (url, options) => call('GET', url, options),
  };
}

const find = (data, key) => data.settings.find((item) => item.key === key);

test('GET lists every setting with its metadata, optionally for one group', async (t) => {
  const api = await startService(t);
  const { status, data } = await api.get('/api/settings');
  assert.equal(status, 200);
  assert.ok(data.settings.length >= 25);
  assert.deepEqual(
    data.groups.map((group) => group.id),
    ['engines', 'memory', 'queue', 'speech', 'ai', 'interface', 'app'],
  );
  const trellis = find(data, 'engines.autoStart.trellis');
  assert.equal(trellis.type, 'boolean');
  assert.equal(trellis.value, true);
  assert.equal(trellis.default, true);
  assert.equal(trellis.source, 'default');
  assert.equal(trellis.locked, false);
  assert.equal(trellis.effect, 'next-job');
  assert.equal(find(data, 'asr.latencyMs').effect, 'restart-required');
  assert.deepEqual(find(data, 'memory.hostPolicy').values, ['soft', 'strict']);
  assert.equal(find(data, 'vegetation.timeoutMs').min, 10000);
  assert.deepEqual(data.recentChanges, []);
  assert.equal(JSON.stringify(data).includes('Authorization'), false);

  const memory = await api.get('/api/settings?group=memory');
  assert.deepEqual(
    memory.data.settings.map((item) => item.group),
    memory.data.settings.map(() => 'memory'),
  );
  assert.equal((await api.get('/api/settings?group=nope')).status, 400);
  assert.equal((await api.get('/api/settings?foo=1')).status, 400);
  assert.equal((await api.get('/api/settings/other')).status, 404);
});

test('only loopback hosts can read or write', async (t) => {
  const api = await startService(t);
  for (const host of ['evil.example', '192.168.1.5:5173', '127.0.0.1.evil.test']) {
    assert.equal((await api.get('/api/settings', { host })).status, 403, host);
    const write = await api.call('POST', '/api/settings', {
      host,
      body: { key: 'queue.chainUnload', value: false },
      headers: { Origin: `http://${host}`, 'X-Forge-Request': 'settings' },
    });
    assert.equal(write.status, 403, host);
  }
  assert.equal((await api.get('/api/settings')).data.settings.length > 0, true);
  assert.equal(find((await api.get('/api/settings')).data, 'queue.chainUnload').value, true);
});

test('writes need the studio origin and the settings request header', async (t) => {
  const api = await startService(t);
  const body = { key: 'queue.chainUnload', value: false };
  const attempts = [
    {},
    { Origin: api.origin },
    { 'X-Forge-Request': 'settings' },
    { Origin: 'http://evil.example', 'X-Forge-Request': 'settings' },
    { Origin: 'http://localhost:1', 'X-Forge-Request': 'settings' },
    { Origin: api.origin, 'X-Forge-Request': 'errors' },
    { Origin: api.origin, 'X-Forge-Request': 'runtime' },
    { Origin: api.origin, 'X-Forge-Request': 'SETTINGS' },
  ];
  for (const headers of attempts) {
    for (const url of ['/api/settings', '/api/settings/reset']) {
      const payload = url === '/api/settings' ? body : { key: 'queue.chainUnload' };
      assert.equal((await api.post(url, payload, headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal((await api.call('PATCH', '/api/settings', { body, headers })).status, 403);
  }
  assert.equal(find((await api.get('/api/settings')).data, 'queue.chainUnload').value, true);
  assert.deepEqual((await api.get('/api/settings')).data.recentChanges, []);
});

test('methods and request shapes are validated, with unknown fields rejected', async (t) => {
  const api = await startService(t);
  assert.equal(
    (await api.call('PUT', '/api/settings', { headers: api.trusted, body: {} })).status,
    405,
  );
  assert.equal((await api.call('DELETE', '/api/settings', { headers: api.trusted })).status, 405);
  assert.equal((await api.call('GET', '/api/settings/reset')).status, 404);
  assert.equal((await api.post('/api/settings/nope', {})).status, 404);
  const invalid = [
    { raw: '{not json' },
    { raw: '[]' },
    { raw: '"text"' },
    { body: {} },
    { body: { key: 'queue.chainUnload' } },
    { body: { changes: [] } },
    { body: { changes: 'x' } },
    { body: { changes: [{ key: 'queue.chainUnload', value: false }], key: 'a', value: 1 } },
    { body: { key: 'queue.chainUnload', value: false, surprise: true } },
    { body: { changes: [{ key: 'queue.chainUnload', value: false, extra: 1 }] } },
    { body: { changes: [{ key: 5, value: false }] } },
    { body: { key: 'queue.chainUnload', value: false, via: 'robot' } },
    {
      body: {
        changes: Array.from({ length: 21 }, () => ({ key: 'queue.chainUnload', value: true })),
      },
    },
  ];
  for (const item of invalid) {
    const response = await api.call('POST', '/api/settings', { headers: api.trusted, ...item });
    assert.equal(response.status, 400, JSON.stringify(item));
    assert.equal(typeof response.data.error, 'string');
  }
  assert.equal((await api.post('/api/settings/reset', { key: 'a', group: 'queue' })).status, 400);
  assert.equal((await api.post('/api/settings/reset', {})).status, 400);
  assert.equal((await api.post('/api/settings/reset', { group: 'queue', extra: 1 })).status, 400);
  assert.deepEqual((await api.get('/api/settings')).data.recentChanges, []);
});

test('a request body above 8 KiB is refused', async (t) => {
  const api = await startService(t);
  const response = await api.call('POST', '/api/settings', {
    headers: api.trusted,
    raw: JSON.stringify({ key: 'ai.errorFix.model', value: 'x'.repeat(9000) }),
  });
  assert.equal(response.status, 413);
  assert.equal(
    find((await api.get('/api/settings')).data, 'ai.errorFix.model').value,
    'gpt-6.1-sol',
  );
});

test('a valid change is applied, audited and returned with the new list', async (t) => {
  const api = await startService(t);
  const single = await api.post('/api/settings', {
    key: 'engines.autoStart.trellis',
    value: false,
  });
  assert.equal(single.status, 200);
  assert.deepEqual(single.data.results, [
    {
      key: 'engines.autoStart.trellis',
      action: 'set',
      changed: true,
      old: true,
      new: false,
      effect: 'next-job',
      restartRequired: false,
      note: '',
    },
  ]);
  const listed = find(single.data, 'engines.autoStart.trellis');
  assert.equal(listed.value, false);
  assert.equal(listed.source, 'override');
  assert.equal(listed.isDefault, false);
  assert.equal(listed.lastChange.via, 'ui');

  const batch = await api.call('PATCH', '/api/settings', {
    headers: api.trusted,
    body: {
      via: 'mcp',
      changes: [
        { key: 'tray.enabled', value: false },
        { key: 'asr.latencyMs', value: 80 },
      ],
    },
  });
  assert.equal(batch.status, 200);
  assert.deepEqual(
    batch.data.results.map((item) => [item.key, item.restartRequired]),
    [
      ['tray.enabled', true],
      ['asr.latencyMs', true],
    ],
  );
  assert.deepEqual(
    batch.data.recentChanges.map((item) => [item.key, item.via]),
    [
      ['asr.latencyMs', 'mcp'],
      ['tray.enabled', 'mcp'],
      ['engines.autoStart.trellis', 'ui'],
    ],
  );
  const lines = api.logs.map((line) => JSON.parse(line));
  assert.ok(lines.every((line) => line.source === 'settings' && line.event === 'settings_changed'));
  assert.equal(lines.length, 2);
});

test('a batch with one bad item changes nothing and names every problem', async (t) => {
  const api = await startService(t);
  const response = await api.post('/api/settings', {
    changes: [
      { key: 'engines.autoStart.sam31', value: false },
      { key: 'vegetation.timeoutMs', value: 5 },
      { key: 'security.originCheck', value: false },
    ],
  });
  assert.equal(response.status, 400);
  assert.equal(response.data.code, 'invalid_changes');
  assert.deepEqual(
    response.data.problems.map((item) => [item.key, item.code]),
    [
      ['vegetation.timeoutMs', 'invalid_value'],
      ['security.originCheck', 'unknown_key'],
    ],
  );
  const after = (await api.get('/api/settings')).data;
  assert.equal(find(after, 'engines.autoStart.sam31').value, true);
  assert.deepEqual(after.recentChanges, []);
});

test('a setting locked by an environment variable is refused with its name', async (t) => {
  const api = await startService(t, { env: { FORGE_HOST_MEMORY_POLICY: 'strict' } });
  const listed = find((await api.get('/api/settings')).data, 'memory.hostPolicy');
  assert.equal(listed.locked, true);
  assert.equal(listed.lockedBy, 'FORGE_HOST_MEMORY_POLICY');
  assert.equal(listed.source, 'environment');
  assert.equal(listed.value, 'strict');
  const refused = await api.post('/api/settings', { key: 'memory.hostPolicy', value: 'soft' });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'locked_by_environment');
  assert.match(refused.data.error, /FORGE_HOST_MEMORY_POLICY/);
  const reset = await api.post('/api/settings/reset', { key: 'memory.hostPolicy' });
  assert.equal(reset.status, 409);
});

test('reset restores one key or the changeable keys of a group', async (t) => {
  const api = await startService(t, { env: { FORGE_AUTO_PREPARE_MUSIC: '0' } });
  await api.post('/api/settings', {
    changes: [
      { key: 'engines.autoStart.tts', value: false },
      { key: 'engines.autoStart.hunyuan', value: false },
    ],
  });
  const one = await api.post('/api/settings/reset', { key: 'engines.autoStart.tts', via: 'mcp' });
  assert.equal(one.status, 200);
  assert.equal(one.data.results[0].new, true);
  assert.equal(find(one.data, 'engines.autoStart.tts').source, 'default');
  const group = await api.post('/api/settings/reset', { group: 'engines' });
  assert.equal(group.status, 200);
  assert.deepEqual(
    group.data.skipped.map((item) => [item.key, item.reason, item.lockedBy]),
    [['engines.autoPrepare.music', 'locked_by_environment', 'FORGE_AUTO_PREPARE_MUSIC']],
  );
  assert.equal(find(group.data, 'engines.autoStart.hunyuan').value, true);
  assert.equal((await api.post('/api/settings/reset', { group: 'nope' })).status, 400);
});

test('writes are rate limited', async (t) => {
  let clock = 1_000_000;
  const api = await startService(t, { writeLimitPerMinute: 2, now: () => clock });
  const change = (value) => ({ key: 'queue.chainUnload', value });
  assert.equal((await api.post('/api/settings', change(false))).status, 200);
  assert.equal((await api.post('/api/settings', change(true))).status, 200);
  assert.equal((await api.post('/api/settings', change(false))).status, 429);
  clock += 61_000;
  assert.equal((await api.post('/api/settings', change(false))).status, 200);
  // Reading is never limited.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await api.get('/api/settings')).status, 200);
  }
});

test('keep awake and the language use the host adapters', async (t) => {
  const power = { awake: false };
  const api = await startService(t, {
    power: {
      get: () => power.awake,
      async set(value) {
        power.awake = value;
      },
    },
  });
  const awake = await api.post('/api/settings', { key: 'power.keepAwake', value: true });
  assert.equal(awake.status, 200);
  assert.equal(power.awake, true);
  assert.equal(find(awake.data, 'power.keepAwake').value, true);

  const language = await api.post('/api/settings', { key: 'ui.language', value: 'de-CH' });
  assert.equal(language.status, 200);
  const store = createTranslationStore({ directory: api.directory });
  api.onClose(() => store.close());
  assert.equal(store.getPreference(), 'de-CH');
  const invalid = await api.post('/api/settings', { key: 'ui.language', value: 'qqqq-zzzz' });
  assert.equal(invalid.status, 400);
  assert.equal(store.getPreference(), 'de-CH');
  const cleared = await api.post('/api/settings/reset', { key: 'ui.language' });
  assert.equal(cleared.status, 200);
  assert.equal(store.getPreference(), null);
});

test('an unexpected failure returns a generic message without internals', async (t) => {
  const api = await startService(t, {
    settings: {
      list() {
        throw Error('C:\\Users\\secret\\path exploded');
      },
      recentChanges: () => [],
    },
  });
  const response = await api.get('/api/settings');
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(response.data), /secret|exploded|Users/);
  assert.ok(api.errors.some((line) => /exploded/.test(line)));
});
