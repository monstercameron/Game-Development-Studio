import { useEffect, useRef, useState } from 'react';
import { Bug, Cpu, ListOrdered, Monitor, Search, Server, X } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { STATUS_LABELS, formatErrorsMarkdown, sourceLabel } from '../runtime/error-format.js';
import ErrorDetail from './ErrorDetail';
import { createLog } from './app-log.js';
import { ERRORS_CHANGED_EVENT } from './error-capture.js';
import { copyToClipboard } from './error-copy.js';
import { getErrors, postErrors } from './errors-api.js';
import useDialogFocus from './useDialogFocus';
import { updateSearch } from './useNav';
import './errors-dialog.css';

const log = createLog('errors');

const SOURCE_FILTERS = [
  ['', 'All sources'],
  ['browser', 'Browser'],
  ['queue', 'Render queue'],
  ['server', 'Studio server'],
  ['engine', 'Engines'],
];

// Unknown sources fall back to the generic bug icon.
function pickSourceIcon(source) {
  if (source === 'browser') {
    return Monitor;
  }
  if (source === 'queue') {
    return ListOrdered;
  }
  if (source === 'server') {
    return Server;
  }
  if (source.startsWith('engine:')) {
    return Cpu;
  }
  return Bug;
}

function SourceIcon({ source }) {
  const Icon = pickSourceIcon(source);
  return <Icon size={14} aria-hidden="true" />;
}

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) {
    return 'unknown time';
  }
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)} h ago`;
  }
  return `${Math.round(seconds / 86400)} d ago`;
}

function parseSelectedId(value) {
  return /^\d{1,12}$/.test(value || '') ? Number(value) : null;
}

// Returns the list button a navigation key moves to, or null when the key does not move focus.
function pickKeyboardTarget(key, buttons, index) {
  switch (key) {
    case 'ArrowDown':
      return buttons[Math.min(buttons.length - 1, index + 1)];
    case 'ArrowUp':
      return buttons[Math.max(0, index - 1)];
    case 'Home':
      return buttons[0];
    case 'End':
      return buttons.at(-1);
    default:
      return null;
  }
}

/**
 * Errors review dialog (route state ?dialog=errors&error=<id>). Lists captured errors on the
 * left and shows the selected one on the right.
 */
export default function ErrorsDialog({ onClose, onOpenSettings, onOpenJob }) {
  const [params, setParams] = useSearchParams();
  const selectedId = parseSelectedId(params.get('error'));
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [list, setList] = useState(null);
  const [listError, setListError] = useState('');
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState('');
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);
  // Request counter: a response is applied only when it belongs to the newest request.
  const latest = useRef(0);
  const listRef = useRef(null);
  const dialog = useDialogFocus({ onClose, initialFocus: '.errors-search input' });

  const select = (id) => updateSearch(setParams, { error: id }, { replace: true });

  useEffect(() => {
    log.info('errors.dialog.opened');
    postErrors('/opened')
      .then(() => window.dispatchEvent(new Event(ERRORS_CHANGED_EVENT)))
      .catch((reason) => {
        log.warn('errors.opened.failed', { errorClass: reason?.name });
        setListError(reason.message);
      });
    return () => log.info('errors.dialog.closed');
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const request = ++latest.current;
    const controller = new AbortController();
    const search = new URLSearchParams();
    if (status) {
      search.set('status', status);
    }
    if (source) {
      search.set('source', source);
    }
    if (debouncedQuery) {
      search.set('q', debouncedQuery);
    }
    getErrors(`?${search}`, { signal: controller.signal })
      .then((data) => {
        if (request === latest.current) {
          setList(data);
          setListError('');
        }
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError' && request === latest.current) {
          log.warn('errors.list.load.failed', { errorClass: reason?.name });
          setListError(reason.message);
        }
      });
    return () => controller.abort();
  }, [status, source, debouncedQuery, reload]);

  function handleChanged(updated) {
    setList((current) =>
      current
        ? {
            ...current,
            errors: current.errors.map((item) =>
              item.id === updated.id
                ? { ...item, status: updated.status, issueUrl: updated.issueUrl }
                : item,
            ),
          }
        : current,
    );
  }

  function handleListKeyDown(event) {
    const buttons = [...(listRef.current?.querySelectorAll('.errors-item') || [])];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) {
      return;
    }
    const target = pickKeyboardTarget(event.key, buttons, index);
    if (target) {
      event.preventDefault();
      target.focus();
      select(Number(target.dataset.errorId));
    }
  }

  async function handleCopyAllNew() {
    try {
      const data = await getErrors('/export?status=new');
      setMessage(
        data.errors.length
          ? await copyToClipboard(
              formatErrorsMarkdown(data.errors),
              `${data.errors.length} new errors`,
            )
          : 'There are no new errors to copy.',
      );
    } catch (reason) {
      log.warn('errors.export.failed', { errorClass: reason?.name, errorCode: reason?.code });
      setMessage(reason.message);
    }
  }

  async function handleClearResolved() {
    try {
      const data = await postErrors('/clear', { statuses: ['resolved'], confirm: 'clear' });
      log.info('errors.clear.completed', { removedCount: data.removed });
      setIsConfirmingClear(false);
      setMessage(`${data.removed} resolved error${data.removed === 1 ? '' : 's'} cleared.`);
      if (
        selectedId &&
        list?.errors.some((item) => item.id === selectedId && item.status === 'resolved')
      ) {
        select(null);
      }
      setReload((value) => value + 1);
    } catch (reason) {
      log.warn('errors.clear.failed', { errorClass: reason?.name, errorCode: reason?.code });
      setMessage(reason.message);
    }
  }

  const errors = list?.errors || [];
  const resolvedCount = list?.summary?.counts?.resolved || 0;
  const isFiltered = !!(status || source || debouncedQuery);
  return (
    <div className="modal-backdrop errors-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className={'errors-modal' + (selectedId ? ' has-selection' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="errors-dialog-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="errors-head">
          <div>
            <span className="mini-label">ERROR REVIEW</span>
            <h2 id="errors-dialog-title">Errors</h2>
            <p>
              Errors from this browser, the render queue, the studio server and engine logs. Local
              paths, user names, keys and emails are redacted.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close error review"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="errors-toolbar">
          <label className="errors-search">
            <Search size={14} aria-hidden="true" />
            <span className="sr-only">Search errors</span>
            <input
              type="search"
              placeholder="Search messages and stacks"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by source</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              {SOURCE_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="outline-button" onClick={handleCopyAllNew}>
            Copy all new
          </button>
          {isConfirmingClear ? (
            <span className="errors-confirm" role="group" aria-label="Confirm clearing">
              <button
                type="button"
                className="outline-button errors-danger"
                onClick={handleClearResolved}
              >
                Delete {resolvedCount} resolved
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setIsConfirmingClear(false)}
              >
                Keep them
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="ghost-button"
              disabled={!resolvedCount}
              onClick={() => setIsConfirmingClear(true)}
            >
              Clear resolved
            </button>
          )}
        </div>
        <p className="errors-live" role="status" aria-live="polite">
          {message}
        </p>
        <div className="errors-body">
          <div className="errors-list-pane">
            {listError && (
              <p className="settings-error" role="alert">
                Could not load errors: {listError}
              </p>
            )}
            {!list && !listError && (
              <p className="errors-hint" role="status">
                Loading errors…
              </p>
            )}
            {list && !errors.length && (
              <div className="errors-empty">
                <strong>
                  {isFiltered ? 'No errors match these filters.' : 'No errors recorded.'}
                </strong>
                <p>
                  {isFiltered
                    ? 'Change the search or filters to see more.'
                    : 'Errors shown in the studio, failed renders and engine tracebacks will appear here.'}
                </p>
              </div>
            )}
            {errors.length > 0 && (
              <ul
                ref={listRef}
                className="errors-list"
                aria-label={`Errors, newest first. ${list.total} shown.`}
                onKeyDown={handleListKeyDown}
              >
                {errors.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="errors-item"
                      data-error-id={item.id}
                      aria-current={item.id === selectedId ? 'true' : undefined}
                      onClick={() => select(item.id)}
                    >
                      <span className="errors-item-source">
                        <SourceIcon source={item.source} /> {sourceLabel(item.source)}
                      </span>
                      <span className="errors-item-message">{item.message}</span>
                      <span className="errors-item-meta">
                        <span className={`errors-chip status-${item.status}`}>
                          {STATUS_LABELS[item.status]}
                        </span>
                        <span>×{item.count}</span>
                        <span>{relativeTime(item.lastSeen)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {list?.scanProblems?.length > 0 && (
              <p className="errors-hint">
                Some sources could not be read: {list.scanProblems.join('; ')}.
              </p>
            )}
          </div>
          <div className="errors-detail-pane">
            {selectedId ? (
              <ErrorDetail
                key={selectedId}
                errorId={selectedId}
                onChanged={handleChanged}
                onBack={() => select(null)}
                onOpenSettings={onOpenSettings}
                onOpenJob={onOpenJob}
              />
            ) : (
              <p className="errors-hint errors-placeholder">Choose an error to review it.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
