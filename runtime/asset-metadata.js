// Generation provenance (model, prompt, settings) for every project asset.
//
// One small SQLite database lives in each project folder (.forge-meta.sqlite) so
// the information travels with the project. Hidden names are skipped by the asset
// listing, so the database is never shown as an asset. Everything here uses
// parameterised SQL and never throws into callers that must not fail (job
// completion, rename, trash): the exported record*/safe helpers log and continue.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCatalog } from './model-catalog.js';

export const SCHEMA_VERSION = 1;
export const DB_NAME = '.forge-meta.sqlite';
export const LIMITS = {
  prompt: 20000,
  negative: 4000,
  secondary: 20000,
  title: 200,
  name: 120,
  settingsBytes: 16384,
  referencesBytes: 8192,
  references: 12,
};
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// forge-<job id>[-converted[-N]]*.<ext>
const forgeName =
  /^forge-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})((?:-converted(?:-\d+)?)*)\.([a-z0-9]{2,5})$/i;
const convertedSuffix = /-converted(?:-\d+)?$/i;

let toolVersion;
function studioVersion() {
  if (toolVersion === undefined) {
    try {
      toolVersion = String(
        JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || '',
      ).slice(0, 40);
    } catch {
      toolVersion = '';
    }
  }
  return toolVersion;
}
const safeErrorCode = (error) =>
  typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/i.test(error.code) ? error.code : 'UNKNOWN';
function warn(logger, operation, error) {
  try {
    (logger || console.warn)(`WARN operation=${operation} error_code=${safeErrorCode(error)}`);
  } catch {
    // Logging must never change the outcome of the caller.
  }
}

