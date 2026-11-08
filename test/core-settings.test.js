import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAiAssistSettings } from '../runtime/ai-assist-settings.js';
import { readAsrLatency } from '../runtime/asr-latency.js';
import {
  MAX_SETTING_CHANGES,
  SETTING_DEFINITIONS,
  SETTING_EFFECTS,
  SETTING_GROUPS,
  SettingsError,
  createSettings,
  engineEnvironment,
  validateSettingValue,
} from '../runtime/core-settings.js';
import { GENERATION_TIMEOUT_MS } from '../runtime/vegetation-runner.js';

function makeStore(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, settings: createSettings({ directory, env: {}, ...options }) };
}

async function refused(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SettingsError, `expected a SettingsError, got ${error}`);
    return error;
  }
  assert.fail('expected the change to be refused');
}

test('every registered setting is well formed, non-sensitive and valid at its default', () => {
  const keys = new Set();
  const groups = new Set(SETTING_GROUPS.map((group) => group.id));
  for (const definition of SETTING_DEFINITIONS) {
    assert.match(
      definition.key,
      /^[a-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){1,3}$/,
      definition.key,
    );
    assert.ok(!keys.has(definition.key), `${definition.key} is registered twice`);
    keys.add(definition.key);
    assert.ok(groups.has(definition.group), `${definition.key} has an unknown group`);
    assert.ok(SETTING_EFFECTS.includes(definition.effect), definition.key);
    assert.equal(definition.sensitive, false, definition.key);
    assert.equal(typeof definition.mutable, 'boolean');
    assert.ok(definition.description.length > 40, `${definition.key} needs a real description`);
    assert.ok(
      ['boolean', 'enum', 'integer', 'string'].includes(definition.type),
      `${definition.key} has type ${definition.type}`,
    );
    assert.deepEqual(
      validateSettingValue(definition, definition.default),
      { ok: true, value: definition.default },
      `${definition.key} default must pass its own validation`,
    );
    // Nothing secret, consent-related or security-related is ever registered.
    assert.doesNotMatch(
      definition.key,
      /secret|token|password|credential|apikey|consent|licen[cs]e|eula|origin|auth|loopback|host(?!Policy)|port|path|url|root|python|executable/i,
      definition.key,
    );
  }
  assert.ok(keys.size >= 25);
});

test('resource-raising and outbound settings say so in their description', () => {
  const byKey = new Map(SETTING_DEFINITIONS.map((item) => [item.key, item]));
  for (const key of [...byKey.keys()].filter((name) => name.startsWith('engines.autoPrepare'))) {
    assert.match(byKey.get(key).description, /GPU memory/, key);
  }
  assert.match(byKey.get('world.fullPrecision').description, /more GPU memory/);
  assert.match(byKey.get('power.keepAwake').description, /drawing power/);
  assert.match(byKey.get('ai.errorFix.provider').description, /nothing is ever sent automatically/);
  assert.equal(byKey.get('vegetation.timeoutMs').default, GENERATION_TIMEOUT_MS);
});

test('values are validated by type, allowed values, range and pattern', () => {
  const by = (key) => SETTING_DEFINITIONS.find((item) => item.key === key);
  assert.equal(validateSettingValue(by('queue.chainUnload'), 'yes').ok, false);
  assert.equal(validateSettingValue(by('queue.chainUnload'), 1).ok, false);
  assert.equal(validateSettingValue(by('memory.hostPolicy'), 'STRICT').ok, false);
  assert.equal(validateSettingValue(by('memory.hostPolicy'), 'strict').ok, true);
  assert.equal(validateSettingValue(by('asr.latencyMs'), '160').ok, false);
  assert.equal(validateSettingValue(by('asr.latencyMs'), 561).ok, false);
  assert.equal(validateSettingValue(by('asr.latencyMs'), 560).ok, true);
  const timeout = by('vegetation.timeoutMs');
  assert.equal(validateSettingValue(timeout, 9_999).ok, false);
  assert.equal(validateSettingValue(timeout, 10_000).ok, true);
  assert.equal(validateSettingValue(timeout, 1_800_000).ok, true);
  assert.equal(validateSettingValue(timeout, 1_800_001).ok, false);
  assert.equal(validateSettingValue(timeout, 12.5).ok, false);
  assert.equal(validateSettingValue(timeout, '20000').ok, false);
  const model = by('ai.errorFix.model');
  assert.deepEqual(validateSettingValue(model, '  gpt-x  '), { ok: true, value: 'gpt-x' });
  assert.equal(validateSettingValue(model, '').ok, false);
  assert.equal(validateSettingValue(model, 'has space').ok, false);
  assert.equal(validateSettingValue(model, 'x'.repeat(81)).ok, false);
  assert.equal(validateSettingValue(model, null).ok, false);
  const language = by('ui.language');
  assert.deepEqual(validateSettingValue(language, ''), { ok: true, value: null });
  assert.deepEqual(validateSettingValue(language, null), { ok: true, value: null });
  assert.equal(validateSettingValue(language, '../etc').ok, false);
});

