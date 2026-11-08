import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, ExternalLink, ImageOff, PackageOpen } from 'lucide-react';
import { createLog } from './app-log.js';
import {
  describeFormats,
  describeSizeRange,
  getMegascans,
  requestFailureFields,
} from './megascans-api';

const log = createLog('megascans');

const PAGE_SIZE = 24;
const MAX_INITIAL_PAGES = 10;

/** Preview image with a placeholder while it loads and a visible state when it cannot. */
function Thumbnail({ listing }) {
  const [state, setState] = useState('loading');
  if (!listing.thumbnailUrl) {
    return (
      <div className="megascans-card-preview">
        <Box size={30} aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className={`megascans-card-preview megascans-preview-${state}`}>
      {state === 'error' ? (
        <span className="megascans-preview-error">
          <ImageOff size={22} aria-hidden="true" />
          <span>No preview</span>
        </span>
      ) : (
        <img
          src={listing.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
        />
      )}
    </div>
  );
}

function ListingCard({ listing, onOpen, onImport, canImport }) {
  const size = describeSizeRange(listing);
  return (
    <article className="megascans-card" aria-label={listing.title}>
      <Thumbnail listing={listing} />
      <h3 className="megascans-card-title">
        <button type="button" className="megascans-card-open" onClick={() => onOpen(listing.id)}>
          {listing.title}
        </button>
      </h3>
      <p className="megascans-card-license">
        {[listing.category, describeFormats(listing), size].filter(Boolean).join(' · ')}
      </p>
      <p className="megascans-card-license">Licence: {listing.license}</p>
      {listing.tags.length > 0 && (
        <ul className="megascans-tags" aria-label="Tags">
          {listing.tags.slice(0, 5).map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      <div className="megascans-card-actions">
        <a
          className="outline-button"
          href={listing.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${listing.title} on Fab (opens in a new tab)`}
        >
          <ExternalLink size={14} aria-hidden="true" /> Open on Fab
        </a>
        <button
          type="button"
          className="outline-button"
          disabled={!canImport}
          title={canImport ? undefined : 'Choose a project first'}
          aria-label={`Import a downloaded file for ${listing.title}`}
          onClick={() => onImport(listing)}
        >
          Import file
        </button>
      </div>
    </article>
  );
}

function Skeletons({ count = 6 }) {
  return (
    <div className="megascans-grid megascans-skeletons" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="megascans-card megascans-skeleton" />
      ))}
    </div>
  );
}

/**
 * The model grid. It shows the local cache in chunks of 24: more are appended by the Load more
 * button, or when the end of the list scrolls into view. Only when the whole cache is shown does
 * "Read more from Fab" ask Fab for one more page, and only after the user has scrolled or clicked.
 */
export default function ModelList({
  query,
  tag,
  sort,
  initialPages,
  reloadKey,
  cache,
  canImport,
  onOpen,
  onImport,
  onPages,
  onTags,
  onClear,
  onRetry,
}) {
  const [list, setList] = useState({
    status: 'loading',
    items: [],
    total: 0,
    pages: 0,
    pageCount: 1,
  });
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [liveText, setLiveText] = useState('');
  const sentinel = useRef(null);
  const container = useRef(null);
  const loadedPages = useRef(0);
  const filterKey = useRef('');
  const firstLoad = useRef(true);
  const working = useRef(false);
  const userScrolled = useRef(false);
  const focusIndex = useRef(null);
  const onTagsRef = useRef(onTags);
  onTagsRef.current = onTags;
  // Only the first load honors a deep link's page count; later appends must not reload the list.
  const initialPagesRef = useRef(initialPages);
  const onPagesRef = useRef(onPages);
  onPagesRef.current = onPages;

  const fetchPage = useCallback(
    (page, signal) => {
      const search = new URLSearchParams({ sort, page: String(page), pageSize: String(PAGE_SIZE) });
      if (query) {
        search.set('q', query);
      }
      if (tag) {
        search.set('tag', tag);
      }
      return getMegascans(`/listings?${search}`, { signal });
    },
    [query, tag, sort],
  );

  // Load (or reload) from the start. A refresh keeps as many pages as were already shown.
  useEffect(() => {
    const controller = new AbortController();
    const key = JSON.stringify([query, tag, sort]);
    const changed = filterKey.current !== key;
    filterKey.current = key;
    const wanted = changed
      ? firstLoad.current
        ? Math.min(initialPagesRef.current, MAX_INITIAL_PAGES)
        : 1
      : Math.max(loadedPages.current, 1);
    firstLoad.current = false;
    setList((current) => ({
      ...current,
      status: current.items.length && !changed ? 'ready' : 'loading',
    }));
    Promise.all(
      Array.from({ length: wanted }, (_, index) => fetchPage(index + 1, controller.signal)),
    )
      .then((results) => {
        const last = results.at(-1);
        loadedPages.current = results.length;
        setList({
          status: 'ready',
          items: results.flatMap((result) => result.listings),
          total: last.total,
          pages: results.length,
          pageCount: last.pageCount,
        });
        onTagsRef.current?.(results[0].tags);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setList((current) => ({ ...current, status: 'error', error: error.message }));
        }
      });
    return () => controller.abort();
  }, [fetchPage, reloadKey, query, tag, sort]);

  const hasLocalMore = list.status === 'ready' && list.pages < list.pageCount;
  const hasRemoteMore =
    list.status === 'ready' &&
    !hasLocalMore &&
    !query &&
    !tag &&
    Boolean(cache.fab?.cache.hasMore) &&
    !cache.fab?.block &&
    cache.fab?.scan.status !== 'running';

  const loadLocal = useCallback(async () => {
    if (working.current) {
      return;
    }
    working.current = true;
    const hadFocus = Boolean(document.activeElement?.classList?.contains('megascans-load-more'));
    setBusy(true);
    setMoreError('');
    try {
      const data = await fetchPage(loadedPages.current + 1);
      loadedPages.current += 1;
      focusIndex.current = { index: list.items.length, hadFocus };
      setList((current) => ({
        ...current,
        items: [...current.items, ...data.listings],
        total: data.total,
        pages: loadedPages.current,
        pageCount: data.pageCount,
      }));
      onPagesRef.current?.(loadedPages.current);
      setLiveText(
        `${data.listings.length} more models loaded. Showing ${list.items.length + data.listings.length} of ${data.total}.`,
      );
    } catch (error) {
      log.warn('megascans.list.more.failed', requestFailureFields(error));
      setMoreError(error.message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }, [fetchPage, list.items.length]);

  const readRemote = useCallback(async () => {
    if (working.current) {
      return;
    }
    working.current = true;
    const hadFocus = Boolean(document.activeElement?.classList?.contains('megascans-load-more'));
    setBusy(true);
    setMoreError('');
    try {
      const result = await cache.readMore();
      if (result) {
        // New models can land anywhere in the order, so shown pages are read again.
        const shown = loadedPages.current;
        const results = await Promise.all(
          Array.from({ length: shown }, (_, index) => fetchPage(index + 1)),
        );
        if (results.at(-1).pageCount > shown) {
          results.push(await fetchPage(shown + 1));
        }
        const items = results.flatMap((page) => page.listings);
        const added = items.length - list.items.length;
        loadedPages.current = results.length;
        focusIndex.current = { index: list.items.length, hadFocus };
        setList((current) => ({
          ...current,
          items,
          total: results.at(-1).total,
          pages: results.length,
          pageCount: results.at(-1).pageCount,
        }));
        onPagesRef.current?.(loadedPages.current);
        setLiveText(`${added} more models read from Fab and shown.`);
      }
    } catch (error) {
      log.warn('megascans.list.remote.failed', requestFailureFields(error));
      setMoreError(error.message);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }, [cache, fetchPage, list.items.length]);

  // Remember whether the person has scrolled: Fab is only asked for more after that.
  useEffect(() => {
    const mark = () => {
      userScrolled.current = true;
    };
    const events = ['wheel', 'touchmove', 'keydown', 'scroll'];
    for (const name of events) {
      document.addEventListener(name, mark, { capture: true, passive: true });
    }
    return () => {
      for (const name of events) {
        document.removeEventListener(name, mark, { capture: true });
      }
    };
  }, []);

  // Append the next chunk when the end of the list scrolls into view.
  useEffect(() => {
    const element = sentinel.current;
    if (
      !element ||
      typeof IntersectionObserver === 'undefined' ||
      (!hasLocalMore && !hasRemoteMore)
    ) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      if (hasLocalMore) {
        loadLocal();
      } else if (hasRemoteMore && userScrolled.current) {
        readRemote();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasLocalMore, hasRemoteMore, loadLocal, readRemote, list.items.length]);

  // Keep keyboard focus useful when the Load more button goes away after the last chunk.
  useEffect(() => {
    if (focusIndex.current === null) {
      return;
    }
    const { index, hadFocus } = focusIndex.current;
    focusIndex.current = null;
    // The button the person used is gone once the last chunk is shown: move focus to the first
    // new model instead of dropping it on the page.
    if (hadFocus && !hasLocalMore && !hasRemoteMore) {
      container.current?.querySelectorAll('.megascans-card-open')[index]?.focus();
    }
  }, [list.items.length, hasLocalMore, hasRemoteMore]);

  const empty = list.status === 'ready' && list.total === 0;
  const isEmptyCache = empty && !query && !tag;
  return (
    <div ref={container}>
      <p className="megascans-status-line" role="status">
        {list.status === 'ready' && list.total > 0
          ? `Showing ${list.items.length.toLocaleString('en-US')} of ${list.total.toLocaleString('en-US')} ${
              list.total === 1 ? 'model' : 'models'
            }${query || tag ? ' that match' : ''}`
          : list.status === 'loading'
            ? 'Loading models…'
            : ''}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {liveText}
      </p>
      {list.status === 'error' && (
        <div className="megascans-error" role="alert">
          <p>Could not load models: {list.error}</p>
          <button type="button" className="outline-button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {list.status === 'loading' && list.items.length === 0 && <Skeletons />}
      {isEmptyCache && (
        <div className="megascans-empty">
          <PackageOpen size={28} aria-hidden="true" />
          <p>
            No models are cached yet.{' '}
            {cache.busy === 'refresh'
              ? 'Reading the newest free models from Fab…'
              : 'Press Refresh to read the newest free models from Fab, or Scan catalog to read more of them. You can also add a listing by its address, or import a file you downloaded.'}
          </p>
        </div>
      )}
      {empty && !isEmptyCache && (
        <div className="megascans-empty">
          <p>No cached models match this search. Only what is cached is searched.</p>
          <button type="button" className="outline-button" onClick={onClear}>
            Clear search
          </button>
        </div>
      )}
      {list.items.length > 0 && (
        <div className="megascans-grid" aria-busy={busy}>
          {list.items.map((listing) => (
            <ListingCard
              key={listing.id}
              listing={listing}
              canImport={canImport}
              onOpen={onOpen}
              onImport={onImport}
            />
          ))}
        </div>
      )}
      {busy && <Skeletons count={3} />}
      {list.status === 'ready' && list.items.length > 0 && (
        <div className="megascans-more">
          {hasLocalMore && (
            <button
              type="button"
              className="outline-button megascans-load-more"
              aria-disabled={busy}
              onClick={() => (busy ? undefined : loadLocal())}
            >
              Load more models ({(list.total - list.items.length).toLocaleString('en-US')} left in
              the cache)
            </button>
          )}
          {hasRemoteMore && (
            <button
              type="button"
              className="outline-button megascans-load-more"
              aria-disabled={busy}
              onClick={() => {
                userScrolled.current = true;
                if (!busy) {
                  readRemote();
                }
              }}
            >
              Read more from Fab
            </button>
          )}
          {!hasLocalMore && !hasRemoteMore && (
            <p className="helper">
              {query || tag
                ? 'That is every cached model that matches.'
                : 'That is every model in the cache.'}
            </p>
          )}
          {moreError && (
            <p className="settings-error" role="alert">
              {moreError}
            </p>
          )}
          <div ref={sentinel} className="megascans-sentinel" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
