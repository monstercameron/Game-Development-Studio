// Shared "AI assist" settings: which provider and model each optional AI feature uses.
// Stored in .forge-runtime/settings.sqlite (app-level, not per project). API keys are NOT kept
// here; they stay in the encrypted credential store (runtime/credentials.js).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Features and their defaults. Model ids are the user's names and are not verified here. */
export const AI_ASSIST_FEATURES = Object.freeze({
  'error-fix': Object.freeze({
    label: 'Error fix suggestions',
    provider: 'openai',
    model: 'gpt-6.1-sol',
  }),
  'vegetation-describe': Object.freeze({
    label: 'Vegetation “Describe it”',
    provider: 'openai',
    model: 'gpt-6-luna',
  }),
  // Used by runtime/i18n-service.js. Only OpenAI is supported; the service refuses 'local'.
  'ui-translate': Object.freeze({
    label: 'Interface translation',
    provider: 'openai',
    model: 'gpt-6-luna',
  }),
});
export const AI_ASSIST_PROVIDERS = Object.freeze(['openai', 'local']);
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,80}$/;

export function isValidAiModelId(model) {
  return typeof model === 'string' && MODEL_ID.test(model);
}

/** Throws a user-facing message when an entry is invalid; returns the normalized entry. */
export function validateAiAssistEntry({ feature, provider, model }) {
  if (!Object.hasOwn(AI_ASSIST_FEATURES, feature)) {
    throw Error('Choose a supported AI assist feature.');
  }
  if (!AI_ASSIST_PROVIDERS.includes(provider)) {
    throw Error('Choose OpenAI or a local provider.');
  }
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (!isValidAiModelId(trimmed)) {
    throw Error(
      'Enter a model id of 1 to 80 letters, digits, dots, dashes, underscores, colons or slashes.',
    );
  }
  return { feature, provider, model: trimmed };
}

/**
 * @param {{directory?: string, now?: () => Date}} options directory defaults to the Forge
 *   runtime folder. The database is created on the first write only.
 */
export function createAiAssistSettings({
  directory = process.env.FORGE_RUNTIME_DIR || path.join(repositoryRoot, '.forge-runtime'),
  now = () => new Date(),
} = {}) {
  const file = path.join(directory, 'settings.sqlite');
  function open(create) {
    if (!create && !fs.existsSync(file)) {
      return null;
    }
    fs.mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(file, { timeout: 5000 });
    try {
      db.exec(
        'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS ai_assist (feature TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  function read(db, feature) {
    const defaults = AI_ASSIST_FEATURES[feature];
    const row = db
      ?.prepare('SELECT provider,model,updated_at FROM ai_assist WHERE feature=?')
      .get(feature);
    const isStoredValid =
      row && AI_ASSIST_PROVIDERS.includes(row.provider) && isValidAiModelId(row.model);
    return {
      feature,
      label: defaults.label,
      provider: isStoredValid ? row.provider : defaults.provider,
      model: isStoredValid ? row.model : defaults.model,
      defaultProvider: defaults.provider,
      defaultModel: defaults.model,
      updatedAt: isStoredValid ? row.updated_at : null,
    };
  }
  return {
    get(feature) {
      if (!Object.hasOwn(AI_ASSIST_FEATURES, feature)) {
        throw Error('Choose a supported AI assist feature.');
      }
      const db = open(false);
      try {
        return read(db, feature);
      } finally {
        db?.close();
      }
    },
    list() {
      const db = open(false);
      try {
        return Object.keys(AI_ASSIST_FEATURES).map((feature) => read(db, feature));
      } finally {
        db?.close();
      }
    },
    set(entry) {
      const { feature, provider, model } = validateAiAssistEntry(entry);
      const db = open(true);
      try {
        db.prepare(
          'INSERT INTO ai_assist(feature,provider,model,updated_at) VALUES(?,?,?,?) ON CONFLICT(feature) DO UPDATE SET provider=excluded.provider, model=excluded.model, updated_at=excluded.updated_at',
        ).run(feature, provider, model, now().toISOString());
        return read(db, feature);
      } finally {
        db.close();
      }
    },
  };
}