test('precedence: environment beats an override, an override beats the default', async (t) => {
  const { directory, settings } = makeStore(t);
  assert.equal(settings.get('queue.chainUnload'), true);
  assert.deepEqual(settings.inspect('queue.chainUnload'), {
    value: true,
    source: 'default',
    lockedBy: null,
  });
  await settings.set([{ key: 'queue.chainUnload', value: false }]);
  assert.deepEqual(settings.inspect('queue.chainUnload'), {
    value: false,
    source: 'override',
    lockedBy: null,
  });

  const locked = createSettings({ directory, env: { FORGE_CHAIN_UNLOAD: 'on' } });
  assert.deepEqual(locked.inspect('queue.chainUnload'), {
    value: true,
    source: 'environment',
    lockedBy: 'FORGE_CHAIN_UNLOAD',
  });
  const record = locked.describe('queue.chainUnload');
  assert.equal(record.locked, true);
  assert.equal(record.lockedBy, 'FORGE_CHAIN_UNLOAD');
  const error = await refused(locked.set([{ key: 'queue.chainUnload', value: false }]));
  assert.equal(error.code, 'locked_by_environment');
  assert.equal(error.status, 409);
  assert.match(error.message, /FORGE_CHAIN_UNLOAD/);
  const resetError = await refused(locked.reset({ key: 'queue.chainUnload' }));
  assert.equal(resetError.code, 'locked_by_environment');
  // The refused attempts changed nothing: the saved override is still there.
  assert.equal(settings.get('queue.chainUnload'), false);
});

