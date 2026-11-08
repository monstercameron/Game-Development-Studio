// LoRA files for Qwen Image live in one folder that Forge scans. Callers supply only a file
// name from that list, never a path, and the engine resolves the name inside the same folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './app-log.js';

const log = createLogger('image');
// This file lives in runtime/, so one level up is the repository root.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LORA_FOLDER_NAME = 'Qwen-Image-2.1-LoRA';
// Upper bound for a LoRA strength multiplier (dimensionless; 0 disables the effect).
export const MAX_LORA_SCALE = 2;
// Scan cap: the listing stops after this many LoRA files, so a large folder
// cannot stall a request.
const MAX_LORAS = 200;
// A plain file name: no separators, no leading dot, safetensors only.
const loraName = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,95}\.safetensors$/;

export function loraDirectory() {
  return process.env.FORGE_QWEN_LORA_DIR || path.join(appRoot, 'models', LORA_FOLDER_NAME);
}

export function isLoraName(value) {
  return typeof value === 'string' && loraName.test(value) && !value.includes('..');
}

// Regular .safetensors files only; links, folders and odd names are skipped.
export function listImageLoras(directory = loraDirectory()) {
  const startedMs = performance.now();
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // A missing folder is normal until the first LoRA is installed.
      log.debug('image.lora.scan.failed', { reason: 'folder_missing', errorCode: error.code });
    } else {
      log.warn('image.lora.scan.failed', {
        reason: 'folder_unreadable',
        errorClass: error?.name,
        errorCode: error?.code,
      });
    }
    return [];
  }
  let unknownSizeCount = 0;
  const loras = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && isLoraName(entry.name))
    .slice(0, MAX_LORAS)
    .map((entry) => {
      let size = null;
      try {
        size = fs.statSync(path.join(directory, entry.name)).size;
        // log-coverage: ignore -- a mid-scan removal is expected; counted in the scan summary, not per file
      } catch {
        // The file may have been removed between the listing and the stat.
        unknownSizeCount += 1;
      }
      return { name: entry.name, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  log.debug('image.lora.scan.completed', {
    loraCount: loras.length,
    skippedCount: entries.length - loras.length,
    unknownSizeCount,
    durationMs: Math.round(performance.now() - startedMs),
  });
  return loras;
}

export function assertKnownLora(name, directory = loraDirectory()) {
  if (!isLoraName(name)) {
    throw Error('LoRA must be a .safetensors file name from the LoRA folder, without a path.');
  }
  if (!listImageLoras(directory).some((item) => item.name === name)) {
    throw Error(`LoRA "${name}" was not found in the Qwen Image LoRA folder.`);
  }
  return name;
}
