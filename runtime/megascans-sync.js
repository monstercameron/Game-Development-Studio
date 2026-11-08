// Keeps the local Megascans cache in step with Fab, slowly and only when asked.
//
// Everything the page shows comes from the SQLite cache. This module is the only code that asks
// Fab for data: a manual Refresh (page one of the newest free models, at most once a minute),
// the detail of one listing (at most once every 30 seconds per listing, cached for 7 days), and
// the user-started catalog scan (a few pages per run, resumable, cancellable). A refusal from
// Fab (challenge, 401/403, a limit it asks Forge to respect) is stored as a "blocked" state and
// all Fab requests stop until it expires; Forge never tries to get around it.
import { FabBlockedError, FabError } from './megascans-fab.js';

export const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
export const DETAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_COOLDOWN_MS = 60 * 1000;
export const DETAIL_COOLDOWN_MS = 30 * 1000;
export const BLOCK_DURATION_MS = 60 * 60 * 1000;
export const RATE_LIMIT_DURATION_MS = 10 * 60 * 1000;
export const SCAN_MAX_PAGES = 10;
// The agreement the user confirms before Forge downloads on their behalf (dialog dated this day).
export const EULA_VERSION = '2024-10-01';
export const EULA_URL = 'https://www.fab.com/eula';

export class SyncError extends Error {
  constructor(message, status = 409, retryAfterSeconds = null) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const BLOCK_MESSAGE =
  'Fab is blocking automated requests. Try again later, or download from Fab yourself and use Import.';
const RATE_MESSAGE = 'Fab asked Forge to slow down. Try again later, or use what is already saved.';

export class FabSync {
  /**
   * @param {object} options
   * @param {{ db: import('node:sqlite').DatabaseSync }} options.handle
   * @param {import('./megascans-library.js').MegascansLibrary} options.library
   * @param {import('./megascans-fab.js').FabSource} options.source
   * @param {() => Date} [options.now]
   * @param {Console} [options.logger]
   * @param {number} [options.scanMaxPages]
   */
  constructor({
    handle,
    library,
    source,
    now = () => new Date(),
    logger = console,
    scanMaxPages = SCAN_MAX_PAGES,
  }) {
    this.db = handle.db;
    this.library = library;
    this.source = source;
    this.now = now;
    this.logger = logger;
    this.scanMaxPages = scanMaxPages;
    this.scanController = null;
    this.scanPromise = null;
    this.lastRefresh = new Map();
    this.lastDetail = new Map();
    this.detailReads = new Map();
    this.refreshing = null;
    this.loadingMore = null;
  }

  // ----------------------------------------------------------------------- stored state

