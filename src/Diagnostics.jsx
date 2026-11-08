import { useSearchParams } from 'react-router';
import { updateSearch } from './useNav';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  Check,
  Copy,
  FileText,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  Terminal,
} from 'lucide-react';
import ErrorPipelineTest from './ErrorPipelineTest';
import StudioLogView from './StudioLogView.jsx';
import { createLog } from './app-log.js';
import { filterLogLines, isErrorLine, isWarnLine } from './diagnostics-filter.js';
import './diagnostics-page.css';

const log = createLog('diagnostics');

// Relative wording for file times; the absolute time stays in the tooltip.
function formatRelative(iso, now) {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(seconds)) {
    return iso;
  }
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
}

export default function Diagnostics() {
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState('');
  const [sources, setSources] = useState([]);
  const [params, setParams] = useSearchParams();
  const selected = params.get('source') || 'all';
  const setSelected = (value) =>
    updateSearch(setParams, { source: value === 'all' ? null : value });
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [connection, setConnection] = useState('Connecting');
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [copyMessage, setCopyMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const logWindowRef = useRef(null);
  const followTail = useRef(true);
  const isMetadataFailing = useRef(false);
  const errorsOnly = params.get('errors') === '1';
  const setErrorsOnly = (value) => updateSearch(setParams, { errors: value ? '1' : null });
  async function refreshMetadata() {
    try {
      const response = await fetch('/api/diagnostics');
      if (!response.ok) {
        throw Error('Diagnostics unavailable.');
      }
      setMetadata(await response.json());
      setMetadataError('');
      if (isMetadataFailing.current) {
        isMetadataFailing.current = false;
        log.info('diagnostics.metadata.recovered', {});
      }
    } catch (error) {
      // Logged once per failure streak, not on every 15 second poll.
      if (!isMetadataFailing.current) {
        isMetadataFailing.current = true;
        log.debug('diagnostics.metadata.failed', { error });
      }
      setMetadata(null);
      setMetadataError(
        'Could not reach the diagnostics service. Refresh server details; if the problem continues, restart the studio.',
      );
    }
  }
  useEffect(() => {
    refreshMetadata();
    const timer = setInterval(refreshMetadata, 15000);
    log.debug('diagnostics.metadata.polling.started', { intervalMs: 15000 });
    return () => {
      clearInterval(timer);
      log.debug('diagnostics.metadata.polling.stopped', {});
    };
  }, []);
  useEffect(() => {
    // log-coverage: ignore -- display clock for relative times; it has no request or failure path
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (paused) {
      setConnection('Paused');
      return;
    }
    setConnection('Connecting');
    // Stream problems are logged once per connection attempt: a log record can itself refresh
    // this view, so logging on every event could feed back into the stream.
    let isInvalidResponseLogged = false;
    let isReadFailureLogged = false;
    const stream = new EventSource('/api/logs/stream');
    stream.onopen = () => setConnection('Live');
    stream.addEventListener('logs', (event) => {
      try {
        setSources(JSON.parse(event.data).sources);
        setConnection('Live');
      } catch (error) {
        if (!isInvalidResponseLogged) {
          isInvalidResponseLogged = true;
          log.warn('diagnostics.stream.invalid', { error });
        }
        setConnection('Invalid log response');
      }
    });
    stream.onerror = (event) => {
      if (typeof event.data !== 'string') {
        setConnection('Reconnecting');
        return;
      }
      let detail = 'Unable to read logs.';
      try {
        detail = JSON.parse(event.data).error || detail;
        // log-coverage: ignore -- fallback text may echo raw log lines or paths; it is shown only
      } catch {
        detail = event.data || detail;
      }
      if (!isReadFailureLogged) {
        isReadFailureLogged = true;
        log.warn('diagnostics.stream.failed', {});
      }
      setConnection(`Log read failed: ${detail}`);
    };
    return () => stream.close();
  }, [paused, streamAttempt]);
  useEffect(() => {
    if (copyMessage) {
      const timer = setTimeout(() => setCopyMessage(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [copyMessage]);
  const visible = useMemo(
    () =>
      sources
        .filter((source) => selected === 'all' || source.id === selected)
        .map((source) => ({
          ...source,
          lines: filterLogLines(source.lines, { errorsOnly, query }),
        })),
    [sources, selected, query, errorsOnly],
  );
  const hasUnknownSource =
    sources.length > 0 && selected !== 'all' && !sources.some((source) => source.id === selected);
  const streamFailed =
    connection.startsWith('Log read failed') || connection === 'Invalid log response';
  // Follow the newest lines while the reader is at the bottom; stop once they scroll up.
  useEffect(() => {
    const element = logWindowRef.current;
    if (element && followTail.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [visible]);
  function jumpToLatest() {
    const element = logWindowRef.current;
    if (element) {
      followTail.current = true;
      element.scrollTop = element.scrollHeight;
    }
  }
  function handleLogScroll(event) {
    const element = event.currentTarget;
    followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }
  function formatLogSources(logSources, { filtered = false } = {}) {
    return logSources
      .map((source) => {
        const lines = filtered ? filterLogLines(source.lines, { errorsOnly, query }) : source.lines;
        const header = `[${source.label}]${source.file ? `\n${source.file}` : ''}`;
        const body = source.available
          ? lines.join('\n') || '(No matching log lines)'
          : source.unavailable || 'Unavailable';
        return `${header}\n${body}`;
      })
      .join('\n\n');
  }
  async function copy(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label} copied.`);
    } catch (error) {
      log.warn('diagnostics.clipboard.failed', { error });
      setCopyMessage('Could not access the clipboard in this browser.');
    }
  }
  return (
    <div className="page diagnostics-page">
      <div className="overline">
        <span className="overline-line" /> STUDIO HEALTH
      </div>
      <h1>
        Diagnostics<em>.</em>
      </h1>
      <p className="lead">See where services are running and follow their logs in one place.</p>
      <p className="diagnostics-errors-link">
        <button
          type="button"
          className="outline-button"
          onClick={() => updateSearch(setParams, { dialog: 'errors' })}
        >
          Open error review
        </button>{' '}
        Review, copy and fix captured errors and stack traces.
      </p>
      <div className="diagnostics-layout">
        <section className="panel metadata-panel">
          <div className="panel-heading">
            <div>
              <span className="mini-label">LOCAL SERVER</span>
              <h2>Server details</h2>
            </div>
            <button
              className="icon-btn"
              title="Refresh server details"
              aria-label="Refresh server details"
              onClick={refreshMetadata}
            >
              <RefreshCw size={17} />
            </button>
          </div>
          {metadataError ? (
            <p className="settings-error" role="alert">
              {metadataError}
            </p>
          ) : !metadata ? (
            <p className="helper">Loading server details…</p>
          ) : (
            <>
              <div className="server-address">
                <div className="settings-symbol">
                  <Server size={18} />
                </div>
                <div>
                  <small>STUDIO ADDRESS</small>
                  <strong>{metadata.server.url}</strong>
                </div>
                <span className="server-ready">
                  <i /> RUNNING
                </span>
              </div>
              <dl className="metadata-list">
                <div>
                  <dt>HTTP process ID</dt>
                  <dd>{metadata.server.pid}</dd>
                </div>
                {metadata.server.supervisorPid && (
                  <div>
                    <dt>Supervisor process ID</dt>
                    <dd>{metadata.server.supervisorPid}</dd>
                  </div>
                )}
                <div>
                  <dt>Project folder</dt>
                  <dd>{metadata.server.projectDirectory}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>
                    Node {metadata.server.nodeVersion} · {metadata.server.platform}{' '}
                    {metadata.server.architecture}
                  </dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{new Date(metadata.server.startedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Logs API</dt>
                  <dd>{metadata.logEndpoints.snapshot}</dd>
                </div>
                <div>
                  <dt>Live stream</dt>
                  <dd>{metadata.logEndpoints.stream}</dd>
                </div>
              </dl>
              <button
                className="outline-button"
                onClick={() => copy(JSON.stringify(metadata, null, 2), 'Server details')}
              >
                <Copy size={15} /> Copy server details
              </button>
            </>
          )}
          <div className="service-heading">
            <span className="mini-label">SERVICE ADDRESSES</span>
            <span>STATUS</span>
          </div>
          {metadata?.services.map((service) => (
            <div className="service-row" key={service.id}>
              <div>
                <strong>{service.name}</strong>
                <span>{service.url}</span>
              </div>
              <span className={'service-state ' + (service.reachable ? 'online' : '')}>
                <i /> {service.reachable ? 'Responding' : 'Not responding'}
              </span>
            </div>
          ))}
          <p className="diagnostic-note">
            Port status shows reachability; it does not confirm the service identity.
          </p>
        </section>
        <section className="panel logs-panel">
          <div className="panel-heading">
            <div>
              <span className="mini-label">LIVE ACTIVITY</span>
              <h2>Studio logs</h2>
              <p>Recent lines from the studio and existing services.</p>
            </div>
            <span
              className={'live-status ' + (connection === 'Live' ? 'is-live' : '')}
              role="status"
              aria-live="polite"
              title={paused ? 'Paused: showing the last snapshot received.' : undefined}
            >
              <i /> {connection}
            </span>
          </div>
          <div className="log-controls">
            <label>
              <span className="sr-only log-control-label">Log source</span>
              <select
                value={hasUnknownSource ? 'all' : selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="all">All sources</option>
                {sources.map((source) => (
                  <option value={source.id} key={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="log-search">
              <span className="sr-only log-control-label">Filter log lines</span>
              <Search size={15} />
              <input
                aria-label="Filter log lines"
                placeholder="Filter log lines"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button
              className="stream-toggle"
              title={
                paused
                  ? 'Resume live log updates.'
                  : 'Stop live log updates and keep the current lines on screen.'
              }
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused ? 'Resume stream' : 'Pause stream'}
            </button>
          </div>
          <div className="log-options">
            <label>
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={(e) => setErrorsOnly(e.target.checked)}
              />{' '}
              Errors only
            </label>
            <div className="log-copy-actions">
              <button
                className="link-button"
                title="Copies the lines shown below: the selected source, errors-only and text filter applied."
                onClick={() =>
                  copy(formatLogSources(visible, { filtered: true }), 'Matching lines')
                }
              >
                <Copy size={14} /> Copy matching lines
              </button>
              <button
                className="link-button"
                title="Copies every kept line for the selected source, ignoring the errors-only and text filters."
                onClick={() =>
                  copy(
                    formatLogSources(
                      sources.filter((source) => selected === 'all' || source.id === selected),
                    ),
                    'All lines',
                  )
                }
              >
                <Copy size={14} /> Copy all lines
              </button>
            </div>
          </div>
          <div
            className="log-window"
            ref={logWindowRef}
            onScroll={handleLogScroll}
            role="log"
            aria-label="Recent service logs"
            aria-live="off"
            tabIndex={0}
          >
            {hasUnknownSource ? (
              <div className="log-placeholder log-empty-state">
                <AlertCircle size={20} aria-hidden="true" />
                <p>Log source “{selected}” is not available.</p>
                <button className="link-button" onClick={() => setSelected('all')}>
                  Show all log sources
                </button>
              </div>
            ) : visible.length === 0 ? (
              streamFailed ? (
                <div className="log-placeholder log-empty-state">
                  <AlertCircle size={20} aria-hidden="true" />
                  <p>No logs are loading. {connection}</p>
                  <button className="link-button" onClick={() => setStreamAttempt((n) => n + 1)}>
                    <RefreshCw size={14} /> Try again
                  </button>
                </div>
              ) : (
                <div className="log-placeholder">
                  <Terminal size={20} aria-hidden="true" />{' '}
                  {paused
                    ? 'Stream paused before the first snapshot. Resume the stream to load logs.'
                    : 'Connecting to the log stream…'}
                </div>
              )
            ) : (
              visible.map((source) => {
                const errorCount = source.available ? source.lines.filter(isErrorLine).length : 0;
                return (
                  <div className="log-group" key={source.id}>
                    <div className="log-source">
                      <FileText size={13} aria-hidden="true" />
                      <strong>{source.label}</strong>
                      <span
                        className={source.available ? 'source-available' : 'source-unavailable'}
                      >
                        {source.available ? 'Log available' : 'Log unavailable'}
                      </span>
                      {errorCount > 0 && (
                        <span className="source-errors">
                          {errorCount} error {errorCount === 1 ? 'line' : 'lines'}
                        </span>
                      )}
                    </div>
                    {source.file && <div className="log-path">{source.file}</div>}
                    {source.available && !source.file && (
                      <p className="log-muted">
                        Kept in memory by this studio process (last 100 lines). Cleared when the
                        studio restarts.
                      </p>
                    )}
                    {source.modified && (
                      <p className="log-modified">
                        File modified on server{' '}
                        <time
                          dateTime={source.modified}
                          title={new Date(source.modified).toLocaleString()}
                        >
                          {formatRelative(source.modified, now)}
                        </time>
                      </p>
                    )}
                    {source.available ? (
                      source.lines.length ? (
                        source.lines.map((line, i) => (
                          <pre
                            key={i}
                            className={
                              isErrorLine(line) ? 'log-error' : isWarnLine(line) ? 'log-warn' : ''
                            }
                          >
                            {line}
                          </pre>
                        ))
                      ) : (
                        <p className="log-muted">No matching log lines.</p>
                      )
                    ) : (
                      <p className="log-unavailable">
                        Log source unavailable: {source.unavailable}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="log-bottom">
            <span>
              Log lines retain their original timestamps; file modified times are server-reported
              metadata. Recent lines refresh every 2 seconds. Known credential patterns are
              redacted; review logs before sharing.
            </span>
            <button type="button" className="log-jump" onClick={jumpToLatest}>
              <ArrowDown size={14} aria-hidden="true" /> Jump to latest
            </button>
            {copyMessage && (
              <strong role="status">
                <Check size={14} /> {copyMessage}
              </strong>
            )}
          </div>
        </section>
      </div>
      <StudioLogView />
      <ErrorPipelineTest onOpenErrors={() => updateSearch(setParams, { dialog: 'errors' })} />
    </div>
  );
}