// ---------------------------------------------------------------- sanitising
// Same secret patterns the diagnostics page redacts, applied to free text.
export function redact(text) {
  return String(text)
    .replace(/\b(?:hf_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|hf[_-]?token|password|secret|x-lab-session)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    );
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  // eslint-disable-next-line no-control-regex -- Drop control characters except tab and newlines.
  return redact(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')).slice(0, max);
}
const secretKey =
  /(?:^|_)(?:api_?key|access_?token|hf_?token|token|secret|password|authorization|endpoint|url|path|env)$/i;
// Keep plain scalar settings only: no nested objects, no secret-looking keys, no
// absolute paths or URLs.
function cleanSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) || secretKey.test(key)) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = redact(value).slice(0, 200);
    } else if (value === null) {
      out[key] = null;
    }
  }
  while (JSON.stringify(out).length > LIMITS.settingsBytes) {
    delete out[Object.keys(out).at(-1)];
  }
  return out;
}
function cleanReferences(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const out = [];
  for (const item of list.slice(0, LIMITS.references)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = {};
    for (const key of ['name', 'path', 'id', 'mime']) {
      const value = text(item[key], 200);
      if (value && !/^[a-z]:[\\/]/i.test(value) && !value.startsWith('/')) {
        entry[key] = value;
      }
    }
    if (Number.isSafeInteger(item.size) && item.size >= 0) {
      entry.size = item.size;
    }
    if (Object.keys(entry).length) {
      out.push(entry);
    }
  }
  while (JSON.stringify(out).length > LIMITS.referencesBytes) {
    out.pop();
  }
  return out;
}
function isoOrNull(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

// Same rules as references.js / asset-output.js: forward slashes, no empty or
// dot segments, nothing hidden, no drive letters.
export function validateAssetPath(rel) {
  if (
    typeof rel !== 'string' ||
    !rel ||
    rel.length > 500 ||
    rel.includes('\\') ||
    rel.includes(':') ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in paths.
    /[\x00-\x1f]/.test(rel) ||
    rel.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  ) {
    throw Error('Invalid asset path.');
  }
  return rel;
}

// ----------------------------------------------------------- model resolution
const catalogById = new Map(modelCatalog.map((model) => [model.id, model]));
const jobModelId = {
  music: 'music',
  sfx: 'sfx',
  images: 'images',
  video: 'video',
  voices: 'tts',
  '3d': '3d-hunyuan',
  trellis: '3d-trellis',
  segmentation: 'segmentation',
  motion: 'motion-hy',
  'motion-bricks': 'motion-bricks',
};
const jobKind = {
  music: 'music',
  sfx: 'sfx',
  images: 'image',
  video: 'video',
  voices: 'voice',
  '3d': '3d',
  trellis: '3d',
  segmentation: 'mask',
  motion: 'motion',
  'motion-bricks': 'motion',
  world: 'world',
};
export function modelForId(id) {
  const model = catalogById.get(id);
  return model
    ? { name: model.name, id: model.id, version: model.folder || null }
    : { name: id, id, version: null };
}
// Cloned and designed voices run on their own Qwen3-TTS checkpoints, not the preset one.
const voiceModeModelId = { clone: 'tts-base', design: 'tts-voicedesign' };
function modelIdForJob(job) {
  if (job.type === 'world') {
    return job.request?.model;
  }
  if (job.type === 'voices' && voiceModeModelId[job.request?.mode]) {
    return voiceModeModelId[job.request.mode];
  }
  return jobModelId[job.type];
}
function modelForJob(job) {
  const id = modelIdForJob(job);
  const model = modelForId(id || job.type);
  if (job.type === '3d' && job.request?.texture === true) {
    model.version = [model.version, 'with texture stage'].filter(Boolean).join(' + ');
  }
  return model;
}

// ------------------------------------------------------------------- building
function extensionKind(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tga', '.gif'].includes(ext)) {
    return rel.startsWith('masks/') ? 'mask' : 'image';
  }
  if (['.wav', '.mp3', '.flac', '.ogg', '.opus'].includes(ext)) {
    return 'audio';
  }
  if (['.mp4', '.webm'].includes(ext)) {
    return 'video';
  }
  if (['.txt', '.json'].includes(ext)) {
    return 'text';
  }
  return ext === '.bvh' ? 'motion' : '3d';
}
const promptKeys = {
  music: ['style', 'negative', 'lyrics', 'title'],
  voices: ['text', null, 'instruct', null],
  images: ['prompt', 'negative_prompt', null, null],
  video: ['prompt', 'negative_prompt', null, null],
};
const leftOut = new Set([
  'references',
  'first_frame',
  'last_frame',
  'reference_videos',
  'reference_audios',
  'referenceFrom',
  'pose',
  'prompt',
  'style',
  'lyrics',
  'text',
  'negative',
  'negative_prompt',
  'instruct',
  'title',
  // The staged clip is a private copy; its name and transcript are recorded in other rows.
  'reference_audio',
  'voice_description',
]);
// A voice design stores its description where preset voices store direction.
function secondaryValue(type, request, key) {
  if (type === 'voices' && request.mode === 'design') {
    return request.voice_description ?? null;
  }
  return key ? request[key] : null;
}
function referenceEntries(job) {
  const ids = Array.isArray(job.request?.references)
    ? job.request.references
    : typeof job.request?.pose === 'string'
      ? [job.request.pose]
      : [];
  const mimes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bvh': 'text/plain',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
  };
  const entry = (id, label) => ({
    name: label ? `${label} · ${id}` : id,
    id,
    mime: mimes[path.extname(id).toLowerCase()] || undefined,
  });
  // Video renders can also start from a first/last frame or use reference clips.
  const request = job.request || {};
  const extras = [
    ['First frame', request.first_frame],
    ['Last frame', request.last_frame],
    ['Source sound', request.source_audio],
    ['Voice reference', request.reference_audio],
    ...(Array.isArray(request.reference_videos) ? request.reference_videos : []).map((id) => [
      'Reference video',
      id,
    ]),
    ...(Array.isArray(request.reference_audios) ? request.reference_audios : []).map((id) => [
      'Reference audio',
      id,
    ]),
  ]
    .filter(([, id]) => typeof id === 'string')
    .map(([label, id]) => entry(id, label));
  return [...extras, ...ids.filter((id) => typeof id === 'string').map((id) => entry(id))];
}
// A track that extends or re-synthesizes another names the original as its parent.
function derivedParent(type, request) {
  if (type !== 'music' || !request.operation || typeof request.source !== 'string') {
    return null;
  }
  try {
    return validateAssetPath(request.source);
  } catch {
    return null;
  }
}
// Pure: turns a queue job (as returned by JobQueue.get or read from jobs.sqlite)
// into the metadata record for its output file.
export function buildJobMetadata(job, outputPath, options = {}) {
  const request = job?.request && typeof job.request === 'object' ? job.request : {};
  const keys = promptKeys[job.type] || ['prompt', null, null, null];
  const settings = {};
  for (const [key, value] of Object.entries(request)) {
    if (!leftOut.has(key)) {
      settings[key] = value;
    }
  }
  // A render chained to an earlier one records where its input came from.
  const chain = request.referenceFrom;
  if (chain && typeof chain === 'object') {
    if (typeof chain.jobId === 'string') {
      settings.chained_from_job = chain.jobId;
    }
    if (typeof chain.output === 'string') {
      settings.chained_from_asset = chain.output;
    }
  }
  const started = isoOrNull(job.startedAt);
  const finished = isoOrNull(job.finishedAt);
  const references = referenceEntries(job).map((entry) => ({
    ...entry,
    ...(options.referenceSizes?.[entry.id] === undefined
      ? {}
      : { size: options.referenceSizes[entry.id] }),
  }));
  return normalize({
    path: outputPath,
    kind: jobKind[job.type] || extensionKind(outputPath),
    source: options.source || 'job',
    jobId: job.id,
    jobType: job.type,
    model: modelForJob({ ...job, request }),
    prompt: request[keys[0]],
    negative: keys[1] ? request[keys[1]] : null,
    secondary: secondaryValue(job.type, request, keys[2]),
    title: keys[3] ? request[keys[3]] : null,
    settings,
    references,
    parentPath: options.parentPath || derivedParent(job.type, request),
    createdAt:
      finished || isoOrNull(job.updatedAt) || options.createdAt || new Date().toISOString(),
    startedAt: started,
    finishedAt: finished,
    backfilled: options.backfilled === true,
  });
}
// For assets with no queue job: saved chat/transcript/decision text and conversions.
export function buildProvenanceMetadata(input) {
  return normalize({
    path: input.path,
    kind: input.kind || extensionKind(input.path),
    source: input.source || 'unknown',
    jobId: input.jobId || null,
    jobType: input.jobType || null,
    model: input.model || null,
    prompt: input.prompt,
    negative: input.negative,
    secondary: input.secondary,
    title: input.title,
    settings: input.settings,
    references: input.references,
    parentPath: input.parentPath || null,
    createdAt: input.createdAt || new Date().toISOString(),
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    backfilled: input.backfilled === true,
  });
}
function normalize(input) {
  const rel = validateAssetPath(input.path);
  const model =
    input.model && typeof input.model === 'object'
      ? {
          name: text(input.model.name, LIMITS.name),
          id: text(input.model.id, LIMITS.name),
          version: text(input.model.version, LIMITS.name),
        }
      : null;
  const settings = cleanSettings(input.settings);
  const seed = Number.isSafeInteger(settings.seed) && settings.seed >= 0 ? settings.seed : null;
  return {
    path: rel,
    kind: text(input.kind, 20) || extensionKind(rel),
    source: ['job', 'conversion', 'saved-text', 'import', 'unknown'].includes(input.source)
      ? input.source
      : 'unknown',
    jobId: input.jobId && jobIdPattern.test(input.jobId) ? input.jobId : null,
    jobType: text(input.jobType, 30),
    model: model && (model.name || model.id) ? model : null,
    prompt: text(input.prompt, LIMITS.prompt),
    negative: text(input.negative, LIMITS.negative),
    secondary: text(input.secondary, LIMITS.secondary),
    title: text(input.title, LIMITS.title),
    seed,
    settings,
    references: cleanReferences(input.references),
    parentPath: input.parentPath ? validateAssetPath(input.parentPath) : null,
    createdAt: isoOrNull(input.createdAt) || new Date().toISOString(),
    startedAt: isoOrNull(input.startedAt),
    finishedAt: isoOrNull(input.finishedAt),
    backfilled: input.backfilled === true,
  };
}

