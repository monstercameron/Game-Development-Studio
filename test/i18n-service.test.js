import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createAiAssistSettings } from '../runtime/ai-assist-settings.js';
import { i18nService } from '../runtime/i18n-service.js';
import {
  buildTranslationRequest,
  parseTranslationOutput,
  validateTranslation,
} from '../runtime/i18n-translate.js';

// A fake key used only against the loopback fake OpenAI server below.
const FAKE_KEY = 'sk-fake-i18n-key-0123456789abcdefghijkl';

const ENGLISH = {
  'images.form.title': 'Create an image',
  'images.form.save': 'Save {name}',
  'images.form.help': 'Open <link>Settings</link> to add a key.',
  'images.form.gpu': 'Forge needs GPU memory for this render.',
  'images.form.files': { one: '{count} file', other: '{count} files' },
  'images.form.cancel': 'Cancel',
  'images.form.done': 'Done',
};

function fakeCredentials(key) {
  return {
    status: () => [{ provider: 'openai', saved: Boolean(key) }],
    get: async () => key,
  };
}

/** Translates every requested string by wrapping it, keeping placeholders and tags. */
function translateAll(body, overrides = {}) {
  const request = JSON.parse(body);
  const { strings } = JSON.parse(request.input);
  const output = {};
  for (const [key, value] of Object.entries(strings)) {
    if (Object.hasOwn(overrides, key)) {
      output[key] = overrides[key];
    } else if (typeof value === 'string') {
      output[key] = `DE ${value}`;
    } else {
      output[key] = Object.fromEntries(
        value.categories.map((category) => [category, `DE ${value.english.other}`]),
      );
    }
  }
  return output;
}

async function startFakeOpenAI(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    handler(req, res, body, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, requests };
}

function respondJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function okHandler(overrides) {
  return (_req, res, body) =>
    respondJson(res, 200, {
      model: 'gpt-6-luna-2026-10-01',
      status: 'completed',
      output_text: JSON.stringify(translateAll(body, overrides)),
    });
}

