import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Check, Copy, Download, ListFilter, Pause, Play, RefreshCw, X } from 'lucide-react';
import { LOG_COMPONENTS } from '../runtime/log-fields.js';
import { createLog } from './app-log.js';
import { useT } from './i18n/index.js';
import {
  LOG_URL_KEYS,
  downloadLogExport,
  fetchLogPage,
  fetchLogSummary,
  fetchLogTail,
  formatBytes,
  formatRowsAsJsonLines,
  groupDuplicateRows,
  readLogFilters,
} from './studio-log-api.js';
import { updateSearch } from './useNav';
import './studio-log.css';

const TAIL_INTERVAL_MS = 2000;
const log = createLog('diagnostics');
const MAX_ROWS_IN_VIEW = 2000;

function formatTime(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function LevelBadge({ level }) {
  // The level is written out, so the colour is never the only signal.
  return <span className={`studio-log-level is-${level}`}>{level.toUpperCase()}</span>;
}

function RowDetail({ group, onClose, onShowTrace, onShowJob, onCopy }) {
  const { t } = useT();
  const panelRef = useRef(null);
  const { row } = group;

  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener?.isConnected && typeof opener.focus === 'function') {
        opener.focus();
      }
    };
  }, [row.id]);

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <aside
      className="studio-log-detail"
      aria-labelledby="studio-log-detail-title"
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="studio-log-detail-heading">
        <h3 id="studio-log-detail-title">{row.event}</h3>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('diagnostics.studioLog.closeDetail', 'Close record details')}
          title={t('common.action.close', 'Close')}
          onClick={onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <dl className="studio-log-detail-list">
        <div>
          <dt>{t('diagnostics.studioLog.time', 'Time')}</dt>
          <dd>{formatTime(row.ts)}</dd>
        </div>
        {group.total > 1 && (
          <div>
            <dt>{t('diagnostics.studioLog.repeated', 'Repeated')}</dt>
            <dd>
              {t('diagnostics.studioLog.repeatedValue', '{count} times since {time}', {
                count: group.total,
                time: formatTime(group.oldestTs),
              })}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('diagnostics.studioLog.level', 'Level')}</dt>
          <dd>
            <LevelBadge level={row.level} />
          </dd>
        </div>
        <div>
          <dt>{t('diagnostics.studioLog.component', 'Component')}</dt>
          <dd>{row.component}</dd>
        </div>
        <div>
          <dt>{t('diagnostics.studioLog.process', 'Process')}</dt>
          <dd>
            {row.process} · {row.pid}
          </dd>
        </div>
        {row.message && (
          <div>
            <dt>{t('diagnostics.studioLog.message', 'Message')}</dt>
            <dd>{row.message}</dd>
          </div>
        )}
        {row.durationMs !== null && row.durationMs !== undefined && (
          <div>
            <dt>{t('diagnostics.studioLog.duration', 'Duration')}</dt>
            <dd>{t('diagnostics.studioLog.durationValue', '{ms} ms', { ms: row.durationMs })}</dd>
          </div>
        )}
        {row.jobId && (
          <div>
            <dt>{t('diagnostics.studioLog.job', 'Job')}</dt>
            <dd>
              <code>{row.jobId}</code>{' '}
              <button type="button" className="link-button" onClick={() => onShowJob(row.jobId)}>
                {t('diagnostics.studioLog.showJob', 'Show everything for this job')}
              </button>
            </dd>
          </div>
        )}
        {row.traceId && (
          <div>
            <dt>{t('diagnostics.studioLog.trace', 'Trace')}</dt>
            <dd>
              <code>{row.traceId}</code>{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => onShowTrace(row.traceId)}
              >
                {t('diagnostics.studioLog.showTrace', 'Show everything for this trace')}
              </button>
            </dd>
          </div>
        )}
      </dl>
      <h4>{t('diagnostics.studioLog.fields', 'Fields')}</h4>
      {row.fields && Object.keys(row.fields).length ? (
        <pre className="studio-log-fields">{JSON.stringify(row.fields, null, 2)}</pre>
      ) : (
        <p className="helper">
          {t('diagnostics.studioLog.noFields', 'This record has no fields.')}
        </p>
      )}
      <button type="button" className="outline-button" onClick={() => onCopy([row])}>
        <Copy size={14} aria-hidden="true" /> {t('diagnostics.studioLog.copyRecord', 'Copy record')}
      </button>
    </aside>
  );
}

