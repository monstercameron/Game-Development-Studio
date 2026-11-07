import { useSearchParams } from 'react-router';
import { updateSearch } from './useNav';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
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
import { filterLogLines } from './diagnostics-filter.js';
import './diagnostics-page.css';

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
  const [copyMessage, setCopyMessage] = useState('');
  const errorsOnly = params.get('errors') === '1';
  const setErrorsOnly = (value) => updateSearch(setParams, { errors: value ? '1' : null });
  async function refreshMetadata() {
    try {
      const res = await fetch('/api/diagnostics');
      if (!res.ok) {
        throw Error('Diagnostics unavailable.');
      }
      setMetadata(await res.json());
      setMetadataError('');
    } catch {
      setMetadata(null);
      setMetadataError(
        'Could not reach the diagnostics service. Refresh server details; if the problem continues, restart the studio.',
      );
    }
  }
  useEffect(() => {
    refreshMetadata();
    const timer = setInterval(refreshMetadata, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (paused) {
      setConnection('Paused');
      return;
    }
    setConnection('Connecting');
    const stream = new EventSource('/api/logs/stream');
    stream.onopen = () => setConnection('Live');
    stream.addEventListener('logs', (event) => {
      try {
        setSources(JSON.parse(event.data).sources);
        setConnection('Live');
      } catch {
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
      } catch {
        detail = event.data || detail;
      }
      setConnection(`Log read failed: ${detail}`);
    };
    return () => stream.close();
  }, [paused]);
  useEffect(() => {
    if (copyMessage) {
      const t = setTimeout(() => setCopyMessage(''), 3000);
      return () => clearTimeout(t);
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
  function formatLogSources(logSources, { filtered = false } = {}) {
    return logSources
      .map((source) => {
        const lines = filtered ? filterLogLines(source.lines, { errorsOnly, query }) : source.lines;
        return `[${source.label}]${source.file ? `\n${source.file}` : ''}\n${source.available ? lines.join('\n') || '(No matching log lines)' : source.unavailable || 'Unavailable'}`;
      })
      .join('\n\n');
  }
  async function copy(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label} copied.`);
    } catch {
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
            <span className="mini-label">ENGINE ADDRESSES</span>
            <span>PORT STATUS</span>
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
              aria-pressed={paused}
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
                onClick={() => copy(formatLogSources(visible, { filtered: true }), 'Visible logs')}
              >
                <Copy size={14} /> Copy filtered lines
              </button>
              <button
                className="link-button"
                onClick={() =>
                  copy(
                    formatLogSources(
                      sources.filter((source) => selected === 'all' || source.id === selected),
                    ),
                    'Unfiltered logs',
                  )
                }
              >
                <Copy size={14} /> Copy unfiltered logs
              </button>
            </div>
          </div>
          <div
            className="log-window"
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
              <div className="log-placeholder">
                <Terminal size={20} /> Waiting for logs…
              </div>
            ) : (
              visible.map((source) => (
                <div className="log-group" key={source.id}>
                  <div className="log-source">
                    <FileText size={13} />
                    <strong>{source.label}</strong>
                    <span className={source.available ? 'source-available' : 'source-unavailable'}>
                      {source.available ? 'Log available' : 'Log unavailable'}
                    </span>
                  </div>
                  {source.file && <div className="log-path">{source.file}</div>}
                  {source.modified && (
                    <p className="log-modified">
                      File modified on server{' '}
                      <time dateTime={source.modified}>{source.modified}</time>
                    </p>
                  )}
                  {source.available ? (
                    source.lines.length ? (
                      source.lines.map((line, i) => (
                        <pre
                          key={i}
                          className={
                            /error|exception|traceback|failed|failure|fatal/i.test(line)
                              ? 'log-error'
                              : ''
                          }
                        >
                          {line}
                        </pre>
                      ))
                    ) : (
                      <p className="log-muted">No matching log lines.</p>
                    )
                  ) : (
                    <p className="log-unavailable">Log source unavailable: {source.unavailable}</p>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="log-bottom">
            <span>
              Log lines retain their original timestamps; file modified times are server-reported
              metadata. Recent lines refresh every 2 seconds. Known credential patterns are
              redacted; review logs before sharing.
            </span>
            {copyMessage && (
              <strong role="status">
                <Check size={14} /> {copyMessage}
              </strong>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
