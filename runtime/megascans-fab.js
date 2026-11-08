// A deliberately polite, read-only client for the public Fab listing endpoints.
//
// The user decided to let Forge read the same anonymous JSON that the Fab website loads for a
// signed-out visitor. Fab's robots.txt disallows those endpoints and its terms prohibit scripted
// access, so the limits below are engineering safeguards, not permission (docs/MEGASCANS.md):
//   * the User-Agent says "Forge-Studio/<version>"; it never imitates a browser;
//   * one request in flight, at least `minIntervalMs` between requests, a timeout, bounded bodies;
//   * 429 and 5xx are retried with backoff that honors Retry-After, then surfaced as a state;
//   * a 401/403, a bot-detection challenge or a non-JSON page ends the work with FabBlockedError.
//     Nothing tries to get around it: no cookies, no tokens, no header spoofing, no proxies;
//   * redirects are never followed and only allow-listed hosts are contacted.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';
import { describeFiles } from './megascans-files.js';

export const FAB_BASE_URL = 'https://www.fab.com';
export const FAB_IMAGE_HOSTS = Object.freeze(['media.fab.com']);
export const FAB_SELLER_NAME = 'Quixel Megascans';
export const MIN_INTERVAL_MS = 1500;
export const IMAGE_MIN_INTERVAL_MS = 500;
export const MAX_RETRY_AFTER_MS = 120_000;
export const MAX_API_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 512 * 1024;
export const SEARCH_PAGE_SIZE = 24;
// Signed download addresses point at Epic's content delivery network, not at fab.com.
export const CDN_HOST_SUFFIXES = Object.freeze(['.epicgames.com', '.epicgamescdn.com']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAT_CODE = /^[a-z0-9-]{1,40}$/;
const log = createLogger('megascans');

// Milliseconds since `startedMs` (from performance.now()), for request timing logs.
function millisecondsSince(startedMs) {
  return Math.round(performance.now() - startedMs);
}

let cachedVersion;
function forgeVersion() {
  if (cachedVersion === undefined) {
    try {
      const file = fileURLToPath(new URL('../package.json', import.meta.url));
      cachedVersion = JSON.parse(fs.readFileSync(file, 'utf8')).version || '0';
    } catch (error) {
      log.warn('megascans.version.read.failed', {
        errorClass: error?.name,
        reason: 'using_default',
      });
      cachedVersion = '0';
    }
  }
  return cachedVersion;
}

/** Fab refused automated access (or answered with a challenge page). Do not retry soon. */
export class FabBlockedError extends Error {
  constructor(message, { status = 0, kind = 'blocked', retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'FabBlockedError';
    // log-coverage: ignore -- stores the HTTP status on the error object, not a state change
    this.status = status;
    // 'blocked' (challenge or refusal) or 'rate_limited' (429 that outlasted our retries).
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A failure that is not a block: network trouble, bad data, a missing listing. */
export class FabError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = 'FabError';
    // log-coverage: ignore -- stores the HTTP status on the error object, not a state change
    this.status = status;
    // 'unreachable' when the request never got an answer (offline, DNS, timeout).
    this.code = code;
  }
}

/** Returned instead of data when Fab says the cached copy is still current (HTTP 304). */
export const NOT_MODIFIED = Symbol('not-modified');

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function retryAfterMs(header, now) {
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(date - now, 0);
}

function looksLikeChallenge(headers, text) {
  return (
    headers.get('cf-mitigated') !== null ||
    /just a moment|cf-chl|challenge-platform|captcha|attention required/i.test(text.slice(0, 4000))
  );
}

async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new FabError('Fab sent a response that is too large.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > limit) {
        throw new FabError('Fab sent a response that is too large.');
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export class FabClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] Origin for API requests; tests point this at a loopback fake.
   * @param {string[]} [options.imageHosts] Hosts thumbnails may come from.
   * @param {number} [options.minIntervalMs] Minimum quiet time after any API request.
   * @param {number} [options.imageIntervalMs] Minimum quiet time after an image request.
   * @param {typeof fetch} [options.fetchImpl]
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
   * @param {() => number} [options.now]
   */
  constructor({
    baseUrl = FAB_BASE_URL,
    imageHosts = FAB_IMAGE_HOSTS,
    minIntervalMs = MIN_INTERVAL_MS,
    imageIntervalMs = IMAGE_MIN_INTERVAL_MS,
    timeoutMs = 20_000,
    maxAttempts = 3,
    backoffMs = 1000,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    userAgent = `Forge-Studio/${forgeVersion()}`,
    cdnHostSuffixes = CDN_HOST_SUFFIXES,
    cdnHosts = [],
    allowInsecureCdn = false,
  } = {}) {
    this.cdnHostSuffixes = cdnHostSuffixes;
    // Exact hosts and plain HTTP exist only so tests can point the client at a loopback fake.
    this.cdnHosts = new Set(cdnHosts);
    this.allowInsecureCdn = allowInsecureCdn;
    this.base = new URL(baseUrl);
    this.imageHosts = new Set([...imageHosts, this.base.hostname]);
    this.minIntervalMs = minIntervalMs;
    this.imageIntervalMs = imageIntervalMs;
    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.backoffMs = backoffMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.userAgent = userAgent;
    this.tail = Promise.resolve();
    // Identical requests that are in flight at the same time share one answer.
    this.inflight = new Map();
    // Optional `{ get(key), set(key, { etag, lastModified }) }` for conditional requests.
    this.validators = null;
    this.lastEnd = { api: 0, image: 0 };
  }

  /** Runs `work` after every earlier request finished and the quiet interval has passed. */
  schedule(kind, signal, work) {
    const run = async () => {
      const wait = this.lastEnd[kind] + this.interval(kind) - this.now();
      if (wait > 0) {
        await this.sleep(wait, signal);
      }
      try {
        return await work();
      } finally {
        this.lastEnd[kind] = this.now();
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }

  interval(kind) {
    return kind === 'image' ? this.imageIntervalMs : this.minIntervalMs;
  }

  /**
   * Fetches JSON from an API path such as `/i/listings/search?...`.
   * @returns {Promise<any>}
   */
  async getJson(pathAndQuery, { signal, revalidateKey } = {}) {
    const url = new URL(pathAndQuery, this.base);
    if (url.origin !== this.base.origin) {
      log.warn('megascans.fab.request.rejected', { kind: 'api', reason: 'unexpected_host' });
      throw new FabError('Refused to contact an unexpected host.');
    }
    const known = revalidateKey ? this.validators?.get(revalidateKey) : null;
    const { status, body, etag, lastModified } = await this.fetchWithRetry(url, {
      kind: 'api',
      accept: 'application/json',
      limit: MAX_API_BYTES,
      signal,
      conditional: known,
    });
    if (status === 304) {
      return NOT_MODIFIED;
    }
    if (revalidateKey && (etag || lastModified)) {
      this.validators?.set(revalidateKey, { etag, lastModified });
    }
    try {
      return JSON.parse(body.toString('utf8'));
    } catch (error) {
      log.warn('megascans.fab.response.rejected', {
        kind: 'api',
        reason: 'malformed_json',
        errorClass: error?.name,
      });
      throw new FabError('Fab sent a response Forge could not read.');
    }
  }

  /** Fetches one image from an allow-listed host. Returns the bytes and the declared type. */
  async getImage(imageUrl, { signal, conditional = null } = {}) {
    let url;
    try {
      url = new URL(imageUrl);
    } catch (error) {
      log.warn('megascans.fab.request.rejected', {
        kind: 'image',
        reason: 'unreadable_address',
        errorClass: error?.name,
      });
      throw new FabError('The thumbnail address is not valid.');
    }
    const sameBase = url.origin === this.base.origin;
    if (!(sameBase || (url.protocol === 'https:' && this.imageHosts.has(url.hostname)))) {
      log.warn('megascans.fab.request.rejected', { kind: 'image', reason: 'unexpected_host' });
      throw new FabError('Refused to contact an unexpected host.');
    }
    return this.fetchWithRetry(url, {
      kind: 'image',
      accept: 'image/*',
      limit: MAX_IMAGE_BYTES,
      signal,
      conditional,
    });
  }

  /**
   * Accepts only an HTTPS address on Epic's delivery network (plain HTTP only when a test opts
   * in). The address is never logged, because it carries a signature.
   */
  assertCdnUrl(address) {
    let url;
    try {
      url = new URL(address);
    } catch (error) {
      log.warn('megascans.fab.request.rejected', {
        kind: 'download',
        reason: 'unreadable_address',
        errorClass: error?.name,
      });
      throw new FabError('Fab sent a download address Forge could not read.');
    }
    const host = url.hostname.toLowerCase();
    const allowedHost =
      this.cdnHosts.has(host) || this.cdnHostSuffixes.some((suffix) => host.endsWith(suffix));
    const allowedScheme =
      url.protocol === 'https:' || (this.allowInsecureCdn && url.protocol === 'http:');
    if (!allowedHost || !allowedScheme || url.username || url.password) {
      log.warn('megascans.fab.request.rejected', { kind: 'download', reason: 'unexpected_host' });
      throw new FabError('Fab sent a download address on an unexpected host, so Forge refused it.');
    }
    return url;
  }

  /**
   * Asks Fab for a short-lived signed address for one file. Call it right before the download
   * starts: the address expires after about five minutes and is never stored.
   * @returns {Promise<{ url: string, expiresAt: string | null }>}
   */
  async getDownloadInfo(listingId, formatCode, fileUid, { signal } = {}) {
    if (!UUID.test(listingId) || !FORMAT_CODE.test(formatCode) || !UUID.test(fileUid)) {
      log.warn('megascans.fab.request.rejected', { kind: 'download-info', reason: 'invalid_id' });
      throw new FabError('That file is not valid.');
    }
    const json = await this.getJson(
      `/i/listings/${listingId}/asset-formats/${formatCode}/files/${fileUid}/download-info`,
      { signal },
    );
    const entry = Array.isArray(json?.downloadInfo) ? json.downloadInfo[0] : null;
    if (!entry || typeof entry.downloadUrl !== 'string') {
      log.warn('megascans.fab.response.rejected', {
        kind: 'download-info',
        reason: 'no_download_offered',
      });
      throw new FabError('Fab did not offer a download for that file.');
    }
    const expires = typeof entry.expires === 'string' ? Date.parse(entry.expires) : NaN;
    return {
      url: this.assertCdnUrl(entry.downloadUrl).href,
      expiresAt: Number.isNaN(expires) ? null : new Date(expires).toISOString(),
    };
  }

  /**
   * Starts a GET of a signed address, optionally from a byte offset. Not paced by the API
   * interval: the queue allows two at once. Redirects are never followed; a refusal, a redirect
   * or an HTML page stops with FabBlockedError.
   */
  async openDownload(address, { start = 0, signal } = {}) {
    const url = this.assertCdnUrl(address);
    const headers = { 'User-Agent': this.userAgent, Accept: '*/*' };
    if (start > 0) {
      headers.Range = `bytes=${start}-`;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    const startedMs = performance.now();
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      log.warn('megascans.fab.request.failed', {
        kind: 'download',
        reason: 'unreachable',
        durationMs: millisecondsSince(startedMs),
        errorClass: error?.name,
      });
      throw new FabError('Could not reach the download server. Try again.', {
        code: 'unreachable',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    const status = response.status;
    log.info('megascans.fab.request.completed', {
      kind: 'download',
      status,
      durationMs: millisecondsSince(startedMs),
    });
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      log.warn('megascans.fab.request.blocked', { kind: 'download', status, reason: 'redirect' });
      throw new FabBlockedError(
        'The download server redirected the request, which Forge does not follow.',
        { status },
      );
    }
    if (status === 401 || status === 403) {
      await response.body?.cancel();
      log.warn('megascans.fab.request.blocked', { kind: 'download', status, reason: 'refused' });
      throw new FabBlockedError('The download server refused the request.', { status });
    }
    if (status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'), this.now());
      await response.body?.cancel();
      log.warn('megascans.fab.request.throttled', {
        kind: 'download',
        status,
        hasRetryAfter: wait !== null,
        retryAfterSeconds: Math.ceil((wait ?? 0) / 1000),
      });
      throw new FabBlockedError('The download server asked Forge to slow down.', {
        status,
        kind: 'rate_limited',
        retryAfterSeconds: wait === null ? 600 : Math.ceil(wait / 1000),
      });
    }
    if (status !== 200 && status !== 206) {
      await response.body?.cancel();
      throw new FabError(`The download server answered with an error (${status}).`, { status });
    }
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'text/html' || type === 'application/json') {
      await response.body?.cancel();
      log.warn('megascans.fab.request.blocked', { kind: 'download', status, reason: 'html_page' });
      throw new FabBlockedError('The download server sent a page instead of the file.', { status });
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') || '');
    return {
      status,
      body: response.body,
      contentLength: Number(response.headers.get('content-length')) || null,
      rangeStart: range ? Number(range[1]) : null,
      acceptsRanges:
        (response.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' || status === 206,
    };
  }

  /** Paced, retried GET. Identical concurrent requests are answered by one transfer. */
  fetchWithRetry(url, options) {
    const key = `${options.kind} ${url.href} ${options.conditional?.etag ?? ''} ${options.conditional?.lastModified ?? ''}`;
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }
    const work = this.performFetch(url, options).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  performFetch(url, { kind, accept, limit, signal, conditional }) {
    const headers = { 'User-Agent': this.userAgent, Accept: accept };
    if (conditional?.etag) {
      headers['If-None-Match'] = conditional.etag;
    }
    if (conditional?.lastModified) {
      headers['If-Modified-Since'] = conditional.lastModified;
    }
    return this.schedule(kind, signal, async () => {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const startedMs = performance.now();
        let response;
        try {
          response = await this.fetchImpl(url, {
            method: 'GET',
            redirect: 'manual',
            headers,
            signal: combined,
          });
        } catch (error) {
          if (signal?.aborted) {
            throw error;
          }
          log.warn('megascans.fab.request.failed', {
            kind,
            attempt,
            reason: attempt < this.maxAttempts ? 'retrying' : 'unreachable',
            durationMs: millisecondsSince(startedMs),
            errorClass: error?.name,
          });
          if (attempt < this.maxAttempts) {
            await this.sleep(this.backoffMs * 2 ** (attempt - 1), signal);
            continue;
          }
          throw new FabError('Could not reach Fab. Check your connection and try again.', {
            code: 'unreachable',
          });
        }
        const status = response.status;
        // Thumbnails arrive in bursts (about two a second), so they are debug only.
        const logCompleted = kind === 'image' ? log.debug : log.info;
        logCompleted.call(log, 'megascans.fab.request.completed', {
          kind,
          status,
          attempt,
          durationMs: millisecondsSince(startedMs),
        });
        if (status === 304 && conditional) {
          await response.body?.cancel();
          return { status, type: '', body: Buffer.alloc(0), etag: null, lastModified: null };
        }
        if (status >= 300 && status < 400) {
          await response.body?.cancel();
          log.warn('megascans.fab.request.blocked', { kind, status, reason: 'redirect' });
          throw new FabBlockedError('Fab redirected the request, which Forge does not follow.', {
            status,
          });
        }
        if (status === 429 || status >= 500) {
          const serverWaitMs = retryAfterMs(response.headers.get('retry-after'), this.now());
          await response.body?.cancel();
          if (status === 429) {
            log.warn('megascans.fab.request.throttled', {
              kind,
              status,
              attempt,
              hasRetryAfter: serverWaitMs !== null,
              retryAfterSeconds: Math.ceil((serverWaitMs ?? 0) / 1000),
            });
          } else {
            log.warn('megascans.fab.request.failed', {
              kind,
              status,
              attempt,
              reason: 'server_error',
            });
          }
          if (status === 429 && serverWaitMs !== null && serverWaitMs > MAX_RETRY_AFTER_MS) {
            throw new FabBlockedError('Fab asked Forge to slow down for a while.', {
              status,
              kind: 'rate_limited',
              retryAfterSeconds: Math.ceil(serverWaitMs / 1000),
            });
          }
          if (attempt < this.maxAttempts) {
            await this.sleep(
              Math.max(serverWaitMs ?? 0, this.backoffMs * 2 ** (attempt - 1)),
              signal,
            );
            continue;
          }
          if (status === 429) {
            throw new FabBlockedError('Fab is limiting how fast Forge may ask.', {
              status,
              kind: 'rate_limited',
              retryAfterSeconds: serverWaitMs === null ? 600 : Math.ceil(serverWaitMs / 1000),
            });
          }
          throw new FabError(`Fab answered with an error (${status}).`, { status });
        }
        if (status === 401 || status === 403) {
          await response.body?.cancel();
          log.warn('megascans.fab.request.blocked', { kind, status, reason: 'refused' });
          throw new FabBlockedError('Fab is blocking automated requests.', { status });
        }
        if (status === 404) {
          await response.body?.cancel();
          throw new FabError('Fab has no such listing.', { status });
        }
        if (status < 200 || status >= 300) {
          await response.body?.cancel();
          throw new FabError(`Fab answered with an unexpected status (${status}).`, { status });
        }
        const type = (response.headers.get('content-type') || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const body = await readLimited(response, limit);
        if (kind === 'api' && type !== 'application/json') {
          // An HTML page where JSON was expected is a challenge, a login wall or an outage.
          const isChallenge = looksLikeChallenge(response.headers, body.toString('utf8'));
          log.warn('megascans.fab.request.blocked', {
            kind,
            status,
            reason: isChallenge ? 'challenge' : 'not_json',
          });
          throw isChallenge
            ? new FabBlockedError('Fab is blocking automated requests.', { status })
            : new FabError('Fab answered with something other than data.', { status });
        }
        return {
          status,
          type,
          body,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
        };
      }
      throw new FabError('Fab did not answer.');
    });
  }
}

// ----------------------------------------------------------------------------- parsing

function plain(value, max) {
  return (
    String(value ?? '')
      // eslint-disable-next-line no-control-regex -- Strip control characters from remote text.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .trim()
      .slice(0, max)
  );
}

/** Turns a small subset of Fab's HTML description into plain text. Never rendered as HTML. */
export function htmlToText(html, max = 2000) {
  const text = String(html ?? '')
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  return plain(text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n'), max);
}

function safeIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function imageAddress(listing) {
  const thumbnail = Array.isArray(listing.thumbnails) ? listing.thumbnails[0] : null;
  const images = Array.isArray(thumbnail?.images) ? thumbnail.images : [];
  const best = images
    .filter((image) => typeof image?.url === 'string')
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best?.url || (typeof thumbnail?.mediaUrl === 'string' ? thumbnail.mediaUrl : null);
}

/**
 * Reduces one search or detail result to the fields Forge keeps.
 * @returns {object | null} null when it is not a free Megascans 3D model.
 */
export function normalizeListing(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.uid !== 'string') {
    return null;
  }
  const price = raw.startingPrice?.price;
  const sellerName = raw.user?.sellerName;
  if (
    raw.listingType !== '3d-model' ||
    sellerName !== FAB_SELLER_NAME ||
    typeof price !== 'number' ||
    price !== 0
  ) {
    return null;
  }
  const formats = (Array.isArray(raw.assetFormats) ? raw.assetFormats : [])
    .map((format) => ({
      code: plain(format?.assetFormatType?.code, 40),
      name: plain(format?.assetFormatType?.name, 60),
      extensions: (format?.assetFormatType?.extensions || []).map((item) => plain(item, 12)),
      sizeMin: integerOrNull(format?.fileSizesRange?.lower),
      sizeMax: integerOrNull(format?.fileSizesRange?.upper),
    }))
    .filter((format) => format.code)
    .slice(0, 12);
  const sizes = formats
    .flatMap((format) => [format.sizeMin, format.sizeMax])
    .filter((n) => n !== null);
  return {
    id: raw.uid.toLowerCase(),
    title: plain(raw.title, 120) || 'Untitled listing',
    thumbnailUrl: imageAddress(raw),
    category: plain(raw.category?.name, 80) || null,
    tags: (Array.isArray(raw.tags) ? raw.tags : [])
      .map((tag) => plain(tag?.name, 30).toLowerCase())
      .filter(Boolean)
      .slice(0, 20),
    formats,
    sizeMin: sizes.length ? Math.min(...sizes) : null,
    sizeMax: sizes.length ? Math.max(...sizes) : null,
    price: 0,
    publishedAt: safeIso(raw.firstPublishedAt) || safeIso(raw.publishedAt),
    license: licenseName(raw.licenses),
  };
}

const STANDARD_LICENSE_URL = 'https://www.fab.com/eula';
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';

/** The link for a listing's licence, from the licence taxonomy: Standard is the Fab EULA. */
function licenseLink(licenses) {
  const list = Array.isArray(licenses) ? licenses : [];
  const cc = list.find((license) => license?.isCc);
  return cc && /by/i.test(`${cc.slug ?? ''}${cc.name ?? ''}`) ? CC_BY_URL : STANDARD_LICENSE_URL;
}

function licenseName(licenses) {
  const list = Array.isArray(licenses) ? licenses : [];
  const cc = list.find((license) => license?.isCc);
  if (cc) {
    return plain(cc.name, 80) || 'Creative Commons';
  }
  return 'Fab Standard License';
}

/** Search response to `{ listings, nextCursor, received }`. */
export function parseSearchResponse(json) {
  const results = Array.isArray(json?.results) ? json.results : null;
  if (!results) {
    throw new FabError('Fab sent a search result Forge could not read.');
  }
  const cursor = json?.cursors?.next;
  return {
    listings: results.map(normalizeListing).filter(Boolean),
    nextCursor: typeof cursor === 'string' && cursor.length <= 500 ? cursor : null,
    received: results.length,
  };
}

/**
 * Turns Fab's listing detail, the file list of every format and (when present) one format's
 * technical details into the fields shown in the dialog.
 */
export function parseDetail(detail, formats, tech) {
  const specs = tech?.techDetails?.threeDModel || {};
  const triangles = specs.totalTrianglesCountRange || {};
  const textures = specs.textureResolutionRange || {};
  const files = describeFiles(formats);
  return {
    description: htmlToText(detail?.description),
    license: licenseName(detail?.licenses),
    licenseUrl: licenseLink(detail?.licenses),
    groups: files.groups,
    recommendedUid: files.recommendedUid,
    trianglesMin: integerOrNull(triangles.lower),
    trianglesMax: integerOrNull(triangles.upper === undefined ? null : triangles.upper - 1),
    texturesCount: integerOrNull(specs.texturesCount),
    textureResolutionMax: integerOrNull(textures.upper === undefined ? null : textures.upper - 1),
    materialsCount: integerOrNull(specs.materialsCount),
  };
}

// ---------------------------------------------------------------------- high-level source

/** The two kinds of read Forge makes. All paths and parameters are fixed here. */
export class FabSource {
  /** @param {FabClient} client */
  constructor(client, { pageSize = SEARCH_PAGE_SIZE } = {}) {
    this.client = client;
    this.pageSize = pageSize;
  }

  /**
   * One page of free Megascans 3D models, newest first. Resolves to `{ notModified: true }` when
   * Fab confirms that the page has not changed since the last read.
   */
  async searchPage({ cursor = '', signal } = {}) {
    const params = new URLSearchParams({
      seller: FAB_SELLER_NAME,
      listing_types: '3d-model',
      is_free: '1',
      sort_by: '-firstPublishedAt',
      count: String(this.pageSize),
    });
    if (cursor) {
      params.set('cursor', cursor);
    }
    const json = await this.client.getJson(`/i/listings/search?${params}`, {
      signal,
      revalidateKey: `search:${cursor}`,
    });
    return json === NOT_MODIFIED ? { notModified: true } : parseSearchResponse(json);
  }

  /**
   * The listing's description and licence, every downloadable file, and (best effort) the
   * triangle and texture details of its FBX format. Two or three paced requests, each
   * revalidated when Fab sent a validator; `{ notModified: true }` when none changed.
   */
  async detail(id, { signal } = {}) {
    const safe = encodeURIComponent(id);
    const read = (path, key) =>
      this.client.getJson(path, { signal, revalidateKey: `${key}:${id}` });
    let detail = await read(`/i/listings/${safe}`, 'detail');
    let formats = await read(`/i/listings/${safe}/asset-formats`, 'formats');
    if (detail === NOT_MODIFIED && formats === NOT_MODIFIED) {
      return { notModified: true };
    }
    // One part changed: read the other unconditionally, because only parsed data is kept.
    if (detail === NOT_MODIFIED) {
      detail = await this.client.getJson(`/i/listings/${safe}`, { signal });
    }
    if (formats === NOT_MODIFIED) {
      formats = await this.client.getJson(`/i/listings/${safe}/asset-formats`, { signal });
    }
    if (!Array.isArray(formats)) {
      log.warn('megascans.fab.response.rejected', { kind: 'formats', reason: 'bad_shape' });
      throw new FabError('Fab sent a file list Forge could not read.');
    }
    let tech = null;
    if (formats.some((format) => format?.assetFormatType?.code === 'fbx')) {
      try {
        tech = await this.client.getJson(`/i/listings/${safe}/asset-formats/fbx`, { signal });
      } catch (error) {
        if (error instanceof FabBlockedError || signal?.aborted) {
          throw error;
        }
        log.debug('megascans.fab.technical.failed', { errorClass: error?.name });
      }
    }
    return parseDetail(detail, formats, tech);
  }
}