export default function StudioLogView() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readLogFilters(params), [params]);
  const filterKey = JSON.stringify(filters);
  const [rows, setRows] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [status, setStatus] = useState('loading');
  const [errorText, setErrorText] = useState('');
  const [summary, setSummary] = useState(null);
  const [isLive, setIsLive] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState({ event: '', text: '', jobId: '' });
  const [reloadCount, setReloadCount] = useState(0);
  const requestRef = useRef(0);
  const tailCursorRef = useRef(0);

  useEffect(() => {
    setDraft({ event: filters.event, text: filters.text, jobId: filters.jobId });
  }, [filters.event, filters.text, filters.jobId]);

  const setFilter = useCallback(
    (changes) => {
      const next = {};
      for (const [key, value] of Object.entries(changes)) {
        next[LOG_URL_KEYS[key]] = value || null;
      }
      updateSearch(setParams, next);
    },
    [setParams],
  );

  const loadSummary = useCallback(async () => {
    try {
      const value = await fetchLogSummary();
      setSummary(value && typeof value === 'object' && Number.isFinite(value.rows) ? value : null);
    } catch {
      // log-coverage: ignore -- the fetch capture in app-log.js records failed /api calls
      setSummary(null);
    }
  }, []);

  // Loads the first page whenever the filters change; an older response never overwrites a newer
  // one.
  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    const pageFilters = JSON.parse(filterKey);
    setStatus('loading');
    setSelectedKey(null);
    fetchLogPage(pageFilters, { signal: controller.signal })
      .then((page) => {
        if (request !== requestRef.current) {
          return;
        }
        const pageRows = Array.isArray(page.rows) ? page.rows : [];
        setRows(pageRows);
        setNextCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
        tailCursorRef.current = pageRows.reduce((max, row) => Math.max(max, row.id || 0), 0);
        setStatus('ready');
      })
      .catch((error) => {
        if (request !== requestRef.current || error?.name === 'AbortError') {
          return;
        }
        setErrorText(error?.message || '');
        setStatus('error');
      });
    loadSummary();
    return () => controller.abort();
  }, [filterKey, reloadCount, loadSummary]);

  // Live tail: polls for rows added after the newest one shown.
  useEffect(() => {
    if (!isLive || status !== 'ready') {
      return undefined;
    }
    let isCancelled = false;
    let isPolling = false;
    const tailFilters = JSON.parse(filterKey);
    const poll = async () => {
      if (isPolling) {
        return;
      }
      isPolling = true;
      try {
        const result = await fetchLogTail(tailFilters, { afterId: tailCursorRef.current });
        if (isCancelled || !Array.isArray(result.rows)) {
          return;
        }
        if (Number.isInteger(result.cursor)) {
          tailCursorRef.current = Math.max(tailCursorRef.current, result.cursor);
        }
        if (result.rows.length) {
          const newestFirst = [...result.rows].reverse();
          setRows((current) => [...newestFirst, ...current].slice(0, MAX_ROWS_IN_VIEW));
        }
      } catch {
        // log-coverage: ignore -- a failed poll is retried on the next tick and recorded by the
        // fetch capture in app-log.js.
      } finally {
        isPolling = false;
      }
    };
    // log-coverage: ignore -- polling only; each request is recorded by the fetch capture
    const timer = setInterval(poll, TAIL_INTERVAL_MS);
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [isLive, status, filterKey]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function handleLoadMore() {
    if (!nextCursor) {
      return;
    }
    const request = requestRef.current;
    try {
      const page = await fetchLogPage(filters, { cursor: nextCursor });
      if (request !== requestRef.current) {
        return;
      }
      setRows((current) => [...current, ...(Array.isArray(page.rows) ? page.rows : [])]);
      setNextCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
    } catch (error) {
      // log-coverage: ignore -- shown to the user; the fetch capture records the failed request
      setNotice(
        error?.message || t('diagnostics.studioLog.loadFailed', 'Could not load the studio log.'),
      );
    }
  }

  async function handleCopy(selectedRows) {
    try {
      await navigator.clipboard.writeText(formatRowsAsJsonLines(selectedRows));
      setNotice(
        t('diagnostics.studioLog.copied', 'Copied {count} records.', {
          count: selectedRows.length,
        }),
      );
    } catch (error) {
      log.debug('diagnostics.clipboard.write.failed', { error });
      setNotice(
        t(
          'diagnostics.studioLog.clipboardFailed',
          'Could not access the clipboard in this browser.',
        ),
      );
    }
  }

  async function handleExport() {
    try {
      await downloadLogExport(filters);
    } catch (error) {
      log.warn('diagnostics.log.export.failed', { error });
      setNotice(error?.message || t('diagnostics.studioLog.exportFailed', 'Export failed.'));
    }
  }

  function handleApplyText(event) {
    event.preventDefault();
    setFilter({
      event: draft.event.trim().toLowerCase(),
      text: draft.text.trim(),
      jobId: draft.jobId.trim(),
    });
  }

  function handleShowTrace(traceId) {
    setFilter({ traceId, jobId: '', event: '', text: '', component: '', level: 'trace' });
  }

  function handleShowJob(jobId) {
    setFilter({ jobId, traceId: '', event: '', text: '', component: '', level: 'trace' });
  }

  const groups = useMemo(() => groupDuplicateRows(rows), [rows]);
  const selectedGroup = groups.find((group) => group.key === selectedKey) ?? null;
  const hasFilters =
    filters.level !== 'info' ||
    filters.component ||
    filters.event ||
    filters.text ||
    filters.jobId ||
    filters.traceId;
  const dropped = summary?.dropped ?? {};
  const droppedRecords =
    (dropped.records || 0) +
    (dropped.browser_dropped_records || 0) +
    (dropped.spool_rejected_lines || 0);

  return (
    <section className="panel studio-log-panel" aria-labelledby="studio-log-title">
      <div className="panel-heading">
        <div>
          <span className="mini-label">
            {t('diagnostics.studioLog.overline', 'STRUCTURED LOG')}
          </span>
          <h2 id="studio-log-title">{t('diagnostics.studioLog.title', 'Studio log')}</h2>
          <p>
            {t(
              'diagnostics.studioLog.lead',
              'Events from every Forge process, the browser and Python engines. Records hold ids, states, counts and durations; prompts, typed text, file contents, paths and keys are never stored.',
            )}
          </p>
        </div>
        <button
          type="button"
          className={`stream-toggle ${isLive ? 'is-live' : ''}`}
          aria-pressed={isLive}
          onClick={() => setIsLive((value) => !value)}
        >
          {isLive ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
          {isLive
            ? t('diagnostics.studioLog.stopLive', 'Stop live tail')
            : t('diagnostics.studioLog.startLive', 'Live tail')}
        </button>
      </div>

      {summary && (
        <dl
          className="studio-log-summary"
          aria-label={t('diagnostics.studioLog.summaryLabel', 'Log storage')}
        >
          <div>
            <dt>{t('diagnostics.studioLog.records', 'Records')}</dt>
            <dd>{summary.rows}</dd>
          </div>
          <div>
            <dt>{t('diagnostics.studioLog.databaseSize', 'Database size')}</dt>
            <dd>{formatBytes(summary.fileBytes)}</dd>
          </div>
          <div>
            <dt>{t('diagnostics.studioLog.retention', 'Kept for')}</dt>
            <dd>
              {t('diagnostics.studioLog.retentionValue', '{days} days, up to {size}', {
                days: summary.retention?.maxAgeDays ?? 14,
                size: formatBytes(summary.retention?.maxBytes),
              })}
            </dd>
          </div>
          <div>
            <dt>{t('diagnostics.studioLog.dropped', 'Dropped records')}</dt>
            <dd>{droppedRecords}</dd>
          </div>
          <div>
            <dt>{t('diagnostics.studioLog.collapsed', 'Collapsed repeats')}</dt>
            <dd>{dropped.collapsedRecords || 0}</dd>
          </div>
          <div>
            <dt>{t('diagnostics.studioLog.droppedFields', 'Rejected fields')}</dt>
            <dd>{dropped.fields || 0}</dd>
          </div>
        </dl>
      )}

      <form className="studio-log-filters" onSubmit={handleApplyText}>
        <label>
          <span>{t('diagnostics.studioLog.minimumLevel', 'Minimum level')}</span>
          <select
            value={filters.level}
            onChange={(event) => setFilter({ level: event.target.value })}
          >
            <option value="trace">{t('diagnostics.studioLog.levelTrace', 'Trace')}</option>
            <option value="debug">{t('diagnostics.studioLog.levelDebug', 'Debug')}</option>
            <option value="info">{t('diagnostics.studioLog.levelInfo', 'Info')}</option>
            <option value="warn">{t('diagnostics.studioLog.levelWarn', 'Warning')}</option>
            <option value="error">{t('diagnostics.studioLog.levelError', 'Error')}</option>
          </select>
        </label>
        <label>
          <span>{t('diagnostics.studioLog.component', 'Component')}</span>
          <select
            value={filters.component}
            onChange={(event) => setFilter({ component: event.target.value })}
          >
            <option value="">{t('diagnostics.studioLog.allComponents', 'All components')}</option>
            {LOG_COMPONENTS.map((component) => (
              <option key={component} value={component}>
                {component}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('diagnostics.studioLog.timeRange', 'Time range')}</span>
          <select
            value={filters.range}
            onChange={(event) => setFilter({ range: event.target.value })}
          >
            <option value="15m">{t('diagnostics.studioLog.range15m', 'Last 15 minutes')}</option>
            <option value="1h">{t('diagnostics.studioLog.range1h', 'Last hour')}</option>
            <option value="24h">{t('diagnostics.studioLog.range24h', 'Last 24 hours')}</option>
            <option value="7d">{t('diagnostics.studioLog.range7d', 'Last 7 days')}</option>
            <option value="all">{t('diagnostics.studioLog.rangeAll', 'Everything kept')}</option>
          </select>
        </label>
        <label>
          <span>{t('diagnostics.studioLog.eventPrefix', 'Event starts with')}</span>
          <input
            value={draft.event}
            placeholder="job.state"
            onChange={(event) => setDraft((current) => ({ ...current, event: event.target.value }))}
          />
        </label>
        <label>
          <span>{t('diagnostics.studioLog.search', 'Search words')}</span>
          <input
            type="search"
            value={draft.text}
            onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
          />
        </label>
        <label>
          <span>{t('diagnostics.studioLog.jobFilter', 'Job id')}</span>
          <input
            value={draft.jobId}
            onChange={(event) => setDraft((current) => ({ ...current, jobId: event.target.value }))}
          />
        </label>
        <div className="studio-log-filter-actions">
          <button type="submit" className="outline-button">
            <ListFilter size={14} aria-hidden="true" /> {t('diagnostics.studioLog.apply', 'Apply')}
          </button>
          {hasFilters && (
            <button
              type="button"
              className="link-button"
              onClick={() =>
                setFilter({
                  level: '',
                  component: '',
                  event: '',
                  text: '',
                  jobId: '',
                  traceId: '',
                })
              }
            >
              {t('diagnostics.studioLog.clearFilters', 'Clear filters')}
            </button>
          )}
        </div>
      </form>

      {filters.traceId && (
        <p className="studio-log-trace-chip">
          {t('diagnostics.studioLog.traceActive', 'Showing trace {traceId} across all processes.', {
            traceId: filters.traceId,
          })}{' '}
          <button type="button" className="link-button" onClick={() => setFilter({ traceId: '' })}>
            {t('diagnostics.studioLog.clearTrace', 'Show all traces')}
          </button>
        </p>
      )}

      <div className="studio-log-actions">
        <button
          type="button"
          className="link-button"
          onClick={() => handleCopy(rows)}
          disabled={!rows.length}
        >
          <Copy size={14} aria-hidden="true" />{' '}
          {t('diagnostics.studioLog.copyShown', 'Copy shown records')}
        </button>
        <button type="button" className="link-button" onClick={handleExport}>
          <Download size={14} aria-hidden="true" />{' '}
          {t('diagnostics.studioLog.export', 'Export (JSON lines)')}
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => setReloadCount((count) => count + 1)}
        >
          <RefreshCw size={14} aria-hidden="true" /> {t('diagnostics.studioLog.refresh', 'Refresh')}
        </button>
        {notice && (
          <strong role="status">
            <Check size={14} aria-hidden="true" /> {notice}
          </strong>
        )}
      </div>

      <div className="studio-log-body">
        <div
          className="studio-log-list"
          role="region"
          aria-label={t('diagnostics.studioLog.listLabel', 'Studio log records')}
        >
          {status === 'loading' && (
            <p className="helper" role="status">
              {t('diagnostics.studioLog.loading', 'Loading the studio log…')}
            </p>
          )}
          {status === 'error' && (
            <div className="log-empty-state" role="alert">
              <p>
                {t('diagnostics.studioLog.loadFailed', 'Could not load the studio log.')}{' '}
                {errorText}
              </p>
              <button
                type="button"
                className="link-button"
                onClick={() => setReloadCount((count) => count + 1)}
              >
                {t('common.action.retry', 'Retry')}
              </button>
            </div>
          )}
          {status === 'ready' && !groups.length && (
            <p className="log-empty-state">
              {hasFilters
                ? t('diagnostics.studioLog.emptyFiltered', 'No records match these filters.')
                : t(
                    'diagnostics.studioLog.empty',
                    'No records yet. Forge writes here as renders, engines and pages are used.',
                  )}
            </p>
          )}
          {status === 'ready' && groups.length > 0 && (
            <ol className="studio-log-rows">
              {groups.map((group) => (
                <li key={group.key}>
                  <button
                    type="button"
                    className={`studio-log-row ${selectedKey === group.key ? 'is-selected' : ''}`}
                    aria-expanded={selectedKey === group.key}
                    onClick={() => setSelectedKey(selectedKey === group.key ? null : group.key)}
                  >
                    <time dateTime={new Date(group.row.ts).toISOString()}>
                      {formatTime(group.row.ts)}
                    </time>
                    <LevelBadge level={group.row.level} />
                    <span className="studio-log-component">{group.row.component}</span>
                    <span className="studio-log-event">{group.row.event}</span>
                    {group.total > 1 && (
                      <span className="studio-log-count">
                        {t('diagnostics.studioLog.times', '×{count}', { count: group.total })}
                      </span>
                    )}
                    {group.row.jobId && <code className="studio-log-job">{group.row.jobId}</code>}
                    {group.row.durationMs !== null && group.row.durationMs !== undefined && (
                      <span className="studio-log-duration">
                        {t('diagnostics.studioLog.durationValue', '{ms} ms', {
                          ms: group.row.durationMs,
                        })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          )}
          {status === 'ready' && nextCursor && (
            <button
              type="button"
              className="outline-button studio-log-more"
              onClick={handleLoadMore}
            >
              {t('diagnostics.studioLog.loadOlder', 'Load older records')}
            </button>
          )}
        </div>
        {selectedGroup && (
          <RowDetail
            group={selectedGroup}
            onClose={() => setSelectedKey(null)}
            onShowTrace={handleShowTrace}
            onShowJob={handleShowJob}
            onCopy={handleCopy}
          />
        )}
      </div>
    </section>
  );
}
