// Shared rules for Forge's structured application log (docs/LOGGING.md). This module is pure (no
// Node built-ins) so the Node logger (runtime/app-log.js), the browser logger (src/app-log.js) and
// the /api/logs routes apply exactly the same checks. runtime/app_log.py mirrors these rules; keep
// the component list, event pattern, field rules and limits in step with it.
import { redactText, topFrames } from './error-redaction.js';

/** Numeric severities. A logger emits a record when its level is >= the configured threshold. */
export const LOG_LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 });
export const LOG_LEVEL_NAMES = Object.freeze(['trace', 'debug', 'info', 'warn', 'error']);
export const DEFAULT_LOG_LEVEL = 'info';

/**
 * Every component a logger may use. Pick the one that owns the file you are instrumenting; add a
 * new name here (and in runtime/app_log.py) only when no existing one fits.
 */
export const LOG_COMPONENTS = Object.freeze([
  'assets',
  'asr',
  'catalog',
  'chat',
  'credentials',
  'desktop',
  'diagnostics',
  'engine',
  'errors',
  'game',
  'gpu',
  'http',
  'i18n',
  'image',
  'install',
  'log',
  'mcp',
  'megascans',
  'memory',
  'metadata',
  'model',
  'motion',
  'music',
  'power',
  'projects',
  'queue',
  'references',
  'runtime',
  'segmentation',
  'server',
  'settings',
  'sfx',
  'supervisor',
  'three-d',
  'thumbnails',
  'transcode',
  'trash',
  'tray',
  'ui',
  'unknown',
  'vegetation',
  'video',
  'voices',
  'world',
]);
const COMPONENT_SET = new Set(LOG_COMPONENTS);

/** Size caps. A record never exceeds roughly 6 KB once serialized. */
export const LOG_LIMITS = Object.freeze({
  eventLength: 96,
  messageLength: 300,
  stringFieldLength: 160,
  errorMessageLength: 300,
  fieldCount: 32,
  arrayItems: 20,
  fieldsJsonLength: 4096,
});

/** `<area>.<noun>.<verb>`: 2 to 6 lowercase segments, for example `job.state.changed`. */
export const EVENT_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){1,5}$/;

// Identifiers: job ids, model ids such as Qwen/Qwen-Image, engine ids, hashes. No spaces, so a
// sentence (a prompt, a description) can never pass as an id.
const ID_VALUE = /^[A-Za-z0-9._:+/-]{1,128}$/;
// Short machine words: states, reasons, route templates, HTTP methods. No spaces either.
const ENUM_VALUE = /^[A-Za-z0-9_/][A-Za-z0-9._:+/=-]{0,79}$/;

const NUMERIC_NAME =
  /(?:Ms|Sec|Seconds|Minutes|Hours|Days|Bytes|KiB|MiB|GiB|Count|Total|Index|Percent|Pct|Ratio|Tokens|Px|Width|Height|Fps|Frames|Steps|Seed|Size|Limit|Attempt|Attempts|Pid|Port|Status|Code|Version|Depth|Length|Max|Min|Rate|Score|Temperature|Position|Priority|Mb|Gb)$/;
const NUMERIC_NAMES = new Set([
  'attempt',
  'bytes',
  'count',
  'depth',
  'exitCode',
  'height',
  'index',
  'limit',
  'mib',
  'pid',
  'port',
  'position',
  'priority',
  'seed',
  'status',
  'steps',
  'total',
  'width',
]);
const BOOLEAN_NAME = /^(?:is|has|can|should|was|did|will|needs|uses)[A-Z]/;
const BOOLEAN_NAMES = new Set(['ok', 'ready', 'cached', 'forced', 'dryRun', 'retry', 'enabled']);
const ID_NAME = /(?:Id|Hash|Sha|Digest|Revision)$/;
const IDS_NAME = /Ids$/;
const ENUM_NAMES = new Set([
  'action',
  'arch',
  'aspect',
  'backend',
  'category',
  'code',
  'component',
  'decision',
  'device',
  'direction',
  'dtype',
  'engine',
  'errorClass',
  'errorCode',
  'extension',
  'feature',
  'format',
  'from',
  'host',
  'kind',
  'language',
  'locale',
  'method',
  'mode',
  'model',
  'nextState',
  'operation',
  'outcome',
  'page',
  'phase',
  'platform',
  'policy',
  'precision',
  'previousState',
  'protocol',
  'provider',
  'quality',
  'reason',
  'resolution',
  'result',
  'route',
  'scope',
  'settingKey',
  'signal',
  'source',
  'stage',
  'state',
  'status',
  'target',
  'to',
  'transport',
  'trigger',
  'type',
  'unit',
  'version',
  'view',
  'voiceMode',
]);

/** Fields with their own column. They are removed from the JSON `fields` object. */
export const COLUMN_FIELDS = Object.freeze({
  jobId: 'jobId',
  traceId: 'traceId',
  durationMs: 'durationMs',
});

export function isLogComponent(value) {
  return COMPONENT_SET.has(value);
}