// ------------------------------------------------------------------- database
class NewerSchemaError extends Error {}
const migrations = [
  // user_version 0 -> 1
  (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS asset_meta (
      path TEXT PRIMARY KEY, kind TEXT, source TEXT NOT NULL, job_id TEXT, job_type TEXT,
      model_name TEXT, model_id TEXT, model_version TEXT,
      prompt TEXT, negative TEXT, secondary TEXT, title TEXT, seed INTEGER,
      settings_json TEXT NOT NULL DEFAULT '{}', references_json TEXT NOT NULL DEFAULT '[]',
      parent_path TEXT, created_at TEXT, started_at TEXT, finished_at TEXT,
      backfilled INTEGER NOT NULL DEFAULT 0, tool_version TEXT, schema_version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS asset_meta_model ON asset_meta(model_name);
    CREATE INDEX IF NOT EXISTS asset_meta_job ON asset_meta(job_id);
    CREATE INDEX IF NOT EXISTS asset_meta_created ON asset_meta(created_at);`);
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS asset_meta_fts USING fts5(
        path UNINDEXED, prompt, negative, secondary, title, model_name)`);
    } catch {
      // This SQLite build has no FTS5; search falls back to LIKE.
    }
  },
];
const isCorrupt = (error) =>
  [11, 26].includes(error?.errcode) ||
  /malformed|not a database|corrupt|disk image/i.test(String(error?.message));

