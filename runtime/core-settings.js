// Typed registry of Forge's user-facing behaviour settings, shared by the Settings dialog, the
// /api/settings routes and the MCP tools. See docs/SETTINGS.md for the full table.
//
// Resolution order for a value: an explicit environment variable (still wins, so deployment
// configuration is never silently overridden; the setting is then "locked by environment")
// > a persisted override in .forge-runtime/settings.sqlite > the default. A few settings already
// have a store of their own (AI assist models, ASR latency, keep awake, interface language). The
// registry adapts those stores instead of copying their state.
//
// Deployment plumbing (service URLs, folders, executables, ports, tokens), credentials, consent
// confirmations and security checks are never registered here.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './durable-db.js';
import { fileURLToPath } from 'node:url';
import {
  AI_ASSIST_FEATURES,
  ensureAiAssistTable,
  readAiAssistEntry,
  writeAiAssistEntry,
} from './ai-assist-settings.js';
import {
  ASR_LATENCIES_MS,
  DEFAULT_ASR_LATENCY_MS,
  asrLatencyFile,
  readAsrLatency,
  writeAsrLatency,
} from './asr-latency.js';
import { CHAIN_UNLOAD_ENV, isChainUnloadEnabled } from './chain-unload.js';
import { createLogger } from './app-log.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const log = createLogger('settings');

export const SETTING_EFFECTS = Object.freeze(['live', 'next-job', 'restart-required']);
export const SETTING_SOURCES = Object.freeze(['default', 'override', 'environment', 'store']);
export const CHANGE_SOURCES = Object.freeze(['mcp', 'ui']);
export const MAX_SETTING_CHANGES = 20;
export const SETTINGS_CACHE_MS = 1500;
const DEFAULT_VEGETATION_TIMEOUT_MS = 120_000;

export const SETTING_GROUPS = Object.freeze([
  {
    id: 'engines',
    label: 'Engines',
    description: 'Whether the render queue starts and prepares model workers by itself.',
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'How strictly Forge checks memory before it loads a model.',
  },
  {
    id: 'queue',
    label: 'Render queue',
    description: 'How the queue behaves between and during renders.',
  },
  {
    id: 'speech',
    label: 'Speech',
    description: 'Streaming speech recognition.',
  },
  {
    id: 'ai',
    label: 'AI assist',
    description: 'Which provider and model id each optional AI feature uses. Never API keys.',
  },
  {
    id: 'interface',
    label: 'Interface',
    description: 'Studio-wide interface defaults.',
  },
  {
    id: 'app',
    label: 'Studio app',
    description: 'The Windows tray icon and keeping the computer awake.',
  },
]);

const ENGINE_AUTO_START = [
  { id: 'images', name: 'Qwen Image', url: 'FORGE_IMAGE_URL', auto: 'FORGE_AUTO_START_IMAGE' },
  {
    id: 'video',
    name: 'H3 Studio (video)',
    url: 'FORGE_VIDEO_URL',
    auto: 'FORGE_AUTO_START_VIDEO',
  },
  { id: 'world', name: 'World generation', url: 'FORGE_WORLD_URL', auto: 'FORGE_AUTO_START_WORLD' },
  { id: 'tts', name: 'Qwen3-TTS voices', url: 'FORGE_TTS_URL', auto: 'FORGE_AUTO_START_TTS' },
  { id: 'hunyuan', name: 'Hunyuan3D', url: 'FORGE_HUNYUAN_URL', auto: 'FORGE_AUTO_START_HUNYUAN' },
  { id: 'trellis', name: 'TRELLIS.2', url: 'FORGE_TRELLIS_URL', auto: 'FORGE_AUTO_START_TRELLIS' },
  { id: 'sam31', name: 'SAM 3.1', url: 'FORGE_SAM31_URL', auto: 'FORGE_AUTO_START_SAM31' },
  {
    id: 'hymotion',
    name: 'HY-Motion',
    url: 'FORGE_HYMOTION_URL',
    auto: 'FORGE_AUTO_START_HYMOTION',
  },
  {
    id: 'motionbricks',
    name: 'MotionBricks',
    url: 'FORGE_MOTIONBRICKS_URL',
    auto: 'FORGE_AUTO_START_MOTIONBRICKS',
  },
  { id: 'music', name: 'YuE2 music', url: 'FORGE_MUSIC_URL', auto: 'FORGE_AUTO_START_MUSIC' },
  { id: 'sound', name: 'Stable Audio', url: 'FORGE_SFX_URL', auto: 'FORGE_AUTO_START_SOUND' },
];

// The queue may start a worker itself unless the service is provided from outside Forge (its
// service URL is set). FORGE_AUTO_START_<NAME>=1 opts back in. This is the rule the queue always
// used; the registry only reports it as a lock.
function autoStartEnvironment({ url, auto }) {
  return {
    variables: [auto, url],
    read(env) {
      if (env[auto] === '1') {
        return { value: true, variable: auto };
      }
      if (env[url]) {
        return { value: false, variable: url };
      }
      return null;
    },
  };
}