async function startService(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-i18n-svc-'));
  const runtimeDir = path.join(root, 'runtime');
  const catalogDirectory = path.join(root, 'en');
  await fs.mkdir(catalogDirectory, { recursive: true });
  await fs.writeFile(
    path.join(catalogDirectory, 'images.json'),
    JSON.stringify(options.english || ENGLISH),
  );
  const app = express();
  const server = http.createServer(app);
  const service = i18nService({
    runtimeDir,
    catalogDirectory,
    credentials: fakeCredentials(options.key ?? FAKE_KEY),
    openaiBaseUrl: options.baseUrl || 'http://127.0.0.1:9/v1/',
    aiAssistSettings: createAiAssistSettings({ directory: runtimeDir }),
    ...options.service,
  });
  service.configureServer({ middlewares: app, httpServer: server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (method, route, body, { headers = {}, signal } = {}) => {
    const response = await fetch(`${origin}/api/i18n${route}`, {
      method,
      headers:
        method === 'GET'
          ? headers
          : {
              Origin: origin,
              'X-Forge-Request': 'i18n',
              'Content-Type': 'application/json',
              ...headers,
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    seen.push(text);
    let data = null;
    if (text && response.headers.get('content-type')?.includes('ndjson')) {
      data = text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    } else if (text) {
      data = JSON.parse(text);
    }
    return { status: response.status, data, text };
  };
  const translate = async (lang = 'de', namespaces = ['images']) => {
    const preview = await call('POST', '/preview', { lang, namespaces });
    assert.equal(preview.status, 200, preview.text);
    const result = await call('POST', '/translate', {
      lang,
      namespaces,
      digest: preview.data.digest,
    });
    return { preview: preview.data, result };
  };
  return { call, translate, origin, runtimeDir, catalogDirectory, seen, service };
}

const finalReport = (events) => events.find((event) => event.type === 'done')?.report;

test('nothing is sent or created until an explicit translate; GET routes are local', async (t) => {
  const openai = await startFakeOpenAI(t, okHandler());
  const studio = await startService(t, { baseUrl: openai.baseUrl });
  const languages = await studio.call('GET', '/languages');
  assert.equal(languages.status, 200);
  assert.deepEqual(languages.data.languages, []);
  assert.equal(languages.data.model, 'gpt-6-luna');
  const catalog = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.deepEqual(catalog.data.entries, {});
  assert.equal(catalog.data.state.missing, 7);
  const preview = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  assert.equal(preview.data.strings, 7);
  assert.equal(openai.requests.length, 0);
  assert.equal(existsSync(path.join(studio.runtimeDir, 'i18n.sqlite')), false);
});

test('the preview equals what is sent: only catalog strings, chunked, with the saved key', async (t) => {
  const openai = await startFakeOpenAI(t, okHandler());
  const studio = await startService(t, {
    baseUrl: openai.baseUrl,
    service: { chunkSize: 3 },
  });
  const { preview, result } = await studio.translate();
  assert.equal(preview.strings, 7);
  assert.equal(preview.requests, 3);
  assert.equal(preview.model, 'gpt-6-luna');
  assert.match(preview.notice, /Only Forge’s own interface text/);
  assert.equal(
    preview.characters,
    Object.values(ENGLISH)
      .map((value) => (typeof value === 'string' ? value : Object.values(value).join('')))
      .join('').length,
  );
  assert.equal(openai.requests.length, 3, 'chunked into 3 requests');
  const sent = {};
  for (const request of openai.requests) {
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.authorization, `Bearer ${FAKE_KEY}`);
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    Object.assign(sent, JSON.parse(body.input).strings);
  }
  assert.deepEqual(Object.keys(sent).sort(), Object.keys(ENGLISH).sort());
  assert.deepEqual(sent['images.form.files'].english, ENGLISH['images.form.files']);
  const events = result.data;
  assert.equal(events[0].type, 'start');
  assert.equal(events.filter((event) => event.type === 'progress').length, 3);
  const report = finalReport(events);
  assert.equal(report.translated, 7);
  assert.equal(report.keptEnglish, 0);
  assert.equal(report.model, 'gpt-6-luna');

  const catalog = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.equal(catalog.data.entries['images.form.title'].value, 'DE Create an image');
  assert.equal(catalog.data.entries['images.form.title'].source, 'Create an image');
  assert.equal(catalog.data.entries['images.form.title'].kind, 'machine');
  assert.equal(catalog.data.machine.model, 'gpt-6-luna-2026-10-01');
  assert.deepEqual(catalog.data.entries['images.form.files'].value, {
    one: 'DE {count} files',
    other: 'DE {count} files',
  });
  const languages = await studio.call('GET', '/languages');
  assert.equal(languages.data.languages[0].code, 'de');
  assert.equal(languages.data.languages[0].translations, 7);
});

test('clients cannot submit text: hostile fields, keys and languages are rejected', async (t) => {
  const openai = await startFakeOpenAI(t, okHandler());
  const studio = await startService(t, { baseUrl: openai.baseUrl });
  const hostile = [
    ['/preview', { lang: 'de', namespaces: ['images'], strings: { 'images.x.y': 'my secret' } }],
    ['/preview', { lang: 'de', namespaces: ['../../projects'] }],
    ['/preview', { lang: 'de', namespaces: ['images.form.title'] }],
    ['/preview', { lang: 'en', namespaces: ['images'] }],
    ['/preview', { lang: 'en-XA', namespaces: ['images'] }],
    ['/preview', { lang: 'not a language', namespaces: ['images'] }],
    ['/preview', { lang: 'qaa', namespaces: ['images'] }],
    ['/translate', { lang: 'de', namespaces: ['images'], digest: 'x', text: 'secret prompt' }],
    ['/translate', { lang: 'de', namespaces: ['images'], digest: 'wrong' }],
    ['/override', { lang: 'de', key: 'images.form.unknown', value: 'x' }],
    ['/override', { lang: 'de', key: 'images.form.title', value: '<img src=x onerror=alert(1)>' }],
    ['/override', { lang: 'de', key: 'images.form.save', value: 'Speichern' }],
  ];
  for (const [route, body] of hostile) {
    const response = await studio.call('POST', route, body);
    assert.ok(response.status >= 400 && response.status < 500, `${route} ${JSON.stringify(body)}`);
  }
  const preview = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  const mismatch = await studio.call('POST', '/translate', {
    lang: 'de',
    namespaces: ['images'],
    digest: 'stale',
  });
  assert.equal(mismatch.data.code, 'preview_changed');
  assert.ok(preview.data.digest);
  assert.equal(openai.requests.length, 0, 'nothing reached OpenAI');
  for (const request of await Promise.all([
    studio.call(
      'POST',
      '/preview',
      { lang: 'de', namespaces: ['images'] },
      {
        headers: { Origin: 'http://evil.test' },
      },
    ),
    studio.call(
      'POST',
      '/preview',
      { lang: 'de', namespaces: ['images'] },
      {
        headers: { 'X-Forge-Request': 'errors' },
      },
    ),
  ])) {
    assert.equal(request.status, 403);
  }
  const host = await new Promise((resolve) => {
    const url = new URL(`${studio.origin}/api/i18n/languages`);
    http
      .get(
        { host: url.hostname, port: url.port, path: url.pathname, headers: { Host: 'evil.test' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on('error', () => resolve(0));
  });
  assert.equal(host, 403);
});

test('invalid strings are rejected one by one and reported; the rest are kept', async (t) => {
  const openai = await startFakeOpenAI(
    t,
    okHandler({
      'images.form.save': 'Speichern {nom}',
      'images.form.help': 'Öffnen Sie die Einstellungen.',
      'images.form.gpu': 'Die Schmiede braucht GPU-Speicher.',
      'images.form.cancel': '<script>alert(1)</script>',
      'images.form.files': { one: '{count} Datei' },
    }),
  );
  const studio = await startService(t, { baseUrl: openai.baseUrl });
  const report = finalReport((await studio.translate()).result.data);
  assert.equal(report.translated, 2);
  assert.equal(report.keptEnglish, 5);
  assert.deepEqual(report.reasons, { placeholder: 1, tags: 2, product: 1, plural: 1 });
  const catalog = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.deepEqual(Object.keys(catalog.data.entries).sort(), [
    'images.form.done',
    'images.form.title',
  ]);
  // A second run sends only the rejected strings again.
  const again = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  assert.equal(again.data.strings, 5);
});

test('cache, stale detection and override precedence', async (t) => {
  const openai = await startFakeOpenAI(t, okHandler());
  const studio = await startService(t, { baseUrl: openai.baseUrl });
  await studio.translate();
  assert.equal(openai.requests.length, 1);
  const cached = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  assert.equal(cached.data.strings, 0, 'everything is cached');

  const override = await studio.call('POST', '/override', {
    lang: 'de',
    key: 'images.form.title',
    value: 'Bild erstellen',
  });
  assert.equal(override.status, 200, override.text);
  await studio.call('POST', '/override', {
    lang: 'de',
    key: 'images.form.cancel',
    value: 'Abbrechen',
  });

  // Change two English sources: the overridden one stays overridden, the other becomes stale.
  const english = {
    ...ENGLISH,
    'images.form.title': 'Create a picture',
    'images.form.done': 'Finished',
  };
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(path.join(studio.catalogDirectory, 'images.json'), JSON.stringify(english));
  const stale = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  assert.equal(stale.data.strings, 1);
  assert.deepEqual(stale.data.namespaces[0], {
    namespace: 'images',
    total: 7,
    cached: 4,
    stale: 1,
    missing: 0,
    overrides: 2,
  });
  const catalog = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.equal(catalog.data.entries['images.form.title'].value, 'Bild erstellen');
  assert.equal(catalog.data.entries['images.form.title'].kind, 'override');
  assert.equal(catalog.data.entries['images.form.done'], undefined, 'stale is not served');

  const second = await studio.translate();
  const sent = JSON.parse(JSON.parse(openai.requests.at(-1).body).input).strings;
  assert.deepEqual(sent, { 'images.form.done': 'Finished' }, 'only the changed string is sent');
  assert.equal(finalReport(second.result.data).translated, 1);
  const after = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.equal(after.data.entries['images.form.cancel'].value, 'Abbrechen', 'override kept');

  const strings = await studio.call('GET', '/strings?lang=de&ns=images');
  const byKey = Object.fromEntries(strings.data.strings.map((row) => [row.key, row]));
  assert.equal(byKey['images.form.cancel'].kind, 'override');
  assert.equal(byKey['images.form.done'].kind, 'machine');

  // Reset of the page keeps personal edits; deleting the language removes them too.
  const missingConfirm = await studio.call('DELETE', '/cache', { lang: 'de' });
  assert.equal(missingConfirm.status, 400);
  const reset = await studio.call('DELETE', '/cache', {
    lang: 'de',
    namespaces: ['images'],
    confirm: 'delete',
  });
  assert.equal(reset.data.removed, 7);
  const afterReset = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.deepEqual(Object.keys(afterReset.data.entries).sort(), [
    'images.form.cancel',
    'images.form.title',
  ]);
  const removed = await studio.call('DELETE', '/cache', {
    lang: 'de',
    includeOverrides: true,
    confirm: 'delete',
  });
  assert.equal(removed.data.removed, 2);
  assert.deepEqual((await studio.call('GET', '/languages')).data.languages, []);
});

test('provider failures give clear messages and never expose the key', async (t) => {
  const cases = [
    [401, /rejected the saved API key \(401\)/],
    [404, /could not find the model gpt-6-luna \(404\)/],
    [429, /rate limit or quota reached \(429\)/],
    [503, /server problem \(503\)/],
  ];
  for (const [status, pattern] of cases) {
    const openai = await startFakeOpenAI(t, (_req, res) =>
      respondJson(res, status, { error: { message: `Bad request for key ${FAKE_KEY}` } }),
    );
    const studio = await startService(t, { baseUrl: openai.baseUrl });
    const { result } = await studio.translate();
    const report = finalReport(result.data);
    assert.match(report.error.message, pattern);
    assert.equal(report.error.code, `openai_${status}`);
    assert.equal(report.translated, 0);
    assert.equal(report.notTranslated, 7);
    for (const text of studio.seen) {
      assert.ok(!text.includes(FAKE_KEY), 'key never in a response');
    }
  }
});

test('missing key, local provider and model checks', async (t) => {
  const openai = await startFakeOpenAI(t, (req, res) => {
    if (req.url.startsWith('/v1/models/')) {
      return respondJson(res, 404, { error: { message: 'The model does not exist.' } });
    }
    if (req.url === '/v1/models') {
      return respondJson(res, 200, { data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6.1-sol' }] });
    }
    return respondJson(res, 500, {});
  });
  const noKey = await startService(t, { baseUrl: openai.baseUrl, key: '' });
  const { preview, result } = await noKey.translate();
  assert.equal(preview.hasKey, false);
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'no_key');
  assert.match(result.data.error, /Settings/);
  const noKeyCheck = await noKey.call('POST', '/verify-model', { model: 'gpt-6-luna' });
  assert.equal(noKeyCheck.data.code, 'no_key');

  const studio = await startService(t, { baseUrl: openai.baseUrl });
  const check = await studio.call('POST', '/verify-model', { model: 'gpt-missing' });
  assert.equal(check.data.exists, false);
  assert.deepEqual(check.data.models, ['gpt-6-luna', 'gpt-6.1-sol']);
  const invalid = await studio.call('POST', '/verify-model', { model: 'bad model id!' });
  assert.equal(invalid.status, 400);

  const settings = createAiAssistSettings({ directory: studio.runtimeDir });
  settings.set({ feature: 'ui-translate', provider: 'local', model: 'qwen' });
  const local = await studio.translate();
  assert.equal(local.preview.provider, 'local');
  assert.equal(local.result.data.code, 'provider_unsupported');
  assert.equal(openai.requests.filter((request) => request.url === '/v1/responses').length, 0);
});

test('cancel stops remaining requests and keeps finished chunks', async (t) => {
  let release;
  const openai = await startFakeOpenAI(t, (req, res, body, count) => {
    if (count === 1) {
      return okHandler()(req, res, body);
    }
    // The second request hangs until the client cancels.
    release = () => res.destroy();
    return undefined;
  });
  const studio = await startService(t, { baseUrl: openai.baseUrl, service: { chunkSize: 3 } });
  const preview = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  const controller = new AbortController();
  const response = await fetch(`${studio.origin}/api/i18n/translate`, {
    method: 'POST',
    headers: {
      Origin: studio.origin,
      'X-Forge-Request': 'i18n',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ lang: 'de', namespaces: ['images'], digest: preview.data.digest }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes('"progress"')) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
  }
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(openai.requests.length, 2, 'the third chunk was never sent');
  const catalog = await studio.call('GET', '/catalog?lang=de&ns=images');
  assert.equal(Object.keys(catalog.data.entries).length, 3, 'the first chunk is kept');
  // The service is free again.
  const next = await studio.call('POST', '/preview', { lang: 'de', namespaces: ['images'] });
  assert.equal(next.data.strings, 4);
});

test('language preference is stored locally and validated', async (t) => {
  const studio = await startService(t);
  assert.deepEqual((await studio.call('GET', '/preference')).data, { locale: null });
  assert.equal(
    (await studio.call('POST', '/preference', { locale: 'pt-br' })).data.locale,
    'pt-BR',
  );
  assert.equal(
    (await studio.call('POST', '/preference', { locale: 'en-XA' })).data.locale,
    'en-XA',
  );
  assert.equal((await studio.call('POST', '/preference', { locale: '<x>' })).status, 400);
  assert.deepEqual((await studio.call('GET', '/preference')).data, { locale: 'en-XA' });
});

test('response validation checks placeholders, tags, markup, length, names and plurals', () => {
  assert.equal(validateTranslation('Save {name}', 'Speichern {name}', 'de'), '');
  assert.equal(validateTranslation('Save {name}', 'Speichern', 'de'), 'placeholder');
  assert.equal(validateTranslation('A <b>b</b>', 'A b', 'de'), 'tags');
  assert.equal(validateTranslation('Plain', 'Plain <i>x</i>', 'de'), 'tags');
  assert.equal(validateTranslation('Plain text', 'Klartext javascript:alert(1)', 'de'), 'markup');
  assert.equal(validateTranslation('Plain text', 'Line\nbreak', 'de'), 'control');
  assert.equal(validateTranslation('OK', 'x'.repeat(200), 'de'), 'length');
  assert.equal(validateTranslation('Forge is ready', 'Die Schmiede ist bereit', 'de'), 'product');
  assert.equal(validateTranslation('Forge is ready', 'Forge ist bereit', 'de'), '');
  const forms = { one: '{count} file', other: '{count} files' };
  assert.equal(
    validateTranslation(
      forms,
      {
        one: 'ملف واحد',
        two: 'ملفان',
        few: '{count} ملفات',
        many: '{count} ملفًا',
        other: '{count} ملف',
        zero: 'لا ملفات',
      },
      'ar',
    ),
    '',
  );
  assert.equal(validateTranslation(forms, { one: '{count} Datei' }, 'de'), 'plural');
  assert.equal(
    validateTranslation(forms, { one: 'eine Datei', other: 'Dateien' }, 'de'),
    'placeholder',
  );

  const items = [
    { key: 'images.form.title', value: 'Create an image' },
    { key: 'images.form.files', value: forms },
  ];
  const body = buildTranslationRequest({
    locale: 'ja',
    languageName: 'Japanese',
    model: 'm',
    items,
  });
  assert.deepEqual(body.text.format.schema.required, ['images.form.title', 'images.form.files']);
  assert.deepEqual(body.text.format.schema.properties['images.form.files'].required, ['other']);
  assert.match(body.instructions, /Keep every \{placeholder\} exactly/);
  const parsed = parseTranslationOutput(
    JSON.stringify({ 'images.form.title': ' 画像を作成 ', extra: 'x' }),
    items,
    'ja',
  );
  assert.equal(parsed.accepted.get('images.form.title'), '画像を作成');
  assert.deepEqual(parsed.rejected, [{ key: 'images.form.files', reason: 'missing' }]);
  assert.deepEqual(parsed.extraKeys, ['extra']);
  assert.deepEqual(parseTranslationOutput('not json', items, 'ja').rejected.length, 2);
});
