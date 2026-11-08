import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw, ScanSearch, X } from 'lucide-react';
import { EPIC_AUP_URL, ExternalAnchor, FAB_EULA_URL, FAB_TERMS_URL } from './MegascansLegal';
import {
  describeScan,
  formatAge,
  getMegascans,
  isScanActive,
  postMegascans,
  requestFailureFields,
} from './megascans-api';
import { createLog } from './app-log.js';

const SCAN_POLL_MS = 1500;
const log = createLog('megascans');

/**
 * The state of the Fab cache and the slow, capped requests that fill it. The page reads
 * everything from the local cache; this hook only asks the studio to refresh it.
 * @param {{ onChanged: () => void }} options Called when the cache gained or lost listings.
 */
export function useFabCache({ onChanged }) {
  const [fab, setFab] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const autoTried = useRef(false);
  const isMounted = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(async (signal) => {
    try {
      const status = await getMegascans('/status', { signal });
      if (isMounted.current) {
        setFab(status.fab);
      }
      return status.fab;
    } catch (failure) {
      if (failure?.name !== 'AbortError') {
        log.debug('megascans.status.load.failed', requestFailureFields(failure));
      }
      if (failure?.name !== 'AbortError' && isMounted.current) {
        setError(failure.message);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const scanActive = isScanActive(fab?.scan);
  const lastSeen = useRef(0);
  useEffect(() => {
    if (!scanActive) {
      return undefined;
    }
    // log-coverage: ignore -- poll failures are logged in load(); the scan end is logged below
    const timer = setInterval(async () => {
      const next = await load();
      if (next && next.cache.listings !== lastSeen.current) {
        lastSeen.current = next.cache.listings;
        changed.current();
      }
    }, SCAN_POLL_MS);
    return () => clearInterval(timer);
  }, [scanActive, load]);

  // When the scan ends, show what it found.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !scanActive) {
      log.info('megascans.scan.stopped');
      changed.current();
    }
    wasActive.current = scanActive;
  }, [scanActive]);

  const run = useCallback(
    async (name, work) => {
      setBusy(name);
      setError('');
      setNotice('');
      try {
        await work();
      } catch (failure) {
        log.warn('megascans.fab.action.failed', { action: name, ...requestFailureFields(failure) });
        if (isMounted.current) {
          setError(failure.message);
        }
        await load();
      } finally {
        if (isMounted.current) {
          setBusy('');
        }
      }
    },
    [load],
  );

  const refresh = useCallback(
    () =>
      run('refresh', async () => {
        const result = await postMegascans('/refresh', {});
        setFab(result.fab);
        log.info('megascans.cache.refreshed', { addedCount: result.added });
        setNotice(
          result.added
            ? `Added ${result.added} new ${result.added === 1 ? 'listing' : 'listings'}.`
            : 'Already up to date.',
        );
        changed.current();
      }),
    [run],
  );

  const scan = useCallback(
    (action) =>
      run('scan', async () => {
        const result = await postMegascans('/scan', { action });
        setFab((current) => (current ? { ...current, scan: result.scan } : current));
        await load();
      }),
    [run, load],
  );

  /**
   * Asks Fab for one more page beyond the cache. Resolves true when the cache gained or updated
   * listings.
   */
  const readMore = useCallback(async () => {
    setError('');
    try {
      const result = await postMegascans('/more', {});
      if (isMounted.current) {
        setFab(result.fab);
      }
      return result.added > 0 || result.updated > 0;
    } catch (failure) {
      log.warn('megascans.more.load.failed', requestFailureFields(failure));
      if (isMounted.current) {
        setError(failure.message);
      }
      await load();
      return false;
    }
  }, [load]);

  const confirmDownloads = useCallback(
    () =>
      run('confirm', async () => {
        const result = await postMegascans('/downloads/confirm', { accepted: true });
        log.info('megascans.downloads.confirmed');
        setFab((current) => (current ? { ...current, downloads: result.downloads } : current));
      }),
    [run],
  );

  const withdrawDownloads = useCallback(
    () =>
      run('confirm', async () => {
        const result = await postMegascans('/downloads/revoke', {});
        log.info('megascans.downloads.withdrawn');
        setFab((current) => (current ? { ...current, downloads: result.downloads } : current));
      }),
    [run],
  );

  // Cache first: one automatic refresh per visit, only when the cache is old or empty and Fab
  // is not already refusing requests.
  useEffect(() => {
    if (!fab || autoTried.current) {
      return;
    }
    autoTried.current = true;
    if (fab.cache.stale && !fab.block && !isScanActive(fab.scan)) {
      refresh();
    } else if (fab.cache.stale) {
      log.info('megascans.refresh.skipped', {
        reason: fab.block ? 'fab_blocked' : 'scan_active',
      });
    }
  }, [fab, refresh]);

  return {
    fab,
    busy,
    notice,
    error,
    refresh,
    scan,
    readMore,
    confirmDownloads,
    withdrawDownloads,
    reload: load,
  };
}

export function FabCacheBar({ cache, query }) {
  const { fab, busy, notice, error, refresh, scan } = cache;
  if (!fab) {
    return (
      <p className="megascans-status-line" role="status">
        {error ? `Could not read the cache status: ${error}` : 'Checking the cache…'}
      </p>
    );
  }
  const age = formatAge(fab.cache.fetchedAt);
  const active = isScanActive(fab.scan);
  const block = fab.block;
  const canResume =
    ['capped', 'cancelled', 'interrupted', 'blocked', 'failed'].includes(fab.scan.status) &&
    !fab.scan.reachedEnd &&
    fab.scan.pagesTotal > 0;
  const blockedUntil = block ? new Date(block.until) : null;
  const percent = active
    ? Math.min(100, Math.round((fab.scan.pagesThisRun / fab.scan.maxPages) * 100))
    : null;
  return (
    <div className="megascans-cache">
      {block && (
        <div className="megascans-error" role="alert">
          <p>
            {block.message}
            {blockedUntil && (
              <>
                {' '}
                Forge will not ask Fab again before{' '}
                <time dateTime={block.until}>{blockedUntil.toLocaleTimeString()}</time>.
              </>
            )}
          </p>
        </div>
      )}
      <p className="megascans-status-line" role="status">
        {fab.cache.fetchedAt ? `Cached ${age}` : 'Not read from Fab yet'} ·{' '}
        {fab.cache.listings.toLocaleString('en-US')}{' '}
        {fab.cache.listings === 1 ? 'listing' : 'listings'} from Fab
        {query ? ' (searching only what is cached)' : ''}
      </p>
      <div className="megascans-cache-actions">
        <button
          type="button"
          className="outline-button"
          disabled={Boolean(block) || busy === 'refresh' || active}
          onClick={refresh}
        >
          {busy === 'refresh' ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}{' '}
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
        </button>
        {active ? (
          <button type="button" className="outline-button" onClick={() => scan('cancel')}>
            <X size={14} aria-hidden="true" /> Cancel scan
          </button>
        ) : (
          <button
            type="button"
            className="outline-button"
            disabled={Boolean(block) || busy === 'scan'}
            onClick={() => scan(canResume ? 'resume' : 'start')}
          >
            <ScanSearch size={14} aria-hidden="true" /> {canResume ? 'Resume scan' : 'Scan catalog'}
          </button>
        )}
        <span className="helper megascans-cache-note">
          Fab data is fetched slowly (one request at a time, with pauses) and cached here.
        </span>
      </div>
      {fab.scan.status !== 'idle' && (
        <div className="megascans-scan" role="status">
          <p className="megascans-import-meta">{describeScan(fab.scan)}</p>
          {active && (
            <div
              className="megascans-progress"
              role="progressbar"
              aria-label="Catalog scan progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span style={{ width: `${percent}%` }} />
            </div>
          )}
        </div>
      )}
      {fab.unreachable && !block && (
        <p className="helper" role="status">
          Fab could not be reached at {new Date(fab.unreachable.at).toLocaleTimeString()}.
          Everything saved here still works; starting a download needs a connection.
        </p>
      )}
      {notice && (
        <p className="helper" role="status">
          {notice}
        </p>
      )}
      {error && !block && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The one-time confirmation that unlocks downloads. Only the user's own click sets it; nothing in
 * Forge ticks it, and an agent has no tool for it.
 */
export function DownloadConsent({ downloads, busy, onConfirm, onWithdraw, listing = null }) {
  if (!downloads) {
    return null;
  }
  const confirmed = downloads.confirmed;
  return (
    <div className="megascans-consent">
      <label className="megascans-consent-label">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => (event.target.checked ? onConfirm() : onWithdraw())}
        />
        <span>
          I have read and accept the{' '}
          <ExternalAnchor href={FAB_EULA_URL}>Fab End User License Agreement</ExternalAnchor>, the{' '}
          <ExternalAnchor href={FAB_TERMS_URL}>Fab Terms of Service</ExternalAnchor>,{' '}
          <ExternalAnchor href={EPIC_AUP_URL}>Epic&apos;s Acceptable Use Policy</ExternalAnchor>
          {listing ? (
            <>
              {' '}
              and this listing&apos;s licence (
              <ExternalAnchor href={listing.licenseUrl || FAB_EULA_URL}>
                {listing.license}
              </ExternalAnchor>
              )
            </>
          ) : (
            ' and the licence of each listing I download'
          )}
          .
        </span>
      </label>
      <p className="helper">
        {confirmed
          ? `Confirmed on ${new Date(downloads.acceptedAt).toLocaleDateString()}. Untick to withdraw it and turn downloads off.`
          : 'Forge downloads files from Fab only after you tick this once. It is saved on this computer.'}
      </p>
    </div>
  );
}