function autoStartDefinition({ id, name, url, auto }) {
  return {
    key: `engines.autoStart.${id}`,
    label: `Start ${name} on demand`,
    group: 'engines',
    type: 'boolean',
    default: true,
    effect: 'next-job',
    description: `Start the ${name} worker itself when a queued render needs it. A running worker holds system memory; no model is loaded. When off, the render waits until you start it on the Models page. Locked off while ${url} points at a service from outside Forge; ${auto}=1 lets Forge manage it anyway.`,
    environment: autoStartEnvironment({ url, auto }),
  };
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;
const LANGUAGE_PATTERN = /^[A-Za-z0-9-]{2,35}$/;

function aiDefinitions({ feature, key, providers, what, note }) {
  const entry = AI_ASSIST_FEATURES[feature];
  return [
    {
      key: `ai.${key}.provider`,
      label: `${entry.label}: provider`,
      group: 'ai',
      type: 'enum',
      values: providers,
      default: entry.provider,
      effect: 'live',
      description: `Which provider ${what}. Choosing OpenAI means the request is sent to OpenAI when you ask for it, with the key saved under API keys; nothing is ever sent automatically. ${note}`,
      store: 'ai',
      feature,
      field: 'provider',
    },
    {
      key: `ai.${key}.model`,
      label: `${entry.label}: model id`,
      group: 'ai',
      type: 'string',
      pattern: MODEL_ID_PATTERN,
      maxLength: 80,
      default: entry.model,
      effect: 'live',
      description: `Model id that ${what}: 1 to 80 letters, digits, dots, dashes, underscores, colons or slashes. The id is not verified here. ${note}`,
      store: 'ai',
      feature,
      field: 'model',
    },
  ];
}

/** Every registered setting. Add an entry here (and to docs/SETTINGS.md) to expose a new one. */
export const SETTING_DEFINITIONS = Object.freeze(
  [
    ...ENGINE_AUTO_START.map(autoStartDefinition),
    {
      key: 'engines.autoPrepare.music',
      label: 'Load the YuE2 music model on demand',
      group: 'engines',
      type: 'boolean',
      default: true,
      effect: 'next-job',
      description:
        'Let the render queue ask the YuE2 music engine to load its model when a music render is waiting. Loading uses a large amount of GPU memory (checked against free memory first). When off, load the model yourself on the Models page; the render waits for the engine.',
      environment: {
        variables: ['FORGE_AUTO_PREPARE_MUSIC'],
        read: (env) => switchEnvironment(env, 'FORGE_AUTO_PREPARE_MUSIC'),
      },
    },
    {
      key: 'engines.autoPrepare.sound',
      label: 'Load the Stable Audio model on demand',
      group: 'engines',
      type: 'boolean',
      default: true,
      effect: 'next-job',
      description:
        'Let the render queue ask the Stable Audio engine to load its model when a sound render is waiting. Loading uses GPU memory (checked against free memory first). When off, load the model yourself on the Models page; the render waits for the engine.',
      environment: {
        variables: ['FORGE_AUTO_PREPARE_SOUND'],
        read: (env) => switchEnvironment(env, 'FORGE_AUTO_PREPARE_SOUND'),
      },
    },
    {
      key: 'memory.hostPolicy',
      label: 'Host memory check',
      group: 'memory',
      type: 'enum',
      values: ['soft', 'strict'],
      default: 'soft',
      effect: 'next-job',
      description:
        "soft blocks a render only when free system memory is below a 2 GiB floor, because model weights are memory-mapped and the per-engine budgets are uncalibrated estimates. strict enforces each engine's full system-memory budget and can hold renders back on a busy computer. GPU memory is always checked either way. The queue follows a change at once; an engine that is already running keeps its value until it is started again.",
      note: 'Queue checks follow a change at once. Running engines pick it up when they next start.',
      environment: {
        variables: ['FORGE_HOST_MEMORY_POLICY'],
        read(env) {
          const raw = String(env.FORGE_HOST_MEMORY_POLICY ?? '').trim();
          return raw
            ? {
                value: raw.toLowerCase() === 'strict' ? 'strict' : 'soft',
                variable: 'FORGE_HOST_MEMORY_POLICY',
              }
            : null;
        },
      },
      engineEnv: { variable: 'FORGE_HOST_MEMORY_POLICY', format: (value) => value },
    },
    {
      key: 'world.fullPrecision',
      label: 'World generation full precision',
      group: 'memory',
      type: 'boolean',
      default: false,
      effect: 'restart-required',
      description:
        'Run the World generation panorama model in full precision instead of the quantized FLUX file. Full precision needs substantially more GPU memory and is slower. The World engine reads this when it starts.',
      note: 'Applies the next time the World generation engine is started by Forge.',
      environment: {
        variables: ['FORGE_WORLDGEN_FULL_PRECISION'],
        read(env) {
          const raw = String(env.FORGE_WORLDGEN_FULL_PRECISION ?? '');
          return raw ? { value: raw === '1', variable: 'FORGE_WORLDGEN_FULL_PRECISION' } : null;
        },
      },
      engineEnv: {
        variable: 'FORGE_WORLDGEN_FULL_PRECISION',
        format: (value) => (value ? '1' : '0'),
      },
    },
    {
      key: 'queue.chainUnload',
      label: 'Free the first model of a chained render',
      group: 'queue',
      type: 'boolean',
      default: true,
      effect: 'next-job',
      description:
        'In a chained render (text to 3D, or remove background then 3D), unload the first model (Qwen Image or SAM 3.1) before the second one loads, when no other render needs it. This lowers peak GPU memory and can cost a reload if you queue another render of the first model later.',
      environment: {
        variables: [CHAIN_UNLOAD_ENV],
        read(env) {
          return String(env[CHAIN_UNLOAD_ENV] ?? '').trim()
            ? { value: isChainUnloadEnabled(env), variable: CHAIN_UNLOAD_ENV }
            : null;
        },
      },
    },
    {
      key: 'vegetation.timeoutMs',
      label: 'Vegetation generation time limit',
      group: 'queue',
      type: 'integer',
      unit: 'ms',
      min: 10_000,
      max: 1_800_000,
      default: DEFAULT_VEGETATION_TIMEOUT_MS,
      effect: 'next-job',
      description:
        'Longest time, in milliseconds, one SeedThree plant may take before Forge stops it. A larger limit lets heavy plants finish but keeps a CPU core busy for longer.',
      environment: {
        variables: ['FORGE_VEGETATION_TIMEOUT_MS'],
        read(env) {
          const value = Number(env.FORGE_VEGETATION_TIMEOUT_MS);
          return Number.isFinite(value) && value > 0
            ? { value, variable: 'FORGE_VEGETATION_TIMEOUT_MS' }
            : null;
        },
      },
    },
    {
      key: 'asr.latencyMs',
      label: 'Speech recognition chunk size',
      group: 'speech',
      type: 'enum',
      values: [...ASR_LATENCIES_MS],
      unit: 'ms',
      default: DEFAULT_ASR_LATENCY_MS,
      effect: 'restart-required',
      description:
        'Streaming chunk of the Nemotron speech engine, in milliseconds. A smaller chunk answers sooner; a larger one is usually more accurate. The engine reads it only at startup. Changing it here saves the value and never stops or starts an engine; the Voices page and forge_set_asr_latency can also restart an idle engine for you.',
      note: 'Saved now. The speech engine uses it the next time it starts.',
      store: 'asr',
    },
    ...aiDefinitions({
      feature: 'error-fix',
      key: 'errorFix',
      providers: ['openai'],
      what: 'writes error fix suggestions in the Errors review',
      note: 'Only OpenAI is supported for this feature.',
    }),
    ...aiDefinitions({
      feature: 'vegetation-describe',
      key: 'vegetationDescribe',
      providers: ['openai', 'local'],
      what: 'answers "Describe it" on the Vegetation page',
      note: 'local uses the Qwen chat engine on this computer.',
    }),
    ...aiDefinitions({
      feature: 'ui-translate',
      key: 'uiTranslate',
      providers: ['openai'],
      what: 'translates the interface when you ask for it in the language menu',
      note: 'Only OpenAI is supported for this feature.',
    }),
    {
      key: 'ui.language',
      label: 'Default interface language',
      group: 'interface',
      type: 'string',
      nullable: true,
      pattern: LANGUAGE_PATTERN,
      maxLength: 35,
      default: null,
      effect: 'live',
      description:
        'Studio-wide interface language, a BCP 47 code such as fr or de-CH (en for English, empty for none). A browser that chose its own language in the language menu keeps that choice; this applies to browsers that have not chosen one. Choosing a language does not translate anything or contact OpenAI.',
      store: 'language',
    },
    {
      key: 'tray.enabled',
      label: 'Windows tray icon',
      group: 'app',
      type: 'boolean',
      default: true,
      effect: 'restart-required',
      description:
        'Show the Forge icon in the Windows notification area, which also sends native alerts when a render or the queue finishes. It is created when the studio service starts, so a change applies after the service is restarted.',
      note: 'Applies the next time the studio service starts.',
      environment: {
        variables: ['FORGE_DISABLE_TRAY'],
        read: (env) =>
          env.FORGE_DISABLE_TRAY === '1' ? { value: false, variable: 'FORGE_DISABLE_TRAY' } : null,
      },
    },
    {
      key: 'power.keepAwake',
      label: 'Keep the computer awake',
      group: 'app',
      type: 'boolean',
      default: false,
      effect: 'live',
      description:
        'Ask Windows not to sleep while the studio service runs, so long renders are not interrupted. This keeps the computer drawing power. It is not saved across studio restarts and is available on Windows only.',
      store: 'power',
    },
    // Structured application log (docs/LOGGING.md). runtime/app-log.js and runtime/app_log.py
    // read the two level overrides straight from settings.sqlite (cached for 5 seconds) so that
    // every process follows a change without importing this registry.
    {
      key: 'logs.level',
      label: 'Studio log detail',
      group: 'app',
      type: 'enum',
      values: ['error', 'warn', 'info', 'debug', 'trace'],
      default: 'info',
      effect: 'live',
      description:
        'Lowest severity written to the studio log (.forge-runtime/logs.sqlite, shown under Diagnostics > Studio log). debug and trace record much more and use more disk; the log never contains prompts, typed text, file contents, paths or keys. Every Forge process follows a change within about 5 seconds.',
      environment: {
        variables: ['FORGE_LOG_LEVEL'],
        read(env) {
          const raw = String(env.FORGE_LOG_LEVEL ?? '')
            .trim()
            .toLowerCase();
          if (!raw) {
            return null;
          }
          const level = raw
            .split(',')
            .map((part) => part.trim())
            .find((part) => ['error', 'warn', 'info', 'debug', 'trace'].includes(part));
          return { value: level ?? 'info', variable: 'FORGE_LOG_LEVEL' };
        },
      },
    },
    {
      key: 'logs.componentLevels',
      label: 'Studio log detail per area',
      group: 'app',
      type: 'string',
      nullable: true,
      pattern:
        /^[a-z0-9-]+=(?:error|warn|info|debug|trace)(?:,[a-z0-9-]+=(?:error|warn|info|debug|trace))*$/,
      maxLength: 400,
      default: null,
      effect: 'live',
      description:
        'Optional per-area levels that override the studio log detail, for example queue=debug,engine=debug. Area names are the log components listed in docs/LOGGING.md. Empty for none.',
      environment: {
        variables: ['FORGE_LOG_LEVEL'],
        read: (env) =>
          String(env.FORGE_LOG_LEVEL ?? '').includes('=')
            ? {
                value: String(env.FORGE_LOG_LEVEL)
                  .split(',')
                  .map((part) => part.trim().toLowerCase())
                  .filter((part) => part.includes('='))
                  .join(','),
                variable: 'FORGE_LOG_LEVEL',
              }
            : null,
      },
    },
    {
      key: 'logs.retentionDays',
      label: 'Studio log retention',
      group: 'app',
      type: 'integer',
      unit: 'days',
      min: 1,
      max: 365,
      default: 14,
      effect: 'live',
      description:
        'Days the studio log keeps a record. Older records are deleted by the studio host every 6 hours.',
      environment: {
        variables: ['FORGE_LOG_RETENTION_DAYS'],
        read(env) {
          const value = Number(env.FORGE_LOG_RETENTION_DAYS);
          return Number.isInteger(value) && value >= 1
            ? { value, variable: 'FORGE_LOG_RETENTION_DAYS' }
            : null;
        },
      },
    },
    {
      key: 'logs.maxSizeMiB',
      label: 'Studio log size limit',
      group: 'app',
      type: 'integer',
      unit: 'MiB',
      min: 16,
      max: 4096,
      default: 256,
      effect: 'live',
      description:
        'Largest size, in MiB, of the studio log database. When it is larger, the oldest records are deleted first.',
      environment: {
        variables: ['FORGE_LOG_MAX_MIB'],
        read(env) {
          const value = Number(env.FORGE_LOG_MAX_MIB);
          return Number.isInteger(value) && value >= 16
            ? { value, variable: 'FORGE_LOG_MAX_MIB' }
            : null;
        },
      },
    },
  ].map((definition) =>
    Object.freeze({
      mutable: true,
      sensitive: false,
      note: '',
      ...definition,
    }),
  ),
);

const DEFINITIONS_BY_KEY = new Map(SETTING_DEFINITIONS.map((item) => [item.key, item]));

function switchEnvironment(env, variable) {
  const raw = env[variable];
  if (raw === '0' || raw === '1') {
    return { value: raw === '1', variable };
  }
  return null;
}

export function findSettingDefinition(key) {
  return DEFINITIONS_BY_KEY.get(key) ?? null;
}

/** A refusal with an HTTP-like status and a stable code, for routes and tools to report. */
export class SettingsError extends Error {
  constructor(status, code, message, problems = []) {
    super(message);
    this.name = 'SettingsError';
    // log-coverage: ignore -- sets a field on the error object, not a state change
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

/**
 * Checks and normalizes a value for a definition.
 *
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function validateSettingValue(definition, value) {
  if (value === null && definition.nullable) {
    return { ok: true, value: null };
  }
  if (definition.type === 'boolean') {
    return typeof value === 'boolean'
      ? { ok: true, value }
      : { ok: false, message: 'Use true or false.' };
  }
  if (definition.type === 'enum') {
    return definition.values.includes(value)
      ? { ok: true, value }
      : { ok: false, message: `Use one of: ${definition.values.join(', ')}.` };
  }
  if (definition.type === 'integer') {
    if (!Number.isInteger(value)) {
      return { ok: false, message: 'Use a whole number.' };
    }
    if (value < definition.min || value > definition.max) {
      return {
        ok: false,
        message: `Use a number from ${definition.min} to ${definition.max}${
          definition.unit ? ` ${definition.unit}` : ''
        }.`,
      };
    }
    return { ok: true, value };
  }
  if (definition.type === 'string') {
    if (typeof value !== 'string') {
      return { ok: false, message: 'Use text.' };
    }
    const text = value.trim();
    if (!text && definition.nullable) {
      return { ok: true, value: null };
    }
    if (text.length > definition.maxLength || !definition.pattern.test(text)) {
      return {
        ok: false,
        message: definition.key.endsWith('.model')
          ? 'Use a model id of 1 to 80 letters, digits, dots, dashes, underscores, colons or slashes.'
          : `Use text of at most ${definition.maxLength} letters, digits or dashes.`,
      };
    }
    return { ok: true, value: text };
  }
  return { ok: false, message: 'This setting has an unsupported type.' };
}

function toJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

function fromJson(text) {
  if (text === null || text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    log.warn('settings.value.parse.failed', { errorClass: error.name });
    return undefined;
  }
}

/** The runtime folder holding settings.sqlite, honouring FORGE_RUNTIME_DIR like other stores. */
export function defaultSettingsDirectory(env = process.env) {
  return env.FORGE_RUNTIME_DIR || path.join(repositoryRoot, '.forge-runtime');
}

const OVERRIDES_SQL = `
  CREATE TABLE IF NOT EXISTS settings_overrides (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    action TEXT NOT NULL,
    old_json TEXT,
    new_json TEXT,
    source TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS settings_audit_no_update BEFORE UPDATE ON settings_audit
    BEGIN SELECT RAISE(ABORT, 'settings_audit is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS settings_audit_no_delete BEFORE DELETE ON settings_audit
    BEGIN SELECT RAISE(ABORT, 'settings_audit is append-only'); END;
`;

/**
 * @param {object} [options]
 * @param {string} [options.directory] runtime folder; settings.sqlite is created on first write
 * @param {object} [options.env] environment to resolve against (default process.env)
 * @param {object} [options.adapters] `power` and `language` stores supplied by the host process:
 *   `{ get(), set(value), normalize?(value) }`; `set` may be async, `normalize` returns the
 *   canonical value or throws an Error with a user-facing message
 * @param {() => Date} [options.now]
 * @param {number} [options.cacheMs] how long persisted overrides are cached in this process
 * @param {(event: object) => void} [options.onChange] called after each applied change
 */
export function createSettings({
  directory = defaultSettingsDirectory(),
  env = process.env,
  adapters = {},
  now = () => new Date(),
  cacheMs = SETTINGS_CACHE_MS,
  onChange = null,
} = {}) {
  const file = path.join(directory, 'settings.sqlite');
  let cache = null;
  let lastReadError = null;

  function openForWrite() {
    fs.mkdirSync(directory, { recursive: true });
    const db = openDatabase(file, { name: 'settings', journal: null, directory });
    try {
      db.exec(OVERRIDES_SQL);
      ensureAiAssistTable(db);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  function openForRead() {
    return fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true, timeout: 2000 }) : null;
  }

  // Overrides are cached briefly so the queue can ask for a value on every job without opening
  // the database each time. A damaged or locked database keeps the last good copy (or the
  // defaults): a render must never fail because the settings file is unreadable.
  function overrides() {
    const stamp = Date.now();
    if (cache && stamp - cache.at < cacheMs) {
      return cache.map;
    }
    const map = new Map();
    let db = null;
    try {
      db = openForRead();
      const rows = db
        ?.prepare('SELECT key,value_json,updated_at,source FROM settings_overrides')
        .all();
      for (const row of rows ?? []) {
        map.set(row.key, {
          value: fromJson(row.value_json),
          updatedAt: row.updated_at,
          source: row.source,
        });
      }
      lastReadError = null;
    } catch (error) {
      if (/no such table/i.test(error.message)) {
        lastReadError = null;
        log.debug('settings.file.table.missing');
      } else {
        lastReadError = error.message;
        log.warn('settings.file.read.failed', {
          errorClass: error.name,
          errorCode: error.code,
          reason: cache ? 'kept_last_good' : 'using_defaults',
        });
        if (cache) {
          cache.at = stamp;
          return cache.map;
        }
      }
    } finally {
      db?.close();
    }
    cache = { at: stamp, map };
    return map;
  }

  function adapterFor(definition) {
    if (definition.store === 'asr') {
      const asrFile = asrLatencyFile(directory);
      return {
        get: () => readAsrLatency(asrFile),
        set: (value) => writeAsrLatency(value, asrFile),
      };
    }
    if (definition.store === 'power' || definition.store === 'language') {
      return adapters[definition.store] ?? null;
    }
    return null;
  }

  function readAiValue(definition) {
    let db = null;
    try {
      db = openForRead();
      const entry = readAiAssistEntry(db, definition.feature);
      return { value: entry[definition.field], updatedAt: entry.updatedAt };
    } catch (error) {
      // A missing ai_assist table in an older settings file simply means the defaults.
      if (/no such table/i.test(error.message)) {
        log.debug('settings.ai.table.missing', { settingKey: definition.key });
      } else {
        lastReadError = error.message;
        log.warn('settings.ai.read.failed', {
          settingKey: definition.key,
          errorClass: error.name,
          errorCode: error.code,
        });
      }
      return { value: definition.default, updatedAt: null };
    } finally {
      db?.close();
    }
  }

  function resolve(definition) {
    const locked = definition.environment?.read(env) ?? null;
    if (locked) {
      return {
        value: locked.value,
        source: 'environment',
        lockedBy: locked.variable,
        available: true,
        updatedAt: null,
      };
    }
    if (definition.store === 'ai') {
      const stored = readAiValue(definition);
      return {
        value: stored.value,
        source: 'store',
        lockedBy: null,
        available: true,
        updatedAt: stored.updatedAt,
      };
    }
    if (definition.store) {
      const adapter = adapterFor(definition);
      if (!adapter) {
        return {
          value: definition.default,
          source: 'default',
          lockedBy: null,
          available: false,
          updatedAt: null,
        };
      }
      let value = definition.default;
      try {
        const current = adapter.get();
        value = current === undefined ? definition.default : current;
      } catch (error) {
        lastReadError = error.message;
        log.warn('settings.store.read.failed', {
          settingKey: definition.key,
          errorClass: error.name,
          errorCode: error.code,
        });
      }
      return { value, source: 'store', lockedBy: null, available: true, updatedAt: null };
    }
    const stored = overrides().get(definition.key);
    if (stored && stored.value !== undefined && validateSettingValue(definition, stored.value).ok) {
      return {
        value: stored.value,
        source: 'override',
        lockedBy: null,
        available: true,
        updatedAt: stored.updatedAt,
      };
    }
    return {
      value: definition.default,
      source: 'default',
      lockedBy: null,
      available: true,
      updatedAt: null,
    };
  }

  function requireDefinition(key) {
    const definition = DEFINITIONS_BY_KEY.get(key);
    if (!definition) {
      throw new SettingsError(404, 'unknown_key', `Unknown setting: ${String(key).slice(0, 80)}.`);
    }
    return definition;
  }

  function lastChanges() {
    let db = null;
    try {
      db = openForRead();
      const rows = db
        ?.prepare(
          'SELECT a.key,a.action,a.new_json,a.source,a.changed_at FROM settings_audit a JOIN (SELECT key,MAX(id) AS id FROM settings_audit GROUP BY key) m ON a.id=m.id',
        )
        .all();
      return new Map(
        (rows ?? []).map((row) => [
          row.key,
          {
            action: row.action,
            value: fromJson(row.new_json) ?? null,
            via: row.source,
            at: row.changed_at,
          },
        ]),
      );
    } catch (error) {
      if (/no such table/i.test(error.message)) {
        log.debug('settings.audit.table.missing');
      } else {
        lastReadError = error.message;
        log.warn('settings.audit.read.failed', { errorClass: error.name, errorCode: error.code });
      }
      return new Map();
    } finally {
      db?.close();
    }
  }

  function describeWith(definition, changes) {
    const resolved = resolve(definition);
    return {
      key: definition.key,
      label: definition.label,
      group: definition.group,
      type: definition.type,
      ...(definition.values ? { values: definition.values } : {}),
      ...(definition.type === 'integer' ? { min: definition.min, max: definition.max } : {}),
      ...(definition.pattern
        ? { pattern: definition.pattern.source, maxLength: definition.maxLength }
        : {}),
      ...(definition.nullable ? { nullable: true } : {}),
      ...(definition.unit ? { unit: definition.unit } : {}),
      value: resolved.value,
      default: definition.default,
      isDefault: resolved.value === definition.default,
      source: resolved.source,
      locked: resolved.source === 'environment',
      lockedBy: resolved.lockedBy,
      mutable: definition.mutable,
      available: resolved.available,
      effect: definition.effect,
      note: definition.note,
      description: definition.description,
      updatedAt: resolved.updatedAt,
      lastChange: changes.get(definition.key) ?? null,
    };
  }

  function describe(key) {
    return describeWith(requireDefinition(key), lastChanges());
  }

  function recentChanges(limit = 10) {
    const count = Math.max(1, Math.min(100, Number(limit) || 10));
    let db = null;
    try {
      db = openForRead();
      const rows = db
        ?.prepare(
          'SELECT key,action,old_json,new_json,source,changed_at FROM settings_audit ORDER BY id DESC LIMIT ?',
        )
        .all(count);
      return (rows ?? []).map((row) => ({
        key: row.key,
        action: row.action,
        old: fromJson(row.old_json) ?? null,
        new: fromJson(row.new_json) ?? null,
        via: row.source,
        at: row.changed_at,
      }));
    } catch (error) {
      if (/no such table/i.test(error.message)) {
        log.debug('settings.audit.table.missing');
      } else {
        lastReadError = error.message;
        log.warn('settings.audit.read.failed', { errorClass: error.name, errorCode: error.code });
      }
      return [];
    } finally {
      db?.close();
    }
  }

  function list({ group } = {}) {
    if (group !== undefined && !SETTING_GROUPS.some((item) => item.id === group)) {
      throw new SettingsError(
        400,
        'unknown_group',
        `Unknown settings group: ${String(group).slice(0, 40)}.`,
      );
    }
    const changes = lastChanges();
    return SETTING_DEFINITIONS.filter((item) => !group || item.group === group).map((item) =>
      describeWith(item, changes),
    );
  }

  function parseChanges(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SETTING_CHANGES) {
      throw new SettingsError(400, 'invalid_request', `Send 1 to ${MAX_SETTING_CHANGES} changes.`);
    }
    return input.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new SettingsError(400, 'invalid_request', `Change ${index + 1} must be an object.`);
      }
      for (const field of Object.keys(item)) {
        if (field !== 'key' && field !== 'value') {
          throw new SettingsError(
            400,
            'unknown_field',
            `Change ${index + 1} has an unknown field: ${field.slice(0, 40)}.`,
          );
        }
      }
      if (typeof item.key !== 'string' || !Object.hasOwn(item, 'value')) {
        throw new SettingsError(
          400,
          'invalid_request',
          `Change ${index + 1} needs a key and a value.`,
        );
      }
      return { key: item.key, value: item.value };
    });
  }

  // Checks every item before anything is written, so an invalid one changes nothing.
  function plan(items, action) {
    const problems = [];
    const seen = new Set();
    const plans = [];
    for (const item of items) {
      const definition = DEFINITIONS_BY_KEY.get(item.key);
      if (!definition) {
        problems.push({
          key: String(item.key).slice(0, 80),
          code: 'unknown_key',
          message: 'Unknown setting.',
        });
        continue;
      }
      if (seen.has(item.key)) {
        problems.push({ key: item.key, code: 'duplicate_key', message: 'Listed more than once.' });
        continue;
      }
      seen.add(item.key);
      const current = resolve(definition);
      if (!definition.mutable) {
        problems.push({ key: item.key, code: 'immutable', message: 'This setting is read-only.' });
        continue;
      }
      if (!current.available) {
        problems.push({
          key: item.key,
          code: 'unavailable',
          message: 'This setting cannot be changed from this process.',
        });
        continue;
      }
      if (current.source === 'environment') {
        problems.push({
          key: item.key,
          code: 'locked_by_environment',
          message: `Locked by the environment variable ${current.lockedBy}. Change or remove it and restart the studio.`,
        });
        continue;
      }
      const target =
        action === 'reset'
          ? { ok: true, value: definition.default }
          : validateSettingValue(definition, item.value);
      if (!target.ok) {
        problems.push({ key: item.key, code: 'invalid_value', message: target.message });
        continue;
      }
      let after = target.value;
      if (action !== 'reset' && after !== null && adapterFor(definition)?.normalize) {
        try {
          after = adapterFor(definition).normalize(after);
        } catch (failure) {
          log.debug('settings.value.normalize.failed', {
            settingKey: item.key,
            errorClass: failure.name,
          });
          problems.push({ key: item.key, code: 'invalid_value', message: failure.message });
          continue;
        }
      }
      const storedRow = overrides().get(definition.key);
      const changed =
        current.value !== after ||
        (action === 'reset' && !definition.store && storedRow !== undefined);
      plans.push({
        definition,
        key: item.key,
        before: current.value,
        after,
        action,
        changed,
      });
    }
    return { plans, problems };
  }

  function refusalStatus(problems) {
    if (problems.some((item) => item.code === 'locked_by_environment')) {
      return 409;
    }
    if (problems.some((item) => item.code === 'immutable')) {
      return 403;
    }
    return problems.every((item) => item.code === 'unknown_key') ? 404 : 400;
  }

  function refuse(problems) {
    for (const problem of problems) {
      log.warn('settings.change.rejected', {
        ...(DEFINITIONS_BY_KEY.has(problem.key) ? { settingKey: problem.key } : {}),
        reason: problem.code,
      });
    }
    const first = problems[0];
    const status = refusalStatus(problems);
    throw new SettingsError(
      status,
      problems.length === 1 ? first.code : 'invalid_changes',
      problems.length === 1
        ? `${first.key}: ${first.message}`
        : `${problems.length} changes were refused and none was applied.`,
      problems,
    );
  }

  function writeDatabase(plans, via) {
    const db = openForWrite();
    const stamp = now().toISOString();
    const stop = log.time('settings.write.completed');
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const aiEntries = new Map();
        for (const item of plans) {
          const { definition } = item;
          if (definition.store === 'ai') {
            const entry =
              aiEntries.get(definition.feature) ?? readAiAssistEntry(db, definition.feature);
            aiEntries.set(definition.feature, { ...entry, [definition.field]: item.after });
          } else if (!definition.store) {
            if (item.action === 'reset') {
              db.prepare('DELETE FROM settings_overrides WHERE key=?').run(item.key);
            } else {
              db.prepare(
                'INSERT INTO settings_overrides(key,value_json,updated_at,source) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, source=excluded.source',
              ).run(item.key, toJson(item.after), stamp, via);
            }
          }
          db.prepare(
            'INSERT INTO settings_audit(key,action,old_json,new_json,source,changed_at) VALUES(?,?,?,?,?,?)',
          ).run(item.key, item.action, toJson(item.before), toJson(item.after), via, stamp);
        }
        for (const [feature, entry] of aiEntries) {
          writeAiAssistEntry(db, { feature, provider: entry.provider, model: entry.model }, stamp);
        }
        db.exec('COMMIT');
        stop({ count: plans.length });
      } catch (error) {
        db.exec('ROLLBACK');
        log.error('settings.write.failed', {
          count: plans.length,
          errorClass: error.name,
          errorCode: error.code,
        });
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async function apply(plans, via) {
    const writes = plans.filter((item) => item.changed);
    const applied = [];
    try {
      for (const item of writes) {
        const adapter =
          item.definition.store === 'ai' || !item.definition.store
            ? null
            : adapterFor(item.definition);
        if (adapter) {
          await adapter.set(item.after);
          applied.push({ item, adapter });
        }
      }
      if (writes.length) {
        writeDatabase(writes, via);
      }
    } catch (error) {
      const failures = [];
      for (const { item, adapter } of applied.reverse()) {
        try {
          await adapter.set(item.before);
        } catch (rollbackError) {
          failures.push(`${item.key}: ${rollbackError.message}`);
          log.error('settings.batch.restore.failed', {
            settingKey: item.key,
            errorClass: rollbackError.name,
            errorCode: rollbackError.code,
          });
        }
      }
      cache = null;
      log.warn('settings.batch.rollback', {
        count: writes.length,
        errorClass: error?.name,
        errorCode: error?.code,
      });
      if (error instanceof SettingsError) {
        throw error;
      }
      throw new SettingsError(
        500,
        'apply_failed',
        `${String(error.message).slice(0, 300)} No setting was changed.${
          failures.length ? ` Could not restore: ${failures.join('; ').slice(0, 300)}.` : ''
        }`,
      );
    }
    cache = null;
    for (const item of writes) {
      if (item.action === 'reset') {
        log.info('settings.value.reset', { settingKey: item.key, trigger: via });
      } else {
        log.info('settings.value.changed', {
          settingKey: item.key,
          source: item.definition.store ? 'store' : 'override',
          trigger: via,
        });
      }
    }
    const results = plans.map((item) => ({
      key: item.key,
      action: item.action,
      changed: item.changed,
      old: item.before,
      new: item.after,
      effect: item.definition.effect,
      restartRequired: item.changed && item.definition.effect === 'restart-required',
      note: item.definition.note,
    }));
    if (writes.length) {
      onChange?.({ via, changes: results.filter((item) => item.changed) });
    }
    return results;
  }

  function requireVia(via) {
    if (!CHANGE_SOURCES.includes(via)) {
      log.warn('settings.change.rejected', { reason: 'unknown_source' });
      throw new SettingsError(400, 'invalid_request', 'Unknown change source.');
    }
    return via;
  }

  return {
    directory,
    file,
    /** The effective value, for consumers. Never throws for a registered key. */
    get(key) {
      return resolve(requireDefinition(key)).value;
    },
    describe,
    /** Value and where it came from, without the descriptive fields. */
    inspect(key) {
      const { value, source, lockedBy } = resolve(requireDefinition(key));
      return { value, source, lockedBy };
    },
    list,
    recentChanges,
    groups: () => SETTING_GROUPS,
    /** Last settings-file read error, or null. For diagnostics only. */
    readError: () => lastReadError,
    invalidate() {
      cache = null;
    },

    /** Applies 1 to 20 changes all-or-nothing. Rejects with a SettingsError listing problems. */
    async set(input, { via = 'ui' } = {}) {
      requireVia(via);
      const { plans, problems } = plan(parseChanges(input), 'set');
      if (problems.length) {
        refuse(problems);
      }
      return { results: await apply(plans, via) };
    },

    /** Puts one key, or every changeable key of a group, back to its default. */
    async reset({ key, group } = {}, { via = 'ui' } = {}) {
      requireVia(via);
      if ((key === undefined) === (group === undefined)) {
        throw new SettingsError(400, 'invalid_request', 'Give either a key or a group.');
      }
      if (key !== undefined) {
        const { plans, problems } = plan([{ key, value: null }], 'reset');
        if (problems.length) {
          refuse(problems);
        }
        return { results: await apply(plans, via), skipped: [] };
      }
      if (!SETTING_GROUPS.some((item) => item.id === group)) {
        throw new SettingsError(400, 'unknown_group', 'Unknown settings group.');
      }
      const skipped = [];
      const items = [];
      for (const definition of SETTING_DEFINITIONS.filter((entry) => entry.group === group)) {
        const current = resolve(definition);
        if (current.source === 'environment') {
          skipped.push({
            key: definition.key,
            reason: 'locked_by_environment',
            lockedBy: current.lockedBy,
          });
        } else if (!definition.mutable || !current.available) {
          skipped.push({
            key: definition.key,
            reason: definition.mutable ? 'unavailable' : 'immutable',
          });
        } else {
          items.push({ key: definition.key, value: null });
        }
      }
      if (!items.length) {
        return { results: [], skipped };
      }
      const { plans, problems } = plan(items, 'reset');
      if (problems.length) {
        refuse(problems);
      }
      return { results: await apply(plans, via), skipped };
    },
  };
}

let defaultSettings = null;

/** The process-wide store used by consumers (the queue worker, engine launcher, host). */
export function defaultSettingsStore() {
  defaultSettings ||= createSettings();
  return defaultSettings;
}

/** Replaces the process-wide store, for example so the host can supply its adapters. */
export function configureDefaultSettings(options) {
  defaultSettings = createSettings(options);
  return defaultSettings;
}

/** Effective value of one setting: environment, then persisted override, then default. */
export function getSetting(key) {
  return defaultSettingsStore().get(key);
}

/**
 * Environment variables to give a Forge-started engine process so it follows the setting. Only a
 * persisted override is passed; a default, or an explicit variable of the parent, is left alone so
 * existing behaviour is unchanged.
 */
export function engineEnvironment({ settings = defaultSettingsStore(), env = process.env } = {}) {
  const result = {};
  for (const definition of SETTING_DEFINITIONS) {
    const mapping = definition.engineEnv;
    if (!mapping || (env[mapping.variable] ?? '') !== '') {
      continue;
    }
    const record = settings.inspect(definition.key);
    if (record.source === 'override') {
      result[mapping.variable] = mapping.format(record.value);
    }
  }
  return result;
}
