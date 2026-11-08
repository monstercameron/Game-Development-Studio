import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './app-log.js';

const log = createLogger('model');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultModelsRoot = path.join(appRoot, 'models');
// The catalog is deliberately fixed: callers cannot supply filesystem paths.
export const managedModels = Object.freeze([
  // Shared with standalone applications; removal requires coordinated ownership.
  { id: 'images', folder: 'Qwen-Image-2.1', removable: false },
  { id: 'music', folder: 'YuE2-3B', removable: false },
  { id: 'music-vae', folder: 'YuE2-Vae', removable: false },
  { id: 'sfx', folder: 'Stable-Audio-3', removable: false },
  { id: 'video', folder: 'MiniMax-H3', removable: false },
  { id: 'game', folder: 'Mammoth-1', removable: false },
  { id: 'hy-world', folder: 'HY-World-2.0', removable: false },
  { id: 'worldgen', folder: 'worldgen', removable: false },
  { id: 'chat', folder: 'Qwen3.8-27B-GGUF', removable: false },
  { id: 'world-hf-cache', folder: 'hf-cache', removable: false },
  { id: 'comfy-models', folder: 'ComfyUI', removable: false },
  { id: '3d-trellis', folder: 'TRELLIS.2-4B', removable: false },
  { id: 'trellis-decoder', folder: 'TRELLIS-image-large', removable: false },
  { id: 'trellis-encoder', folder: 'dinov3-vitl16-pretrain-lvd1689m', removable: false },
  { id: '3d-hunyuan', folder: 'Hunyuan3D-2.1' },
  { id: 'motion-hy', folder: 'HY-Motion' },
  { id: 'motion-bricks', folder: 'MotionBricks', removable: false },
  { id: 'tts', folder: 'Qwen3-TTS-12Hz-1.7B-CustomVoice' },
  { id: 'tts-base', folder: 'Qwen3-TTS-12Hz-1.7B-Base', removable: false },
  { id: 'tts-voicedesign', folder: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign', removable: false },
  { id: 'asr', folder: 'nemotron-speech-streaming-en-0.6b' },
  { id: 'segmentation', folder: 'sam3.1' },
]);

async function measureDirectory(root, folder) {
  const target = path.join(root, folder);
  let info;
  try {
    info = await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { installed: false, bytes: 0, files: 0, skippedLinks: 0 };
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Error('Model folder is not a regular directory.');
  }
  if ((await fs.realpath(target)) !== target) {
    throw Error('Model folder resolves outside its expected location.');
  }
  const pending = [target];
  let bytes = 0,
    files = 0,
    skippedLinks = 0;
  while (pending.length) {
    const current = pending.pop();
    const currentStat = await fs.lstat(current);
    if (
      !currentStat.isDirectory() ||
      currentStat.isSymbolicLink() ||
      (await fs.realpath(current)) !== current
    ) {
      throw Error('Model folder changed while measuring.');
    }
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name),
        stat = await fs.lstat(item);
      if (stat.isSymbolicLink()) {
        skippedLinks++;
        continue;
      }
      if (stat.isDirectory()) {
        pending.push(item);
        continue;
      }
      if (stat.isFile()) {
        bytes += stat.size;
        files++;
      }
    }
  }
  return { installed: true, bytes, files, skippedLinks };
}

export async function inspectModelInventory({
  root = defaultModelsRoot,
  models = managedModels,
} = {}) {
  const startedMs = performance.now();
  const actual = await fs.realpath(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || actual !== path.resolve(root)) {
    throw Error('Model storage root is missing or is a link.');
  }
  const entries = await Promise.all(
    models.map(async (model) => {
      try {
        return {
          ...model,
          path: path.join(actual, model.folder),
          ...(await measureDirectory(actual, model.folder)),
          error: null,
        };
      } catch (error) {
        log.warn('models.inventory.model.failed', {
          modelId: model.id,
          errorClass: error?.name,
          errorCode: error?.code,
        });
        return {
          ...model,
          path: path.join(actual, model.folder),
          installed: null,
          bytes: null,
          files: null,
          skippedLinks: null,
          error: String(error.message).slice(0, 300),
        };
      }
    }),
  );
  log.debug('models.inventory.scan.completed', {
    modelCount: entries.length,
    installedCount: entries.filter((entry) => entry.installed === true).length,
    failedCount: entries.filter((entry) => entry.error !== null).length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    durationMs: Math.round(performance.now() - startedMs),
  });
  return {
    root: actual,
    entries,
    observedAt: new Date().toISOString(),
    note: 'File sizes exclude links and may differ from disk space reclaimed.',
  };
}

// Return immediately while the asynchronous filesystem scan runs. A large
// model tree must not block the health endpoint or the durable queue.
export class ModelInventory {
  constructor({
    root = defaultModelsRoot,
    models = managedModels,
    ttlMs = 60000,
    scan = inspectModelInventory,
  } = {}) {
    this.root = root;
    this.models = models;
    this.ttlMs = ttlMs;
    this.scan = scan;
    this.value = null;
    this.pending = null;
    this.updated = 0;
    this.error = null;
    this.generation = 0;
  }
  snapshot() {
    if (!this.pending && Date.now() - this.updated >= this.ttlMs) {
      const generation = this.generation;
      this.pending = this.scan({ root: this.root, models: this.models })
        .then(
          (value) => {
            if (generation !== this.generation) {
              return;
            }
            this.value = value;
            this.error = null;
            this.updated = Date.now();
          },
          (error) => {
            if (generation !== this.generation) {
              return;
            }
            log.warn('models.inventory.scan.failed', {
              reason: 'scan_rejected',
              errorClass: error?.name,
              errorCode: error?.code,
            });
            this.error = String(error.message).slice(0, 300);
            this.updated = Date.now();
          },
        )
        .finally(() => {
          this.pending = null;
        });
    }
    return {
      state: this.pending ? 'scanning' : this.error ? 'error' : 'ready',
      ...(this.value || { root: this.root, entries: [] }),
      error: this.error,
    };
  }
  invalidate() {
    this.generation++;
    this.updated = 0;
  }
}