function initialise(db) {
  db.exec('PRAGMA busy_timeout=5000');
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > migrations.length) {
    throw new NewerSchemaError('The asset metadata database was written by a newer Forge.');
  }
  while (version < migrations.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migrations[version](db);
      version++;
      db.exec(`PRAGMA user_version=${version}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original error is the useful one.
      }
      throw error;
    }
  }
  // Touch the table so a damaged file fails here rather than mid-operation.
  db.prepare('SELECT COUNT(*) FROM asset_meta').get();
}
function quarantine(file, logger) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const target = path.join(path.dirname(file), `.forge-meta.corrupt-${stamp}.sqlite`);
  fs.renameSync(file, target);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.renameSync(file + suffix, target + suffix);
    } catch {
      // Companion files are optional.
    }
  }
  warn(logger, 'asset_meta_quarantine', { code: 'CORRUPT' });
}
// Opens (and migrates) the project's database. Returns null when it does not
// exist and create is false. A corrupt file is renamed aside and replaced.
function openDb(folder, { create = true, logger } = {}) {
  const file = path.join(folder, DB_NAME);
  let existing = false;
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw Error('The asset metadata database is not a regular file.');
    }
    existing = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (!existing && !create) {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let db;
    try {
      db = new DatabaseSync(file);
      initialise(db);
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // Already closed.
      }
      if (attempt === 0 && existing && isCorrupt(error)) {
        quarantine(file, logger);
        existing = false;
        continue;
      }
      throw error;
    }
  }
  return null;
}
function withDb(folder, options, work) {
  const db = openDb(folder, options);
  if (!db) {
    return options.fallback;
  }
  try {
    return work(db);
  } finally {
    try {
      db.close();
    } catch {
      // Nothing useful to do.
    }
  }
}
const hasFts = (db) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='asset_meta_fts'").get();
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the useful one.
    }
    throw error;
  }
}
function writeRow(db, meta, { overwrite }) {
  const conflict = overwrite
    ? `ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, source=excluded.source, job_id=excluded.job_id,
        job_type=excluded.job_type, model_name=excluded.model_name, model_id=excluded.model_id,
        model_version=excluded.model_version, prompt=excluded.prompt, negative=excluded.negative,
        secondary=excluded.secondary, title=excluded.title, seed=excluded.seed,
        settings_json=excluded.settings_json, references_json=excluded.references_json,
        parent_path=excluded.parent_path, created_at=excluded.created_at,
        started_at=excluded.started_at, finished_at=excluded.finished_at,
        backfilled=excluded.backfilled, tool_version=excluded.tool_version,
        schema_version=excluded.schema_version`
    : 'ON CONFLICT(path) DO NOTHING';
  const result = db
    .prepare(
      `INSERT INTO asset_meta (path, kind, source, job_id, job_type, model_name, model_id,
        model_version, prompt, negative, secondary, title, seed, settings_json, references_json,
        parent_path, created_at, started_at, finished_at, backfilled, tool_version, schema_version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ${conflict}`,
    )
    .run(
      meta.path,
      meta.kind,
      meta.source,
      meta.jobId,
      meta.jobType,
      meta.model?.name ?? null,
      meta.model?.id ?? null,
      meta.model?.version ?? null,
      meta.prompt,
      meta.negative,
      meta.secondary,
      meta.title,
      meta.seed,
      JSON.stringify(meta.settings),
      JSON.stringify(meta.references),
      meta.parentPath,
      meta.createdAt,
      meta.startedAt,
      meta.finishedAt,
      meta.backfilled ? 1 : 0,
      studioVersion(),
      SCHEMA_VERSION,
    );
  if (!result.changes) {
    return false;
  }
  if (hasFts(db)) {
    db.prepare('DELETE FROM asset_meta_fts WHERE path=?').run(meta.path);
    db.prepare(
      'INSERT INTO asset_meta_fts (path, prompt, negative, secondary, title, model_name) VALUES (?,?,?,?,?,?)',
    ).run(
      meta.path,
      meta.prompt ?? '',
      meta.negative ?? '',
      meta.secondary ?? '',
      meta.title ?? '',
      meta.model?.name ?? '',
    );
  }
  return true;
}

// Insert or replace the record for one asset.
export function upsertAssetMeta(folder, meta, { logger } = {}) {
  return withDb(folder, { logger }, (db) =>
    transaction(db, () => writeRow(db, meta, { overwrite: true })),
  );
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function publicRecord(row) {
  const started = row.started_at ? Date.parse(row.started_at) : NaN;
  const finished = row.finished_at ? Date.parse(row.finished_at) : NaN;
  return {
    schemaVersion: row.schema_version,
    asset: { path: row.path, kind: row.kind, createdAt: row.created_at },
    source: row.source,
    backfilled: row.backfilled === 1,
    // Queue job type for renders; saved text records chat, transcript or decision here.
    type: row.job_type,
    job: row.job_id ? { id: row.job_id, type: row.job_type } : null,
    model:
      row.model_name || row.model_id
        ? { name: row.model_name, id: row.model_id, version: row.model_version }
        : null,
    prompt: {
      text: row.prompt,
      negative: row.negative,
      secondary: row.secondary,
      title: row.title,
    },
    seed: row.seed,
    settings: parseJson(row.settings_json, {}),
    references: parseJson(row.references_json, []),
    timing: {
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      seconds:
        Number.isFinite(started) && Number.isFinite(finished) && finished >= started
          ? Math.round((finished - started) / 1000)
          : null,
    },
    parent: row.parent_path ? { path: row.parent_path } : null,
    tool: { name: 'Forge', version: row.tool_version || null },
  };
}
export function readAssetMeta(folder, rel, { logger } = {}) {
  validateAssetPath(rel);
  return withDb(folder, { create: false, logger, fallback: null }, (db) => {
    const row = db.prepare('SELECT * FROM asset_meta WHERE path=?').get(rel);
    return row ? publicRecord(row) : null;
  });
}
// Compact per-asset summaries for the library list: one query per project.
export function readMetaIndex(folder, { logger } = {}) {
  return withDb(folder, { create: false, logger, fallback: {} }, (db) => {
    const out = {};
    const rows = db
      .prepare(
        'SELECT path, model_name, model_id, seed, source, backfilled, substr(prompt, 1, 200) AS prompt FROM asset_meta',
      )
      .all();
    for (const row of rows) {
      out[row.path] = {
        model: row.model_name || row.model_id || null,
        prompt: row.prompt,
        seed: row.seed,
        source: row.source,
        backfilled: row.backfilled === 1,
      };
    }
    return out;
  });
}
const searchTokens = (query) =>
  String(query || '')
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_]+/gu)
    ?.slice(0, 8) || [];
// Matches prompt, negative prompt, secondary text, title and model name.
export function searchAssetMeta(folder, query, { limit = 500, logger } = {}) {
  const tokens = searchTokens(query);
  if (!tokens.length) {
    return [];
  }
  const max = Math.max(1, Math.min(1000, Number(limit) || 500));
  return withDb(folder, { create: false, logger, fallback: [] }, (db) => {
    if (hasFts(db)) {
      const match = tokens.map((token) => `"${token.replaceAll('"', '')}"*`).join(' ');
      try {
        return db
          .prepare('SELECT path FROM asset_meta_fts WHERE asset_meta_fts MATCH ? LIMIT ?')
          .all(match, max)
          .map((row) => row.path);
      } catch (error) {
        warn(logger, 'asset_meta_search', error);
      }
    }
    const escaped = tokens.join(' ').replace(/[\\%_]/g, (c) => `\\${c}`);
    return db
      .prepare(
        `SELECT path FROM asset_meta WHERE (coalesce(prompt,'') || ' ' || coalesce(negative,'') || ' ' ||
          coalesce(secondary,'') || ' ' || coalesce(title,'') || ' ' || coalesce(model_name,''))
          LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(`%${escaped}%`, max)
      .map((row) => row.path);
  });
}
// Rename: keep the record and any child records pointing at it.
export function moveAssetMeta(folder, from, to, { logger } = {}) {
  validateAssetPath(from);
  validateAssetPath(to);
  return withDb(folder, { create: false, logger, fallback: false }, (db) =>
    transaction(db, () => {
      db.prepare('DELETE FROM asset_meta WHERE path=?').run(to);
      const moved = db.prepare('UPDATE asset_meta SET path=? WHERE path=?').run(to, from).changes;
      db.prepare('UPDATE asset_meta SET parent_path=? WHERE parent_path=?').run(to, from);
      if (hasFts(db)) {
        db.prepare('DELETE FROM asset_meta_fts WHERE path=?').run(to);
        db.prepare('UPDATE asset_meta_fts SET path=? WHERE path=?').run(to, from);
      }
      return moved > 0;
    }),
  );
}
export function deleteAssetMeta(folder, paths, { logger } = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(
    (item) => typeof item === 'string' && item,
  );
  if (!list.length) {
    return 0;
  }
  return withDb(folder, { create: false, logger, fallback: 0 }, (db) =>
    transaction(db, () => {
      let deleted = 0;
      for (const rel of list) {
        deleted += db.prepare('DELETE FROM asset_meta WHERE path=?').run(rel).changes;
        if (hasFts(db)) {
          db.prepare('DELETE FROM asset_meta_fts WHERE path=?').run(rel);
        }
      }
      return deleted;
    }),
  );
}

// ------------------------------------------------------------- jobs lookups
export function defaultJobLookup({
  directory = process.env.FORGE_RUNTIME_DIR || path.join(appRoot, '.forge-runtime'),
} = {}) {
  return function lookup(ids) {
    const found = new Map();
    const file = path.join(directory, 'jobs.sqlite');
    if (!ids.length || !fs.existsSync(file)) {
      return found;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=2000');
      const statement = db.prepare('SELECT * FROM jobs WHERE id=?');
      for (const id of ids) {
        const row = statement.get(id);
        if (!row) {
          continue;
        }
        found.set(id, {
          id: row.id,
          type: row.type,
          projectId: row.project_id,
          status: row.status,
          request: parseJson(row.request, {}),
          output: row.output,
          updatedAt: row.updated_at,
          startedAt: row.started_at || null,
          finishedAt: row.finished_at || null,
        });
      }
    } finally {
      db.close();
    }
    return found;
  };
}

// ------------------------------------------------------------------ recording
function referenceSizes(folder, job) {
  const sizes = {};
  for (const entry of referenceEntries(job)) {
    try {
      const info = fs.lstatSync(path.join(folder, '.forge-inputs', entry.id));
      if (info.isFile()) {
        sizes[entry.id] = info.size;
      }
    } catch {
      // The staged copy may already be gone; size is optional.
    }
  }
  return sizes;
}
// Called by the queue after a job's output is saved. Never throws.
export function recordJobOutput(job, folder, { logger } = {}) {
  try {
    if (!job?.output || !job.id) {
      return false;
    }
    const meta = buildJobMetadata(job, job.output, { referenceSizes: referenceSizes(folder, job) });
    return upsertAssetMeta(folder, meta, { logger });
  } catch (error) {
    warn(logger, 'asset_meta_record', error);
    return false;
  }
}
// A converted copy inherits its parent's generation details.
export function recordConversion(folder, parentPath, outputPath, conversion, { logger } = {}) {
  try {
    const parent = readAssetMeta(folder, parentPath, { logger });
    const meta = buildProvenanceMetadata({
      path: outputPath,
      source: 'conversion',
      kind: parent?.asset.kind,
      jobId: parent?.job?.id,
      jobType: parent?.job?.type,
      model: parent?.model,
      prompt: parent?.prompt.text,
      negative: parent?.prompt.negative,
      secondary: parent?.prompt.secondary,
      title: parent?.prompt.title,
      settings: { ...(parent?.settings || {}), conversion_format: conversion?.format },
      references: parent?.references,
      parentPath,
    });
    return upsertAssetMeta(folder, meta, { logger });
  } catch (error) {
    warn(logger, 'asset_meta_conversion', error);
    return false;
  }
}
const textDefaults = {
  transcript: { id: 'asr', kind: 'text' },
  decision: { id: 'game', kind: 'text' },
};
// Saved chat replies, transcripts and decisions. `provenance` comes from the
// client, so every field is validated and capped here.
export function recordSavedText(folder, outputPath, kind, provenance, { logger } = {}) {
  try {
    const given = provenance && typeof provenance === 'object' ? provenance : {};
    const fallback = textDefaults[kind] ? modelForId(textDefaults[kind].id) : null;
    const modelName = text(given.model?.name ?? given.model, LIMITS.name);
    const meta = buildProvenanceMetadata({
      path: outputPath,
      source: 'saved-text',
      kind: 'text',
      jobType: kind,
      model: modelName
        ? { name: modelName, id: text(given.model?.id, LIMITS.name), version: null }
        : fallback,
      prompt: given.prompt,
      secondary: given.secondary,
      title: given.title,
      settings: given.settings,
      references: given.references,
    });
    return upsertAssetMeta(folder, meta, { logger });
  } catch (error) {
    warn(logger, 'asset_meta_text', error);
    return false;
  }
}

// -------------------------------------------------------------------- backfill
const negativeCache = new Map();
const stem = (name) => name.replace(/\.[^.]+$/, '');
// Create records for assets generated before metadata existed. `assets` is the
// project listing ([{ id, sourceOutput }]). The jobs database is only read.
export function backfillAssetMeta(
  folder,
  projectId,
  assets,
  { jobLookup = defaultJobLookup(), logger } = {},
) {
  try {
    const known =
      withDb(
        folder,
        { create: false, logger, fallback: null },
        (db) =>
          new Set(
            db
              .prepare('SELECT path FROM asset_meta')
              .all()
              .map((row) => row.path),
          ),
      ) || new Set();
    const wanted = [];
    for (const asset of assets) {
      if (!asset?.id || known.has(asset.id) || negativeCache.get(`${folder}\n${asset.id}`)) {
        continue;
      }
      // A renamed file keeps its original output name in sourceOutput.
      const match = forgeName.exec(path.posix.basename(asset.sourceOutput || asset.id));
      if (match) {
        wanted.push({ asset, jobId: match[1].toLowerCase(), converted: Boolean(match[2]) });
      }
    }
    if (!wanted.length) {
      return 0;
    }
    const jobs = jobLookup([...new Set(wanted.map((item) => item.jobId))], projectId);
    const byStem = new Map(
      assets.map((a) => [path.posix.dirname(a.id) + '/' + stem(path.posix.basename(a.id)), a]),
    );
    let created = 0;
    const rows = [];
    for (const { asset, jobId, converted } of wanted) {
      const job = jobs.get(jobId);
      if (!job || job.projectId !== projectId) {
        negativeCache.set(`${folder}\n${asset.id}`, true);
        continue;
      }
      if (job.status !== 'completed') {
        continue;
      }
      let parentPath = null;
      if (converted) {
        const name = stem(path.posix.basename(asset.sourceOutput || asset.id));
        const parent = byStem.get(
          `${path.posix.dirname(asset.id)}/${name.replace(convertedSuffix, '')}`,
        );
        parentPath = parent && parent.id !== asset.id ? parent.id : null;
      }
      try {
        rows.push(
          buildJobMetadata({ ...job, id: jobId }, asset.id, {
            source: converted ? 'conversion' : 'job',
            parentPath,
            backfilled: true,
            referenceSizes: referenceSizes(folder, job),
          }),
        );
      } catch (error) {
        warn(logger, 'asset_meta_backfill_build', error);
      }
    }
    if (rows.length) {
      withDb(folder, { logger }, (db) =>
        transaction(db, () => {
          for (const meta of rows) {
            if (writeRow(db, meta, { overwrite: false })) {
              created++;
            }
          }
        }),
      );
    }
    return created;
  } catch (error) {
    warn(logger, 'asset_meta_backfill', error);
    return 0;
  }
}
export function resetBackfillCache() {
  negativeCache.clear();
}
