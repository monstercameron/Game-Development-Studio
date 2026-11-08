// Machine translations, personal overrides and the language preference in
// .forge-runtime/i18n.sqlite. A translation is stored per (language, key, source_hash), so a
// change to the English source makes it stale instead of silently wrong. The database is
// created on the first write only.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './app-log.js';
import { openDatabase } from './durable-db.js';

const log = createLogger('i18n');

const SCHEMA = [
  'PRAGMA busy_timeout=5000',
  `CREATE TABLE IF NOT EXISTS translations (
    lang TEXT NOT NULL, key TEXT NOT NULL, namespace TEXT NOT NULL, source_hash TEXT NOT NULL,
    value TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (lang, key, source_hash))`,
  'CREATE INDEX IF NOT EXISTS translations_namespace ON translations(lang, namespace)',
  `CREATE TABLE IF NOT EXISTS overrides (
    lang TEXT NOT NULL, key TEXT NOT NULL, namespace TEXT NOT NULL, source_hash TEXT NOT NULL,
    value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (lang, key))`,
  `CREATE TABLE IF NOT EXISTS preference (
    id INTEGER PRIMARY KEY CHECK (id = 1), locale TEXT NOT NULL, updated_at TEXT NOT NULL)`,
].join(';\n');

function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch (failure) {
    log.warn('i18n.row.invalid', { reason: 'invalid_json', errorClass: failure?.name });
    return null;
  }
}

