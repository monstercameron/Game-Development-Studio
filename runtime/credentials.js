import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';
import { openDatabase } from './durable-db.js';

const log = createLogger('credentials');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = fileURLToPath(new URL('./credentials-windows.ps1', import.meta.url));
const executable = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
export const credentialProviders = ['openai', 'huggingface'];
// Only the error class and code reach the log. Crypto, DPAPI and SQLite error messages can
// echo their input, so the message and stack are never passed on.
export function credentialErrorFields(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  const fields = { errorClass: /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : 'Error' };
  if (/^[A-Z0-9_]{1,64}$/.test(code)) {
    fields.errorCode = code;
  }
  return fields;
}
function validateProvider(provider) {
  if (!credentialProviders.includes(provider)) {
    log.warn('credentials.request.rejected', { reason: 'unknown_provider' });
    throw Error('Choose a supported provider.');
  }
}
function validateSecret(secret) {
  if (
    typeof secret !== 'string' ||
    secret.length < 1 ||
    secret.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(secret)
  ) {
    log.warn('credentials.request.rejected', { reason: 'invalid_secret' });
    throw Error('Enter a valid API key without spaces or line breaks.');
  }
}
function crypt(operation, value) {
  if (process.platform !== 'win32') {
    log.warn('credentials.crypt.failed', { operation, reason: 'unsupported_platform' });
    return Promise.reject(Error('Windows account encryption is required to store API keys.'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    let output = '',
      settled = false;
    const startedAt = Date.now();
    log.debug('credentials.process.spawned', {
      kind: 'dpapi_helper',
      operation,
      pid: child.pid,
    });
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      log.warn('credentials.crypt.failed', {
        operation,
        reason: 'timeout',
        durationMs: Date.now() - startedAt,
      });
      child.kill();
      finish(Error('Windows credential encryption timed out.'));
    }, 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 32768) {
        if (!settled) {
          log.warn('credentials.crypt.failed', { operation, reason: 'output_too_large' });
        }
        child.kill();
        finish(Error('Windows credential encryption failed.'));
      }
    });
    child.on('error', () => {
      log.warn('credentials.crypt.failed', { operation, reason: 'spawn_error' });
      finish(Error('Windows credential encryption is unavailable.'));
    });
    child.on('close', (code) => {
      log.debug('credentials.process.exited', {
        kind: 'dpapi_helper',
        operation,
        exitCode: code ?? undefined,
        durationMs: Date.now() - startedAt,
      });
      if (code === 0 && output) {
        finish(null, output);
        return;
      }
      if (!settled) {
        log.warn('credentials.crypt.failed', {
          operation,
          reason: 'helper_failed',
          exitCode: code ?? undefined,
        });
      }
      finish(Error('Windows credential encryption failed.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ operation, value }));
  });
}
export function createCredentialStore({
  directory = path.join(
    process.env.FORGE_RUNTIME_DIR || path.join(root, '.forge-runtime'),
    'credentials',
  ),
  protect = (value) => crypt('protect', value),
  unprotect = (value) => crypt('unprotect', value),
} = {}) {
  const file = path.join(directory, 'keys.sqlite');
  function open(create) {
    if (!create && !fs.existsSync(file)) {
      return null;
    }
    if (create) {
      fs.mkdirSync(directory, { recursive: true });
    }
    // The file holds DPAPI ciphertext only. A damaged store is set aside, never deleted.
    const db = openDatabase(file, {
      name: 'keys',
      journal: null,
      directory: path.dirname(directory),
    });
    try {
      db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
      return db;
    } catch (error) {
      log.error('credentials.store.open.failed', {
        reason: 'schema_setup',
        ...credentialErrorFields(error),
      });
      db.close();
      throw error;
    }
  }
  return {
    async set(provider, secret) {
      validateProvider(provider);
      validateSecret(secret);
      const ciphertext = await protect(secret);
      if (typeof ciphertext !== 'string' || !ciphertext || ciphertext === secret) {
        log.error('credentials.key.encrypt.failed', { provider, reason: 'invalid_ciphertext' });
        throw Error('Credential encryption failed.');
      }
      const db = open(true);
      try {
        db.prepare(
          'INSERT INTO credentials(provider,ciphertext,updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET ciphertext=excluded.ciphertext, updated_at=excluded.updated_at',
        ).run(provider, ciphertext, new Date().toISOString());
        log.info('credentials.key.saved', { provider });
      } finally {
        db.close();
      }
    },
    async get(provider) {
      validateProvider(provider);
      const db = open(false);
      if (!db) {
        return '';
      }
      let row;
      try {
        row = db.prepare('SELECT ciphertext FROM credentials WHERE provider=?').get(provider);
      } finally {
        db.close();
      }
      if (!row) {
        return '';
      }
      const result = await unprotect(row.ciphertext);
      validateSecret(result);
      log.debug('credentials.key.read', { provider });
      return result;
    },
    status() {
      const db = open(false);
      if (!db) {
        return credentialProviders.map((provider) => ({ provider, saved: false }));
      }
      try {
        const rows = db.prepare('SELECT provider,updated_at FROM credentials').all();
        return credentialProviders.map((provider) => ({
          provider,
          saved: rows.some((row) => row.provider === provider),
          updatedAt: rows.find((row) => row.provider === provider)?.updated_at || null,
        }));
      } finally {
        db.close();
      }
    },
    remove(provider) {
      validateProvider(provider);
      const db = open(false);
      if (!db) {
        return;
      }
      try {
        const result = db.prepare('DELETE FROM credentials WHERE provider=?').run(provider);
        log.info('credentials.key.removed', {
          provider,
          deletedCount: Number(result?.changes ?? 0),
        });
      } finally {
        db.close();
      }
    },
  };
}
export const credentialStore = createCredentialStore();
