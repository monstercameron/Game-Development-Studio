import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import {
  FIX_SOURCE_LABELS,
  STATUS_LABELS,
  formatErrorMarkdown,
  formatErrorText,
  formatFixPrompt,
  formatStackOnly,
  sourceLabel,
} from '../runtime/error-format.js';
import { createLog } from './app-log.js';
import ErrorFixPanel from './ErrorFixPanel';
import ErrorIssuePanel from './ErrorIssuePanel';
import { copyToClipboard } from './error-copy.js';
import { getErrors, postErrors } from './errors-api.js';

const log = createLog('errors');

// Engine errors are recorded with the source "engine:<engineId>".
const ENGINE_SOURCE_PREFIX = 'engine:';

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

/** Right-hand detail of the Errors review: redacted text, copy actions, status and note. */
export default function ErrorDetail({ errorId, onChanged, onBack, onOpenSettings, onOpenJob }) {
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [includePaths, setIncludePaths] = useState(false);
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [fixNote, setFixNote] = useState('');
  const [fixSource, setFixSource] = useState('self');
  const [actionError, setActionError] = useState('');
  const latestRequest = useRef(0);
  // Read through a ref so the load effect does not re-run when the parent passes a new callback.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    const request = ++latestRequest.current;
    const controller = new AbortController();
    setLoadError('');
    getErrors(`/${errorId}${includePaths ? '?includePaths=1' : ''}`, { signal: controller.signal })
      .then(async (response) => {
        if (request !== latestRequest.current) {
          return;
        }
        setError(response.error);
        setNote(response.error.note);
        if (response.error.status === 'new' && !includePaths) {
          const viewed = await postErrors(`/${errorId}/viewed`);
          if (request === latestRequest.current) {
            log.debug('errors.status.viewed', { errorId, from: 'new', to: viewed.error.status });
            setError(viewed.error);
            onChangedRef.current?.(viewed.error);
          }
        }
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError' && request === latestRequest.current) {
          log.warn('errors.detail.load.failed', { errorId, errorClass: reason?.name });
          setLoadError(reason.message);
        }
      });
    return () => controller.abort();
  }, [errorId, includePaths]);

  useEffect(() => {
    setIsVerifying(false);
    setActionError('');
    setStatus('');
  }, [errorId]);

  function applyUpdate(updated) {
    // Mutations return display text without local paths; keep the opt-in view consistent.
    if (includePaths) {
      setIncludePaths(false);
    }
    setError(updated);
    onChanged?.(updated);
  }

  async function changeStatus(next, extra = {}) {
    setActionError('');
    try {
      const response = await postErrors(`/${errorId}/status`, { status: next, ...extra });
      log.info('errors.status.changed', { errorId, from: error.status, to: next });
      applyUpdate(response.error);
      setIsVerifying(false);
      setStatus(`Marked ${STATUS_LABELS[next].toLowerCase()}.`);
    } catch (reason) {
      log.warn('errors.status.failed', {
        errorId,
        to: next,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      setActionError(reason.message);
    }
  }

  async function saveNote() {
    setActionError('');
    try {
      const response = await postErrors(`/${errorId}/note`, { note });
      applyUpdate(response.error);
      log.info('errors.note.saved', { errorId });
      setStatus('Note saved.');
    } catch (reason) {
      log.warn('errors.note.save.failed', {
        errorId,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      setActionError(reason.message);
    }
  }

  async function copy(text, label) {
    setStatus(await copyToClipboard(text, label, { includePaths }));
  }

  if (loadError) {
    return (
      <div className="errors-detail">
        <p className="settings-error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (!error) {
    return (
      <div className="errors-detail">
        <p className="errors-hint" role="status">
          Loading error…
        </p>
      </div>
    );
  }
  const engineId = error.source.startsWith(ENGINE_SOURCE_PREFIX)
    ? error.source.slice(ENGINE_SOURCE_PREFIX.length)
    : null;
  const stackLines = (error.stack || '').split('\n');
  return (
    <article className="errors-detail" aria-labelledby="error-detail-title">
      <button type="button" className="ghost-button errors-back" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" /> Back to list
      </button>
      <h3 id="error-detail-title" className="errors-detail-title">
        {error.message.split('\n')[0]}
      </h3>
      <div className="errors-chips">
        <span className="errors-chip">{sourceLabel(error.source)}</span>
        <span className={`errors-chip status-${error.status}`}>{STATUS_LABELS[error.status]}</span>
        <span className="errors-chip">
          {error.count} occurrence{error.count === 1 ? '' : 's'}
        </span>
      </div>
      <dl className="errors-facts">
        {error.page && (
          <>
            <dt>Page</dt>
            <dd>{error.page}</dd>
          </>
        )}
        {error.jobId && (
          <>
            <dt>Job</dt>
            <dd>
              <button
                type="button"
                className="errors-link-button"
                onClick={() => onOpenJob(error.jobId)}
              >
                Open in render queue
              </button>{' '}
              <code>{error.jobId}</code>
              {error.context.jobType ? ` · ${error.context.jobType}` : ''}
              {error.context.jobStatus ? ` · ${error.context.jobStatus}` : ''}
            </dd>
          </>
        )}
        {engineId && (
          <>
            <dt>Engine</dt>
            <dd>{engineId}</dd>
          </>
        )}
        {error.context.log && (
          <>
            <dt>Log</dt>
            <dd>{error.context.log}</dd>
          </>
        )}
        {error.context.path && (
          <>
            <dt>Request</dt>
            <dd>
              {error.context.method || 'GET'} {error.context.path} ·{' '}
              {error.context.status ? `HTTP ${error.context.status}` : 'network error'}
            </dd>
          </>
        )}
        <dt>First seen</dt>
        <dd>{formatTime(error.firstSeen)}</dd>
        <dt>Last seen</dt>
        <dd>{formatTime(error.lastSeen)}</dd>
        {error.status === 'verified' && (
          <>
            <dt>Fix</dt>
            <dd>
              {FIX_SOURCE_LABELS[error.fixSource] || 'Fix confirmed'}
              {error.fixNote ? `: ${error.fixNote}` : ''}
            </dd>
          </>
        )}
      </dl>
      {error.message.includes('\n') && (
        <pre className="errors-code" tabIndex={0} aria-label="Full message">
          {error.message}
        </pre>
      )}
      <h4>Stack trace</h4>
      {error.stack ? (
        <pre className="errors-stack" tabIndex={0} aria-label="Stack trace with line numbers">
          {stackLines.map((line, index) => (
            <span key={index} className="errors-stack-line">
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <p className="errors-hint">No stack trace was captured for this error.</p>
      )}
      <label className="setting-check errors-paths-toggle">
        <input
          type="checkbox"
          checked={includePaths}
          onChange={(event) => setIncludePaths(event.target.checked)}
        />
        <span>
          Include local paths in this view and in copies (off by default; paths can contain your
          user name)
        </span>
      </label>
      <div className="errors-actions" role="group" aria-label="Copy">
        <button
          type="button"
          className="outline-button"
          onClick={() => copy(formatErrorText(error), 'Error')}
        >
          Copy error
        </button>
        <button
          type="button"
          className="outline-button"
          onClick={() => copy(formatErrorMarkdown(error), 'Markdown')}
        >
          Copy as markdown (for an issue/chat)
        </button>
        <button
          type="button"
          className="outline-button"
          onClick={() => copy(formatStackOnly(error), 'Stack')}
        >
          Copy stack only
        </button>
        <button
          type="button"
          className="outline-button"
          onClick={() => copy(formatFixPrompt(error), 'Fix prompt')}
        >
          Copy fix prompt
        </button>
      </div>
      <div className="errors-actions" role="group" aria-label="Status">
        {['new', 'reviewed'].includes(error.status) ? (
          <>
            <button
              type="button"
              className="outline-button"
              onClick={() => changeStatus('resolved')}
            >
              Mark resolved
            </button>
            <button type="button" className="ghost-button" onClick={() => changeStatus('ignored')}>
              Mark ignored
            </button>
          </>
        ) : (
          <button type="button" className="ghost-button" onClick={() => changeStatus('new')}>
            Reopen
          </button>
        )}
        {error.status !== 'verified' && (
          <button
            type="button"
            className="outline-button"
            aria-expanded={isVerifying}
            onClick={() => setIsVerifying((value) => !value)}
          >
            Fix worked
          </button>
        )}
      </div>
      {isVerifying && (
        <form
          className="errors-verify"
          onSubmit={(event) => {
            event.preventDefault();
            changeStatus('verified', { fixNote, fixSource });
          }}
        >
          <fieldset>
            <legend>Who fixed it?</legend>
            {Object.entries(FIX_SOURCE_LABELS).map(([value, label]) => (
              <label key={value} className="setting-check">
                <input
                  type="radio"
                  name={`fix-source-${error.id}`}
                  value={value}
                  checked={fixSource === value}
                  onChange={() => setFixSource(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label htmlFor={`fix-note-${error.id}`}>What fixed it (optional)</label>
          <textarea
            id={`fix-note-${error.id}`}
            rows={3}
            maxLength={4000}
            value={fixNote}
            onChange={(event) => setFixNote(event.target.value)}
          />
          <div className="errors-actions">
            <button type="submit" className="outline-button">
              Save as fixed (verified)
            </button>
            <button type="button" className="ghost-button" onClick={() => setIsVerifying(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <form
        className="errors-note"
        onSubmit={(event) => {
          event.preventDefault();
          saveNote();
        }}
      >
        <label htmlFor={`error-note-${error.id}`}>Your note</label>
        <textarea
          id={`error-note-${error.id}`}
          rows={2}
          maxLength={4000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button type="submit" className="ghost-button" disabled={note === error.note}>
          Save note
        </button>
      </form>
      {actionError && (
        <p className="settings-error" role="alert">
          {actionError}
        </p>
      )}
      <p className="errors-live" role="status" aria-live="polite">
        {status}
      </p>
      <ErrorFixPanel
        error={error}
        onUpdated={applyUpdate}
        onOpenSettings={onOpenSettings}
        onStatus={setStatus}
      />
      <ErrorIssuePanel error={error} onUpdated={applyUpdate} onStatus={setStatus} />
    </article>
  );
}