/** @param {{ directory: string, now?: () => Date }} options */
export function createTranslationStore({ directory, now = () => new Date() }) {
  const file = path.join(directory, 'i18n.sqlite');
  let db = null;

  function open(create) {
    if (db) {
      return db;
    }
    if (!create && !fs.existsSync(file)) {
      return null;
    }
    fs.mkdirSync(directory, { recursive: true });
    // Translations cost API calls and overrides are the user's own text: FULL synchronous.
    const connection = openDatabase(file, { name: 'i18n', journal: null, directory });
    try {
      connection.exec(SCHEMA);
    } catch (error) {
      log.error('i18n.store.open.failed', { errorClass: error?.name, errorCode: error?.code });
      connection.close();
      throw error;
    }
    db = connection;
    return db;
  }

  return {
    /** Map key -> { value, sourceHash, model, createdAt } for one namespace. */
    translations(lang, namespace) {
      const rows =
        open(false)
          ?.prepare(
            'SELECT key, source_hash, value, model, created_at FROM translations WHERE lang=? AND namespace=?',
          )
          .all(lang, namespace) || [];
      const result = new Map();
      for (const row of rows) {
        const value = parseValue(row.value);
        if (value !== null) {
          const list = result.get(row.key) || [];
          list.push({
            value,
            sourceHash: row.source_hash,
            model: row.model,
            createdAt: row.created_at,
          });
          result.set(row.key, list);
        }
      }
      return result;
    },
    /** Map key -> { value, sourceHash, updatedAt } for one namespace. */
    overrides(lang, namespace) {
      const rows =
        open(false)
          ?.prepare(
            'SELECT key, source_hash, value, updated_at FROM overrides WHERE lang=? AND namespace=?',
          )
          .all(lang, namespace) || [];
      return new Map(
        rows
          .map((row) => [
            row.key,
            {
              value: parseValue(row.value),
              sourceHash: row.source_hash,
              updatedAt: row.updated_at,
            },
          ])
          .filter(([, entry]) => entry.value !== null),
      );
    },
    /** Stores accepted translations; older rows for the same keys are replaced. */
    saveTranslations(lang, rows, model) {
      if (!rows.length) {
        return;
      }
      const connection = open(true);
      const at = now().toISOString();
      const remove = connection.prepare('DELETE FROM translations WHERE lang=? AND key=?');
      const insert = connection.prepare(
        'INSERT INTO translations(lang,key,namespace,source_hash,value,model,created_at) VALUES(?,?,?,?,?,?,?)',
      );
      connection.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          remove.run(lang, row.key);
          insert.run(
            lang,
            row.key,
            row.namespace,
            row.sourceHash,
            JSON.stringify(row.value),
            model,
            at,
          );
        }
        connection.exec('COMMIT');
        log.debug('i18n.translations.saved', { locale: lang, rowCount: rows.length });
      } catch (error) {
        log.error('i18n.translations.save.failed', {
          locale: lang,
          rowCount: rows.length,
          errorClass: error?.name,
          errorCode: error?.code,
        });
        connection.exec('ROLLBACK');
        throw error;
      }
    },
    /** Saves a personal override; a `null` value removes it and returns nothing. */
    setOverride(lang, { key, namespace, sourceHash, value }) {
      const connection = open(true);
      if (value === null) {
        connection.prepare('DELETE FROM overrides WHERE lang=? AND key=?').run(lang, key);
        log.debug('i18n.override.deleted', { locale: lang });
        return;
      }
      connection
        .prepare(
          'INSERT INTO overrides(lang,key,namespace,source_hash,value,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(lang,key) DO UPDATE SET namespace=excluded.namespace, source_hash=excluded.source_hash, value=excluded.value, updated_at=excluded.updated_at',
        )
        .run(lang, key, namespace, sourceHash, JSON.stringify(value), now().toISOString());
      log.debug('i18n.override.saved', { locale: lang });
    },
    /**
     * Removes translations for a language (all namespaces when `namespaces` is empty) and,
     * when asked, its overrides. Returns the number of rows removed.
     */
    reset(lang, { namespaces = [], includeOverrides = false } = {}) {
      const connection = open(false);
      if (!connection) {
        return 0;
      }
      let removed = 0;
      const tables = includeOverrides ? ['translations', 'overrides'] : ['translations'];
      for (const table of tables) {
        if (namespaces.length) {
          const statement = connection.prepare(`DELETE FROM ${table} WHERE lang=? AND namespace=?`);
          for (const namespace of namespaces) {
            removed += Number(statement.run(lang, namespace).changes);
          }
        } else {
          removed += Number(
            connection.prepare(`DELETE FROM ${table} WHERE lang=?`).run(lang).changes,
          );
        }
      }
      log.info('i18n.translations.reset', {
        locale: lang,
        removedCount: removed,
        namespaceCount: namespaces.length,
        isOverridesIncluded: includeOverrides,
      });
      return removed;
    },
    /** Languages with stored rows: [{ lang, namespace, translations, overrides }]. */
    summary() {
      const connection = open(false);
      if (!connection) {
        return [];
      }
      const rows = connection
        .prepare(
          `SELECT lang, namespace, SUM(t) AS translations, SUM(o) AS overrides FROM (
             SELECT lang, namespace, 1 AS t, 0 AS o FROM translations
             UNION ALL SELECT lang, namespace, 0, 1 FROM overrides)
           GROUP BY lang, namespace ORDER BY lang, namespace`,
        )
        .all();
      return rows.map((row) => ({
        lang: row.lang,
        namespace: row.namespace,
        translations: Number(row.translations),
        overrides: Number(row.overrides),
      }));
    },
    getPreference() {
      return open(false)?.prepare('SELECT locale FROM preference WHERE id=1').get()?.locale || null;
    },
    /** Removes the studio-wide language preference, so browsers decide for themselves. */
    clearPreference() {
      open(false)?.prepare('DELETE FROM preference WHERE id=1').run();
    },
    setPreference(locale) {
      open(true)
        .prepare(
          'INSERT INTO preference(id,locale,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET locale=excluded.locale, updated_at=excluded.updated_at',
        )
        .run(locale, now().toISOString());
      log.info('i18n.preference.saved', { locale });
    },
    close() {
      db?.close();
      db = null;
    },
  };
}