export function isEventId(value) {
  return (
    typeof value === 'string' && value.length <= LOG_LIMITS.eventLength && EVENT_PATTERN.test(value)
  );
}

export function levelValue(name) {
  return LOG_LEVELS[name] ?? null;
}

/**
 * Parses a level specification such as `info` or `warn,queue=debug,http=trace`.
 *
 * @returns {{ level: string, components: Record<string, string>, problems: string[] }}
 */
export function parseLevelSpec(spec, fallback = DEFAULT_LOG_LEVEL) {
  const result = { level: fallback, components: {}, problems: [] };
  if (typeof spec !== 'string' || !spec.trim()) {
    return result;
  }
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim().toLowerCase();
    if (!part) {
      continue;
    }
    const [name, level] = part.includes('=') ? part.split('=', 2) : [null, part];
    if (!(level in LOG_LEVELS)) {
      result.problems.push(part.slice(0, 40));
      continue;
    }
    if (name === null) {
      result.level = level;
    } else if (COMPONENT_SET.has(name)) {
      result.components[name] = level;
    } else {
      result.problems.push(part.slice(0, 40));
    }
  }
  return result;
}

function cleanString(value, limit, redact) {
  const text = redact(String(value)).replace(/[\r\n\t]+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// After the shared redaction, a path under a private placeholder still ends in a folder and file
// name chosen by the user (an asset or document name). The log keeps only the extension.
const PRIVATE_PATH_TAIL = /(<home>|<projects>|<path>|<user>)((?:[\\/]+[^\\/\s"'<>|:*?]+)+)/g;

// Most logged strings are short machine words (states, ids, routes). The full redaction compiles
// several expressions per call, so a word that cannot contain a path, an email, a URL or a known
// key prefix, and is not the user name, is returned as is.
const PLAIN_TOKEN = /^[A-Za-z0-9._+=-]{0,80}$/;
const SECRET_PREFIX = /sk-|hf_|gh[pousr]_|github_pat_|xox[abprs]-|AKIA|eyJ/;

function isPlainToken(value, roots) {
  if (typeof value !== 'string' || !PLAIN_TOKEN.test(value) || SECRET_PREFIX.test(value)) {
    return false;
  }
  const user = typeof roots.user === 'string' ? roots.user.trim().toLowerCase() : '';
  return !(user.length >= 3 && value.toLowerCase().includes(user));
}

/**
 * The log's redaction: the shared error redaction (secrets, emails, user names, absolute paths
 * to placeholders), then file and folder names under <home>, <projects>, <path> and <user>
 * reduced to `<placeholder>/<file>.ext`. Paths inside the repository (<repo>) stay, so source
 * locations in error frames remain useful.
 */
export function redactLogText(value, roots = {}) {
  if (isPlainToken(value, roots)) {
    return value;
  }
  return redactText(value, roots).replace(PRIVATE_PATH_TAIL, (_match, placeholder, tail) => {
    const separator = tail.includes('\\') ? '\\' : '/';
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(tail);
    return `${placeholder}${separator}<file>${extension ? `.${extension[1]}` : ''}`;
  });
}

/**
 * Turns an Error (or anything thrown) into safe fields: class, code, message and frames. Never
 * throws; a non-object value contributes only its type name and text.
 *
 * @param {unknown} error the thrown value
 * @param {(text: string) => string} redact redaction applied to the message and stack frames
 * @returns {Record<string, unknown>} fields with errorClass and optional errorCode, errorMessage
 *   and errorFrames; empty for null or undefined.
 */
export function describeError(error, redact = redactLogText) {
  const fields = {};
  if (error === null || error === undefined) {
    return fields;
  }
  const isObject = typeof error === 'object' || typeof error === 'function';
  const name = isObject && typeof error.name === 'string' ? error.name : typeof error;
  fields.errorClass = /^[A-Za-z0-9_.$]{1,60}$/.test(name) ? name : 'Error';
  const code = isObject ? error.code : undefined;
  if ((typeof code === 'string' && ENUM_VALUE.test(code)) || Number.isFinite(code)) {
    fields.errorCode = code;
  }
  const message = isObject ? error.message : String(error);
  if (typeof message === 'string' && message) {
    fields.errorMessage = cleanString(message, LOG_LIMITS.errorMessageLength, redact);
  }
  if (isObject && typeof error.stack === 'string') {
    const frames = topFrames(redact(error.stack), 5).filter(Boolean);
    if (frames.length) {
      fields.errorFrames = frames.map((frame) => frame.slice(0, LOG_LIMITS.stringFieldLength));
    }
  }
  return fields;
}

function acceptNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function acceptId(value, redact) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && ID_VALUE.test(value)) {
    return cleanString(value, LOG_LIMITS.stringFieldLength, redact);
  }
  return undefined;
}

function acceptEnum(value, redact) {
  if (typeof value === 'string' && ENUM_VALUE.test(value)) {
    return cleanString(value, LOG_LIMITS.stringFieldLength, redact);
  }
  return undefined;
}

// Returns the accepted value, or undefined when the name or value is not allowed.
function acceptField(name, value, redact) {
  if (value === null) {
    return null;
  }
  if (BOOLEAN_NAMES.has(name) || BOOLEAN_NAME.test(name)) {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (IDS_NAME.test(name)) {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const items = value.slice(0, LOG_LIMITS.arrayItems).map((item) => acceptId(item, redact));
    return items.every((item) => item !== undefined) ? items : undefined;
  }
  if (ID_NAME.test(name) || name === 'id') {
    return acceptId(value, redact);
  }
  const isNumericName = NUMERIC_NAMES.has(name) || NUMERIC_NAME.test(name);
  if (typeof value === 'number') {
    return isNumericName ? acceptNumber(value) : undefined;
  }
  if (ENUM_NAMES.has(name)) {
    return acceptEnum(value, redact);
  }
  return undefined;
}

/**
 * Validates a field object against the allow-list. Never throws.
 *
 * @param {unknown} input the caller's field object
 * @param {(text: string) => string} redact redaction applied to every kept string
 * @returns {{ fields: Record<string, unknown>, dropped: string[] }}
 *   `dropped` lists rejected field names (developer-chosen identifiers, never values).
 */
export function sanitizeFields(input, redact = redactLogText) {
  const fields = {};
  const dropped = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (input !== undefined && input !== null) {
      dropped.push('(not-an-object)');
    }
    return { fields, dropped };
  }
  let kept = 0;
  for (const name of Object.keys(input)) {
    const safeName = /^[A-Za-z][A-Za-z0-9]{0,47}$/.test(name) ? name : '(invalid-name)';
    if (kept >= LOG_LIMITS.fieldCount) {
      dropped.push(safeName);
      continue;
    }
    let value;
    try {
      value = input[name];
    } catch {
      // A throwing getter is the caller's bug; the field is dropped and counted.
      dropped.push(safeName);
      continue;
    }
    if (value === undefined) {
      continue;
    }
    if (name === 'error' || name === 'err') {
      Object.assign(fields, describeError(value, redact));
      kept += 1;
      continue;
    }
    if (safeName !== name) {
      dropped.push(safeName);
      continue;
    }
    // Callers often pass a path.extname() result (".png"); the value rule wants a bare word.
    const candidate =
      name === 'extension' && typeof value === 'string' ? value.replace(/^\./, '') : value;
    const accepted = acceptField(name, candidate, redact);
    if (accepted === undefined) {
      dropped.push(name);
      continue;
    }
    fields[name] = accepted;
    kept += 1;
  }
  return { fields, dropped };
}

/** Redacts and caps a constant human-readable sentence. Returns '' for non-strings. */
export function sanitizeMessage(message, redact = redactLogText) {
  if (typeof message !== 'string' || !message) {
    return '';
  }
  return cleanString(message, LOG_LIMITS.messageLength, redact);
}

/**
 * Builds the stored shape of one record from validated parts. `fields` must already be sanitized.
 * Column fields (jobId, traceId, durationMs) are lifted out of the JSON object.
 */
export function buildRecord({
  ts,
  level,
  component,
  event,
  message = '',
  fields = {},
  dropped = [],
  process = 'unknown',
  pid = 0,
  seq = 0,
  traceId = null,
  jobId = null,
}) {
  const rest = { ...fields };
  const record = {
    ts,
    level,
    component,
    event,
    message,
    process,
    pid,
    seq,
    traceId: typeof rest.traceId === 'string' ? rest.traceId : traceId,
    jobId: rest.jobId === undefined || rest.jobId === null ? jobId : String(rest.jobId),
    durationMs: typeof rest.durationMs === 'number' ? Math.round(rest.durationMs) : null,
    count: 1,
    firstTs: null,
    fields: rest,
  };
  delete rest.traceId;
  delete rest.jobId;
  delete rest.durationMs;
  if (dropped.length) {
    rest.droppedFields = dropped.length;
    rest.droppedFieldNames = dropped.slice(0, 8);
  }
  if (JSON.stringify(rest).length > LOG_LIMITS.fieldsJsonLength) {
    record.fields = { fieldsTruncated: true, droppedFields: Object.keys(rest).length };
  }
  return record;
}

// The segment after one of these is a user-chosen or generated name (a project folder, an asset
// file, a job id), so it is always replaced even when it looks like a plain word.
const PARAMETER_PARENTS = new Set([
  'assets',
  'chats',
  'clips',
  'conversations',
  'errors',
  'files',
  'jobs',
  'metadata',
  'project',
  'projects',
  'references',
  'thumbnails',
  'trash',
  'voices',
]);

/** Maps a concrete path such as /api/jobs/42?x=1 to a template such as /api/jobs/:param. */
export function routeTemplate(pathname) {
  if (typeof pathname !== 'string') {
    return '';
  }
  const clean = pathname.split(/[?#]/)[0];
  const parts = clean.split('/').filter(Boolean).slice(0, 8);
  const template = parts.map((part, index) => {
    const isAfterParameterParent = index > 0 && PARAMETER_PARENTS.has(parts[index - 1]);
    return !isAfterParameterParent && /^[a-z][a-z0-9-]{0,40}$/.test(part) ? part : ':param';
  });
  return `/${template.join('/')}`;
}