test('the environment rules match the ones the queue always used', (t) => {
  const { settings: defaults } = makeStore(t);
  const engines = [
    ['images', 'FORGE_IMAGE_URL', 'FORGE_AUTO_START_IMAGE'],
    ['video', 'FORGE_VIDEO_URL', 'FORGE_AUTO_START_VIDEO'],
    ['tts', 'FORGE_TTS_URL', 'FORGE_AUTO_START_TTS'],
    ['hunyuan', 'FORGE_HUNYUAN_URL', 'FORGE_AUTO_START_HUNYUAN'],
    ['trellis', 'FORGE_TRELLIS_URL', 'FORGE_AUTO_START_TRELLIS'],
    ['sam31', 'FORGE_SAM31_URL', 'FORGE_AUTO_START_SAM31'],
    ['hymotion', 'FORGE_HYMOTION_URL', 'FORGE_AUTO_START_HYMOTION'],
    ['motionbricks', 'FORGE_MOTIONBRICKS_URL', 'FORGE_AUTO_START_MOTIONBRICKS'],
    ['music', 'FORGE_MUSIC_URL', 'FORGE_AUTO_START_MUSIC'],
    ['sound', 'FORGE_SFX_URL', 'FORGE_AUTO_START_SOUND'],
  ];
  for (const [engine, url, auto] of engines) {
    for (const env of [
      {},
      { [url]: 'http://127.0.0.1:9' },
      { [url]: 'http://127.0.0.1:9', [auto]: '1' },
      { [url]: 'http://127.0.0.1:9', [auto]: '0' },
      { [auto]: '1' },
    ]) {
      const legacy = !env[url] || env[auto] === '1';
      const settings = createSettings({ directory: defaults.directory, env });
      assert.equal(
        settings.get(`engines.autoStart.${engine}`),
        legacy,
        `${engine} ${JSON.stringify(env)}`,
      );
    }
  }
  const withEnv = (env, key) => createSettings({ directory: defaults.directory, env }).get(key);
  assert.equal(withEnv({ FORGE_AUTO_PREPARE_MUSIC: '0' }, 'engines.autoPrepare.music'), false);
  assert.equal(withEnv({ FORGE_AUTO_PREPARE_SOUND: '0' }, 'engines.autoPrepare.sound'), false);
  assert.equal(withEnv({}, 'engines.autoPrepare.music'), true);
  assert.equal(withEnv({ FORGE_HOST_MEMORY_POLICY: 'Strict' }, 'memory.hostPolicy'), 'strict');
  assert.equal(withEnv({ FORGE_HOST_MEMORY_POLICY: 'anything' }, 'memory.hostPolicy'), 'soft');
  assert.equal(withEnv({}, 'memory.hostPolicy'), 'soft');
  assert.equal(withEnv({ FORGE_DISABLE_TRAY: '1' }, 'tray.enabled'), false);
  assert.equal(withEnv({ FORGE_DISABLE_TRAY: '0' }, 'tray.enabled'), true);
  assert.equal(withEnv({ FORGE_VEGETATION_TIMEOUT_MS: '4000' }, 'vegetation.timeoutMs'), 4000);
  assert.equal(withEnv({ FORGE_VEGETATION_TIMEOUT_MS: 'abc' }, 'vegetation.timeoutMs'), 120000);
  for (const [value, enabled] of [
    ['0', false],
    ['false', false],
    ['off', false],
    ['no', false],
    ['1', true],
    ['banana', true],
  ]) {
    assert.equal(withEnv({ FORGE_CHAIN_UNLOAD: value }, 'queue.chainUnload'), enabled, value);
  }
});

test('a batch is applied all or nothing and an invalid item changes nothing', async (t) => {
  const { directory, settings } = makeStore(t);
  const error = await refused(
    settings.set([
      { key: 'engines.autoStart.trellis', value: false },
      { key: 'memory.hostPolicy', value: 'extreme' },
      { key: 'no.such.key', value: 1 },
      { key: 'ai.errorFix.model', value: 'gpt-batch' },
    ]),
  );
  assert.equal(error.code, 'invalid_changes');
  assert.deepEqual(
    error.problems.map((item) => [item.key, item.code]),
    [
      ['memory.hostPolicy', 'invalid_value'],
      ['no.such.key', 'unknown_key'],
    ],
  );
  assert.equal(settings.get('engines.autoStart.trellis'), true);
  assert.equal(
    settings.get('ai.errorFix.model'),
    createAiAssistSettings({ directory }).get('error-fix').model,
  );
  assert.deepEqual(settings.recentChanges(), []);
  assert.equal(
    fs.existsSync(path.join(directory, 'settings.sqlite')),
    false,
    'nothing was written',
  );

  const { results } = await settings.set([
    { key: 'engines.autoStart.trellis', value: false },
    { key: 'memory.hostPolicy', value: 'strict' },
  ]);
  assert.deepEqual(
    results.map((item) => [item.key, item.old, item.new, item.changed]),
    [
      ['engines.autoStart.trellis', true, false, true],
      ['memory.hostPolicy', 'soft', 'strict', true],
    ],
  );
});

