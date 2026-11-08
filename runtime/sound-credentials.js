import { createLogger } from './app-log.js';
import { credentialErrorFields, credentialStore } from './credentials.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const log = createLogger('credentials');

// Read the user's existing local key notes without returning their contents to
// the UI, database, MCP, or logs. Only the Hugging Face token is passed on.
export async function findSharedHuggingFaceToken(
  root = path.join(os.homedir(), 'Desktop', 'shared'),
) {
  let names;
  try {
    names = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    // The folder is optional; its path and the error message are not logged.
    log.debug('credentials.shared_token.scan.failed', {
      reason: 'folder_unreadable',
      ...credentialErrorFields(error),
    });
    return '';
  }
  names = names
    .filter(
      (item) => item.isFile() && !item.isSymbolicLink() && item.name.toLowerCase().endsWith('.md'),
    )
    .map((item) => item.name);
  names.sort((a, b) =>
    a.toLowerCase() === 'api keys.md'
      ? -1
      : b.toLowerCase() === 'api keys.md'
        ? 1
        : a.localeCompare(b),
  );
  for (const name of names) {
    try {
      const file = path.join(root, name),
        stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
        continue;
      }
      const match = (await fs.readFile(file, 'utf8')).match(/\bhf_[A-Za-z0-9]+\b/);
      if (match) {
        log.debug('credentials.key.read', { provider: 'huggingface', source: 'shared_notes' });
        return match[0];
      }
    } catch (error) {
      // An unreadable candidate is skipped without exposing its contents.
      log.debug('credentials.shared_token.file.skipped', {
        reason: 'unreadable',
        ...credentialErrorFields(error),
      });
      continue;
    }
  }
  return '';
}

export async function findConfiguredHuggingFaceToken({
  store = credentialStore,
  readShared = findSharedHuggingFaceToken,
} = {}) {
  return (await store.get('huggingface')) || readShared();
}

export function createManagedSoundTokenProvider({
  ownership,
  readToken = findConfiguredHuggingFaceToken,
  customEndpoint = false,
}) {
  return async () => {
    if (customEndpoint) {
      return '';
    }
    const status = await ownership();
    return status.sfx?.managed ? readToken() : '';
  };
}
