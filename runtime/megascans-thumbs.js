// A size-capped, content-checked disk cache for Megascans preview images.
//
// The browser never loads images from Fab directly: it asks `/api/megascans/thumbs/<id>`, and the
// server fetches each image at most once through the polite client, checks that it really is a
// small JPEG, PNG or WebP, and keeps it on disk. Failures are remembered for a while so a missing
// or blocked image is not requested again on every render.
import fs from 'node:fs/promises';
import path from 'node:path';
import { FabBlockedError } from './megascans-fab.js';
import { runtimeDirectory } from './megascans-db.js';

export const THUMBNAIL_DIRECTORY_NAME = 'megascans-thumbs';
export const MAX_CACHE_BYTES = 200 * 1024 * 1024;
export const FAILURE_MEMORY_MS = 10 * 60 * 1000;
// A cached image older than this is checked with a conditional request (If-None-Match).
export const REVALIDATE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Reads the image type from the first bytes, not from what the server claims. */
export function sniffImage(bytes) {
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length > 12 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length > 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export class ThumbnailCache {
  /**
   * @param {object} options
   * @param {import('./megascans-fab.js').FabClient} options.client
   * @param {import('./megascans-library.js').MegascansLibrary} options.library
   * @param {() => boolean} [options.isBlocked] True while Fab requests are paused.
   * @param {(error: Error) => void} [options.onBlocked] Called when an image request is refused.
   */
  constructor({
    client,
    library,
    directory = path.join(runtimeDirectory(), THUMBNAIL_DIRECTORY_NAME),
    maxBytes = MAX_CACHE_BYTES,
    isBlocked = () => false,
    onBlocked = () => {},
    now = Date.now,
    logger = console,
  }) {
    this.client = client;
    this.library = library;
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.isBlocked = isBlocked;
    this.onBlocked = onBlocked;
    this.now = now;
    this.logger = logger;
    this.pending = new Map();
    this.failed = new Map();
  }

  file(id) {
    return path.join(this.directory, `${id.toLowerCase()}.img`);
  }

  /**
   * @returns {Promise<{ bytes: Buffer, type: string } | null>} null when there is no image.
   */
  async get(id) {
    if (!ID.test(id)) {
      return null;
    }
    const cached = await this.read(id);
    if (cached) {
      return cached.stale ? this.revalidate(id, cached) : cached;
    }
    if (this.isBlocked() || (this.failed.get(id) ?? 0) > this.now()) {
      return null;
    }
    const source = this.library.thumbnailSource(id);
    if (!source) {
      return null;
    }
    if (!this.pending.has(id)) {
      const work = this.fetchAndStore(id, source).finally(() => this.pending.delete(id));
      this.pending.set(id, work);
    }
    return this.pending.get(id);
  }

  /**
   * Asks Fab whether an old image changed. "Not modified" renews the file's age; any failure
   * (offline, blocked, a refusal) keeps serving the copy already on disk.
   */
  async revalidate(id, cached) {
    const image = { bytes: cached.bytes, type: cached.type };
    const source = this.library.thumbnailSource(id);
    const known = this.client.validators?.get(`thumb:${id}`);
    if (!source || !known || this.isBlocked() || this.pending.has(id)) {
      return image;
    }
    const work = (async () => {
      try {
        const result = await this.client.getImage(source, { conditional: known });
        if (result.status === 304) {
          const now = new Date(this.now());
          await fs.utimes(this.file(id), now, now);
          return image;
        }
        return (await this.store(id, result)) ?? image;
      } catch (error) {
        if (error instanceof FabBlockedError) {
          this.onBlocked(error);
        }
        return image;
      }
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, work);
    return work;
  }

  async read(id) {
    try {
      const file = this.file(id);
      const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      const type = sniffImage(bytes);
      return type ? { bytes, type, stale: this.now() - stat.mtimeMs > REVALIDATE_AFTER_MS } : null;
    } catch {
      return null;
    }
  }

  /** Checks a fetched image by content and writes it to the cache. Throws when it is unusable. */
  async store(id, { body, type: declared, etag, lastModified }) {
    const type = sniffImage(body);
    if (!type || (declared && !TYPES[declared])) {
      throw new Error('The thumbnail is not a supported image.');
    }
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.file(id);
    const partial = `${target}.part`;
    await fs.writeFile(partial, body);
    await fs.rename(partial, target);
    if (etag || lastModified) {
      this.client.validators?.set(`thumb:${id}`, { etag, lastModified });
    }
    await this.trim();
    return { bytes: body, type };
  }

  async fetchAndStore(id, source) {
    try {
      return await this.store(id, await this.client.getImage(source));
    } catch (error) {
      this.failed.set(id, this.now() + FAILURE_MEMORY_MS);
      if (error instanceof FabBlockedError) {
        this.onBlocked(error);
      } else {
        this.logger.warn('Megascans thumbnail skipped:', error.message);
      }
      return null;
    }
  }

  /** Deletes the oldest files until the cache is under 90% of its cap. */
  async trim() {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.img')) {
        continue;
      }
      const stat = await fs.stat(path.join(this.directory, entry.name)).catch(() => null);
      if (stat) {
        files.push({ name: entry.name, size: stat.size, time: stat.mtimeMs });
        total += stat.size;
      }
    }
    if (total <= this.maxBytes) {
      return;
    }
    files.sort((a, b) => a.time - b.time);
    for (const file of files) {
      if (total <= this.maxBytes * 0.9) {
        break;
      }
      await fs.rm(path.join(this.directory, file.name), { force: true });
      total -= file.size;
    }
  }
}