test('bad requests are refused before anything is looked up', async (t) => {
  const { settings } = makeStore(t);
  assert.equal((await refused(settings.set([]))).code, 'invalid_request');
  assert.equal((await refused(settings.set('nope'))).code, 'invalid_request');
  const many = Array.from({ length: MAX_SETTING_CHANGES + 1 }, () => ({
    key: 'queue.chainUnload',
    value: true,
  }));
  assert.equal((await refused(settings.set(many))).code, 'invalid_request');
  assert.equal(
    (await refused(settings.set([{ key: 'queue.chainUnload', value: true, extra: 1 }]))).code,
    'unknown_field',
  );
  assert.equal(
    (await refused(settings.set([{ key: 'queue.chainUnload' }]))).code,
    'invalid_request',
  );
  const duplicate = await refused(
    settings.set([
      { key: 'queue.chainUnload', value: true },
      { key: 'queue.chainUnload', value: false },
    ]),
  );
  assert.equal(duplicate.problems[0].code, 'duplicate_key');
  assert.equal(
    (await refused(settings.set([{ key: 'queue.chainUnload', value: true }], { via: 'robot' })))
      .code,
    'invalid_request',
  );
  assert.equal((await refused(settings.reset({}))).code, 'invalid_request');
  assert.equal(
    (await refused(settings.reset({ key: 'queue.chainUnload', group: 'queue' }))).code,
    'invalid_request',
  );
  assert.equal((await refused(settings.reset({ group: 'nope' }))).code, 'unknown_group');
  assert.throws(
    () => settings.list({ group: 'nope' }),
    (error) => error.code === 'unknown_group',
  );
  assert.throws(
    () => settings.get('nope'),
    (error) => error.status === 404,
  );
});

test('credentials, consent, security, network and path settings do not exist', async (t) => {
  const { settings } = makeStore(t);
  for (const key of [
    'credentials.openai',
    'credentials.openai.key',
    'ai.openai.apiKey',
    'megascans.licenseAccepted',
    'voices.cloneConsent',
    'security.originCheck',
    'security.requestHeader',
    'network.host',
    'network.port',
    'paths.projects',
    'engines.python',
    'engines.url.trellis',
    'models.remove',
    'trash.clear',
    'github.send',
  ]) {
    const error = await refused(settings.set([{ key, value: true }]));
    assert.equal(error.code, 'unknown_key', key);
  }
  const listed = JSON.stringify(settings.list());
  assert.doesNotMatch(listed, /sk-[A-Za-z0-9]/);
});