  readKv(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
    if (!row) {
      return fallback;
    }
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  writeKv(key, value) {
    this.db
      .prepare(
        'INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  /** @returns {{ kind: string, until: string, message: string } | null} Only while it applies. */
  block() {
    const stored = this.readKv('block');
    return stored && Date.parse(stored.until) > this.now().getTime() ? stored : null;
  }

  storedBlock() {
    return this.readKv('block');
  }

  recordBlock(error) {
    const rateLimited = error.kind === 'rate_limited';
    const wait = rateLimited
      ? Math.max((error.retryAfterSeconds ?? 0) * 1000, RATE_LIMIT_DURATION_MS)
      : BLOCK_DURATION_MS;
    const stored = {
      kind: error.kind,
      status: error.status,
      until: new Date(this.now().getTime() + wait).toISOString(),
      message: rateLimited ? RATE_MESSAGE : BLOCK_MESSAGE,
    };
    this.writeKv('block', stored);
    this.logger.warn(`Megascans: Fab ${error.kind} (status ${error.status}); pausing requests.`);
    return stored;
  }

  /** Throws FabBlockedError without any request while a block is active. */
  assertNotBlocked() {
    const active = this.block();
    if (active) {
      throw new FabBlockedError(active.message, {
        kind: active.kind,
        status: active.status ?? 0,
        retryAfterSeconds: Math.ceil((Date.parse(active.until) - this.now().getTime()) / 1000),
      });
    }
  }

  /** The user asks to try again. Allowed once the pause has passed. */
  recheck() {
    const stored = this.storedBlock();
    if (stored && Date.parse(stored.until) > this.now().getTime()) {
      throw new SyncError(
        'Fab asked Forge to wait. Try again after the time shown.',
        429,
        Math.ceil((Date.parse(stored.until) - this.now().getTime()) / 1000),
      );
    }
    this.db.prepare("DELETE FROM kv WHERE key='block'").run();
  }

  async guarded(work) {
    this.assertNotBlocked();
    try {
      return await this.reachable(work);
    } catch (error) {
      if (error instanceof FabBlockedError) {
        this.recordBlock(error);
      } else if (error instanceof FabError && error.code === 'unreachable') {
        this.writeKv('reach', { at: this.now().toISOString(), message: error.message });
      }
      throw error;
    }
  }

  /** Runs `work`, clearing the "unreachable" note when it succeeds. */
  async reachable(work) {
    const result = await work();
    this.db.prepare("DELETE FROM kv WHERE key='reach'").run();
    return result;
  }

  // ---------------------------------------------------------- download confirmation

  /**
   * The user's one-time confirmation that they read and accept the Fab license agreement and the
   * listing's license. Forge never sets it by itself; only the page's checkbox does.
   */
  eula() {
    const stored = this.readKv('eula', null);
    return {
      confirmed: Boolean(stored?.acceptedAt),
      acceptedAt: stored?.acceptedAt ?? null,
      version: stored?.version ?? null,
      eulaUrl: EULA_URL,
      currentVersion: EULA_VERSION,
    };
  }

  acceptEula() {
    this.writeKv('eula', { acceptedAt: this.now().toISOString(), version: EULA_VERSION });
    return this.eula();
  }

  revokeEula() {
    this.db.prepare("DELETE FROM kv WHERE key='eula'").run();
    return this.eula();
  }

  // ------------------------------------------------------------------------- status

  newestPage(query = '') {
    return this.db
      .prepare("SELECT fetched_at FROM search_pages WHERE query=? AND cursor='' ")
      .get(query);
  }

  /** Whether Fab has more free models than the cache holds (true until the end was reached). */
  hasMoreOnFab() {
    const scan = this.scanStatus();
    if (scan.reachedEnd) {
      return false;
    }
    const first = this.db.prepare("SELECT next_cursor FROM search_pages WHERE key='|'").get();
    return !first || Boolean(first.next_cursor) || scan.pagesTotal > 0;
  }

  status() {
    const page = this.newestPage('');
    const fetchedAt = page?.fetched_at ?? null;
    const age = fetchedAt ? this.now().getTime() - Date.parse(fetchedAt) : null;
    const block = this.block();
    return {
      block,
      // Set when the last attempt could not reach Fab; the cache keeps working offline.
      unreachable: this.readKv('reach', null),
      downloads: this.eula(),
      cache: {
        listings: this.library.count({ source: 'fab' }),
        fetchedAt,
        stale: age === null || age > SEARCH_TTL_MS,
        hasMore: this.hasMoreOnFab(),
        ttlHours: SEARCH_TTL_MS / 3600000,
      },
      scan: this.scanStatus(),
      limits: {
        refreshCooldownSeconds: REFRESH_COOLDOWN_MS / 1000,
        scanMaxPagesPerRun: this.scanMaxPages,
      },
    };
  }

  // ------------------------------------------------------------------------ refresh

  /** Reads page one of the newest free models into the cache. Concurrent calls share one read. */
  async refresh() {
    // Fab's listing search ignores a text query when filtered by seller (checked live), so the
    // cache is always filled with the newest free models and searched locally.
    if (this.refreshing) {
      return this.refreshing;
    }
    if (this.scanController) {
      throw new SyncError('A catalog scan is running. Wait for it or cancel it first.');
    }
    this.assertNotBlocked();
    const last = this.lastRefresh.get('|') ?? 0;
    const wait = last + REFRESH_COOLDOWN_MS - this.now().getTime();
    if (wait > 0) {
      throw new SyncError(
        'Refreshed a moment ago. Try again shortly.',
        429,
        Math.ceil(wait / 1000),
      );
    }
    this.refreshing = this.guarded(async () => {
      this.lastRefresh.set('|', this.now().getTime());
      return this.readPage({ cursor: '' });
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Reads one listing page. When Fab confirms the page is unchanged, the stored copy is kept and
   * only its age is renewed.
   */
  async readPage({ cursor, signal }) {
    const page = await this.source.searchPage({ cursor, signal });
    if (page.notModified) {
      const key = `|${cursor}`;
      const stored = this.db
        .prepare('SELECT ids, next_cursor FROM search_pages WHERE key=?')
        .get(key);
      if (stored) {
        this.db
          .prepare('UPDATE search_pages SET fetched_at=? WHERE key=?')
          .run(this.now().toISOString(), key);
        const ids = JSON.parse(stored.ids);
        return {
          added: 0,
          updated: 0,
          received: ids.length,
          hasMore: Boolean(stored.next_cursor),
          notModified: true,
          nextCursor: stored.next_cursor,
          count: ids.length,
        };
      }
    }
    if (page.notModified) {
      // A validator without a stored page: forget it so the next read fetches the page again.
      this.source.client.validators?.delete(`search:${cursor}`);
      throw new FabError('The saved page is missing. Refresh again.');
    }
    const stored = this.storePage({ query: '', cursor, page });
    return { ...stored, nextCursor: page.nextCursor, count: page.listings.length };
  }

  /**
   * Reads the next page of free models beyond what the cache holds. Used when the user has
   * scrolled to the end of the local list; paced like every other Fab request.
   */
  async loadMore() {
    if (this.scanController || this.loadingMore) {
      throw new SyncError('Fab is already being read. Wait a moment.');
    }
    this.assertNotBlocked();
    const scan = this.scanStatus();
    const first = this.db.prepare("SELECT next_cursor FROM search_pages WHERE key='|'").get();
    if (!first) {
      throw new SyncError('Refresh first so Forge knows where the list starts.', 409);
    }
    const cursor =
      scan.pagesTotal > 0 && !scan.reachedEnd ? scan.cursor : (first.next_cursor ?? '');
    if (!cursor || scan.reachedEnd) {
      return { added: 0, updated: 0, received: 0, hasMore: false };
    }
    this.loadingMore = this.guarded(async () => {
      const result = await this.readPage({ cursor });
      this.saveScan({
        cursor: result.nextCursor || '',
        pagesTotal: scan.pagesTotal + 1,
        listingsSeen: scan.listingsSeen + result.count,
        reachedEnd: !result.nextCursor,
        status: result.nextCursor ? scan.status : 'completed',
      });
      return result;
    }).finally(() => {
      this.loadingMore = null;
    });
    return this.loadingMore;
  }

  storePage({ query, cursor, page }) {
    const result = this.library.upsertFab(page.listings);
    this.db
      .prepare(
        `INSERT INTO search_pages (key,query,cursor,ids,next_cursor,fetched_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET ids=excluded.ids, next_cursor=excluded.next_cursor,
           fetched_at=excluded.fetched_at`,
      )
      .run(
        `${query}|${cursor}`,
        query,
        cursor,
        JSON.stringify(page.listings.map((item) => item.id)),
        page.nextCursor,
        this.now().toISOString(),
      );
    return { ...result, received: page.received, hasMore: Boolean(page.nextCursor) };
  }

  // -------------------------------------------------------------------------- detail

  detailIsFresh(listing) {
    return Boolean(
      listing.detailFetchedAt &&
      this.now().getTime() - Date.parse(listing.detailFetchedAt) < DETAIL_TTL_MS,
    );
  }

  /**
   * Reads one listing's description and file list from Fab unless the cache is still fresh
   * (7 days). `force` re-reads it now (the page's Refresh). Concurrent calls share one read.
   */
  async loadDetail(id, { force = false } = {}) {
    const listing = this.library.get(id);
    if (!listing) {
      throw new SyncError('Listing not found.', 404);
    }
    if (listing.source !== 'fab' || (!force && this.detailIsFresh(listing))) {
      return { listing, fetched: false };
    }
    if (this.detailReads.has(id)) {
      return this.detailReads.get(id);
    }
    this.assertNotBlocked();
    const last = this.lastDetail.get(id) ?? 0;
    const wait = last + DETAIL_COOLDOWN_MS - this.now().getTime();
    if (wait > 0) {
      throw new SyncError('Checked a moment ago. Try again shortly.', 429, Math.ceil(wait / 1000));
    }
    const read = this.guarded(async () => {
      this.lastDetail.set(id, this.now().getTime());
      const detail = await this.source.detail(id);
      if (detail.notModified) {
        this.library.touchDetail(id);
        return { listing: this.library.get(id), fetched: true, notModified: true };
      }
      this.library.setDetail(id, detail);
      return { listing: this.library.get(id), fetched: true };
    }).finally(() => this.detailReads.delete(id));
    this.detailReads.set(id, read);
    return read;
  }

  // ---------------------------------------------------------------------------- scan

  scanStatus() {
    const stored = this.readKv('scan', null);
    return (
      stored || {
        status: 'idle',
        cursor: '',
        pagesThisRun: 0,
        pagesTotal: 0,
        listingsSeen: 0,
        maxPages: this.scanMaxPages,
        reachedEnd: false,
        error: null,
        updatedAt: null,
      }
    );
  }

  saveScan(patch) {
    const next = { ...this.scanStatus(), ...patch, updatedAt: this.now().toISOString() };
    this.writeKv('scan', next);
    return next;
  }

  /** A scan that was running when the process stopped becomes `interrupted` and can be resumed. */
  recoverScan() {
    const current = this.scanStatus();
    if (current.status === 'running') {
      this.saveScan({
        status: 'interrupted',
        error: 'Forge stopped during the scan. Resume it to continue.',
      });
    }
  }

  /**
   * Starts (or resumes) a capped background scan of the free Megascans 3D models. One run reads
   * at most `scanMaxPages` pages, then stops with status `capped`; start it again to continue.
   * @param {{ resume?: boolean }} [options]
   */
  startScan({ resume = false } = {}) {
    if (this.scanController) {
      throw new SyncError('A catalog scan is already running.');
    }
    this.assertNotBlocked();
    const previous = this.scanStatus();
    const canResume =
      resume &&
      ['interrupted', 'cancelled', 'capped', 'blocked', 'failed'].includes(previous.status) &&
      !previous.reachedEnd;
    const state = this.saveScan({
      status: 'running',
      cursor: canResume ? previous.cursor : '',
      pagesThisRun: 0,
      pagesTotal: canResume ? previous.pagesTotal : 0,
      listingsSeen: canResume ? previous.listingsSeen : 0,
      maxPages: this.scanMaxPages,
      reachedEnd: false,
      error: null,
    });
    this.scanController = new AbortController();
    this.scanPromise = this.runScan(this.scanController.signal).finally(() => {
      this.scanController = null;
    });
    return state;
  }

  cancelScan() {
    this.scanController?.abort();
    return this.scanStatus();
  }

  /** Resolves when a running scan has finished. For tests and shutdown. */
  async scanIdle() {
    await this.scanPromise?.catch(() => {});
  }

  async runScan(signal) {
    try {
      for (;;) {
        const current = this.scanStatus();
        if (current.pagesThisRun >= this.scanMaxPages) {
          this.saveScan({ status: 'capped' });
          return;
        }
        const cursor = current.cursor;
        this.assertNotBlocked();
        const page = await this.readPage({ cursor, signal });
        const done = !page.nextCursor || page.received === 0;
        this.saveScan({
          cursor: page.nextCursor || '',
          pagesThisRun: current.pagesThisRun + 1,
          pagesTotal: current.pagesTotal + 1,
          listingsSeen: current.listingsSeen + page.count,
          reachedEnd: done,
          status: done ? 'completed' : 'running',
          lastAdded: page.added,
        });
        if (done) {
          return;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        this.saveScan({ status: 'cancelled', error: null });
      } else if (error instanceof FabBlockedError) {
        this.recordBlock(error);
        this.saveScan({ status: 'blocked', error: error.message });
      } else {
        this.logger.warn('Megascans scan stopped:', error.message);
        this.saveScan({
          status: 'failed',
          error: error instanceof FabError ? error.message : 'The scan stopped unexpectedly.',
        });
      }
    }
  }
}