test('every change is audited, append-only and free of secrets', async (t) => {
  const { directory, settings } = makeStore(t);
  await settings.set([{ key: 'engines.autoStart.sam31', value: false }], { via: 'mcp' });
  await settings.set([{ key: 'engines.autoStart.sam31', value: false }], { via: 'mcp' });
  await settings.set([{ key: 'ai.vegetationDescribe.provider', value: 'local' }], { via: 'ui' });
  await settings.reset({ key: 'engines.autoStart.sam31' }, { via: 'ui' });
  const changes = settings.recentChanges(10);
  assert.deepEqual(
    changes.map((item) => [item.key, item.action, item.old, item.new, item.via]),
    [
      ['engines.autoStart.sam31', 'reset', false, true, 'ui'],
      ['ai.vegetationDescribe.provider', 'set', 'openai', 'local', 'ui'],
      ['engines.autoStart.sam31', 'set', true, false, 'mcp'],
    ],
    'a repeated identical value is not a change and is not audited',
  );
  assert.match(changes[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(settings.describe('engines.autoStart.sam31').lastChange.action, 'reset');

  const db = new DatabaseSync(path.join(directory, 'settings.sqlite'));
  try {
    assert.throws(() => db.exec("UPDATE settings_audit SET source='x'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM settings_audit'), /append-only/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings_audit').get().n, 3);
    assert.deepEqual(
      db
        .prepare('SELECT key FROM settings_overrides')
        .all()
        .map((row) => row.key),
      [],
      'a reset removes the override row',
    );
  } finally {
    db.close();
  }
});

test('reset puts a key or a whole group back and reports what it skipped', async (t) => {
  const { directory, settings } = makeStore(t);
  await settings.set([
    { key: 'engines.autoStart.hunyuan', value: false },
    { key: 'engines.autoStart.trellis', value: false },
    { key: 'engines.autoPrepare.music', value: false },
  ]);
  const locked = createSettings({ directory, env: { FORGE_TRELLIS_URL: 'http://127.0.0.1:9' } });
  const outcome = await locked.reset({ group: 'engines' });
  assert.deepEqual(
    outcome.skipped.map((item) => [item.key, item.reason, item.lockedBy]),
    [['engines.autoStart.trellis', 'locked_by_environment', 'FORGE_TRELLIS_URL']],
  );
  assert.equal(locked.get('engines.autoStart.hunyuan'), true);
  assert.equal(locked.get('engines.autoPrepare.music'), true);
  assert.equal(outcome.results.filter((item) => item.changed).length, 2);
  const again = await settings.reset({ key: 'engines.autoStart.trellis' });
  assert.equal(again.results[0].changed, true);
  assert.equal(
    (await settings.reset({ key: 'engines.autoStart.trellis' })).results[0].changed,
    false,
  );
});

test('the speech latency adapter reads and writes the existing file and needs a restart', async (t) => {
  const { directory, settings } = makeStore(t);
  assert.equal(settings.get('asr.latencyMs'), 160);
  const { results } = await settings.set([{ key: 'asr.latencyMs', value: 560 }]);
  assert.equal(results[0].restartRequired, true);
  assert.equal(results[0].effect, 'restart-required');
  assert.equal(readAsrLatency(path.join(directory, 'asr-latency.json')), 560);
  assert.equal(settings.describe('asr.latencyMs').source, 'store');
  assert.equal(
    (await refused(settings.set([{ key: 'asr.latencyMs', value: 100 }]))).code,
    'invalid_value',
  );
  await settings.reset({ key: 'asr.latencyMs' });
  assert.equal(readAsrLatency(path.join(directory, 'asr-latency.json')), 160);
});

test('the AI assist adapter shares the ai_assist table and never touches keys', async (t) => {
  const { directory, settings } = makeStore(t);
  await settings.set(
    [
      { key: 'ai.vegetationDescribe.model', value: 'my-local:7b' },
      { key: 'ai.vegetationDescribe.provider', value: 'local' },
    ],
    { via: 'mcp' },
  );
  const store = createAiAssistSettings({ directory }).get('vegetation-describe');
  assert.equal(store.provider, 'local');
  assert.equal(store.model, 'my-local:7b');
  // The old per-feature route sees the same value, and the registry sees what that route writes.
  createAiAssistSettings({ directory }).set({
    feature: 'error-fix',
    provider: 'openai',
    model: 'gpt-from-ui',
  });
  assert.equal(settings.get('ai.errorFix.model'), 'gpt-from-ui');
  assert.equal(
    (await refused(settings.set([{ key: 'ai.errorFix.provider', value: 'local' }]))).code,
    'invalid_value',
  );
  assert.equal(
    (await refused(settings.set([{ key: 'ai.uiTranslate.provider', value: 'local' }]))).code,
    'invalid_value',
  );
  const listed = settings.list({ group: 'ai' });
  assert.equal(listed.length, 6);
  assert.ok(listed.every((item) => item.source === 'store'));
  await settings.reset({ group: 'ai' });
  assert.equal(settings.get('ai.vegetationDescribe.provider'), 'openai');
  assert.equal(settings.get('ai.vegetationDescribe.model'), 'gpt-6-luna');
});

test('host adapters (keep awake, language) apply, validate and roll back together', async (t) => {
  const state = { awake: false, language: null };
  const calls = [];
  const adapters = {
    power: {
      get: () => state.awake,
      async set(value) {
        calls.push(`power:${value}`);
        state.awake = value;
      },
    },
    language: {
      get: () => state.language,
      set(value) {
        calls.push(`language:${value}`);
        if (value === 'fr-FAIL') {
          throw Error('could not save the language');
        }
        state.language = value;
      },
      normalize(value) {
        if (!/^[a-z]{2}(-[A-Z]{2})?$/i.test(value) || value.length > 5) {
          throw Error('That is not a valid language code.');
        }
        return value.toLowerCase();
      },
    },
  };
  const { settings } = makeStore(t, { adapters });
  assert.equal(settings.get('power.keepAwake'), false);
  await settings.set([{ key: 'power.keepAwake', value: true }]);
  assert.equal(state.awake, true);
  assert.equal(settings.describe('power.keepAwake').source, 'store');

  assert.equal(
    (await refused(settings.set([{ key: 'ui.language', value: 'x y' }]))).code,
    'invalid_value',
  );
  const bad = await refused(settings.set([{ key: 'ui.language', value: 'abcd' }]));
  assert.equal(bad.code, 'invalid_value');
  assert.equal(bad.message, 'ui.language: That is not a valid language code.');
  await settings.set([{ key: 'ui.language', value: 'FR' }]);
  assert.equal(state.language, 'fr', 'the adapter stores the normalized value');

  // The second adapter fails after the first one changed: the first one is put back.
  const failure = await refused(
    settings.set([
      { key: 'power.keepAwake', value: false },
      { key: 'ui.language', value: 'fr-FAIL' },
    ]),
  );
  assert.equal(failure.code, 'invalid_value');
  state.language = 'fr';
  const brokenAdapters = {
    ...adapters,
    language: { ...adapters.language, normalize: (value) => value },
  };
  const broken = createSettings({
    directory: settings.directory,
    env: {},
    adapters: brokenAdapters,
  });
  const apply = await refused(
    broken.set([
      { key: 'power.keepAwake', value: false },
      { key: 'ui.language', value: 'fr-FAIL' },
    ]),
  );
  assert.equal(apply.code, 'apply_failed');
  assert.match(apply.message, /No setting was changed/);
  assert.equal(state.awake, true, 'keep awake was restored after the later adapter failed');
  await broken.set([{ key: 'ui.language', value: null }]);
  assert.equal(state.language, null);
  assert.ok(calls.includes('power:false'));
});

test('without a host adapter the setting is listed but cannot be changed here', async (t) => {
  const { settings } = makeStore(t);
  const record = settings.describe('power.keepAwake');
  assert.equal(record.available, false);
  assert.equal(
    (await refused(settings.set([{ key: 'power.keepAwake', value: true }]))).code,
    'unavailable',
  );
});

test('another process sees a change after its short cache expires', async (t) => {
  const { directory, settings } = makeStore(t);
  const reader = createSettings({ directory, env: {}, cacheMs: 60_000 });
  assert.equal(reader.get('engines.autoStart.tts'), true);
  await settings.set([{ key: 'engines.autoStart.tts', value: false }]);
  assert.equal(reader.get('engines.autoStart.tts'), true, 'cached for a moment');
  reader.invalidate();
  assert.equal(reader.get('engines.autoStart.tts'), false);
  const immediate = createSettings({ directory, env: {}, cacheMs: 0 });
  await settings.set([{ key: 'engines.autoStart.tts', value: true }]);
  assert.equal(immediate.get('engines.autoStart.tts'), true);
  // The writer itself never serves a stale value.
  assert.equal(settings.get('engines.autoStart.tts'), true);
});

test('an unreadable settings file means the defaults, not a failure', (t) => {
  const { directory } = makeStore(t);
  fs.writeFileSync(path.join(directory, 'settings.sqlite'), 'this is not a database');
  const settings = createSettings({ directory, env: {}, cacheMs: 0 });
  assert.equal(settings.get('engines.autoStart.tts'), true);
  assert.equal(settings.get('memory.hostPolicy'), 'soft');
  assert.ok(settings.readError());
});

test('a stored value that no longer validates falls back to the default', async (t) => {
  const { directory, settings } = makeStore(t);
  await settings.set([{ key: 'vegetation.timeoutMs', value: 60_000 }]);
  const db = new DatabaseSync(path.join(directory, 'settings.sqlite'));
  db.prepare('UPDATE settings_overrides SET value_json=? WHERE key=?').run(
    '"oops"',
    'vegetation.timeoutMs',
  );
  db.close();
  settings.invalidate();
  assert.equal(settings.get('vegetation.timeoutMs'), 120000);
});

test('engines receive only saved overrides, and never override their own environment', async (t) => {
  const { settings } = makeStore(t);
  assert.deepEqual(engineEnvironment({ settings, env: {} }), {});
  await settings.set([
    { key: 'memory.hostPolicy', value: 'strict' },
    { key: 'world.fullPrecision', value: true },
  ]);
  assert.deepEqual(engineEnvironment({ settings, env: {} }), {
    FORGE_HOST_MEMORY_POLICY: 'strict',
    FORGE_WORLDGEN_FULL_PRECISION: '1',
  });
  assert.deepEqual(engineEnvironment({ settings, env: { FORGE_HOST_MEMORY_POLICY: 'soft' } }), {
    FORGE_WORLDGEN_FULL_PRECISION: '1',
  });
});
