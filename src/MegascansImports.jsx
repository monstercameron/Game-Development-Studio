import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw, Upload, X } from 'lucide-react';
import { DownloadConsent } from './MegascansFab';
import { createLog } from './app-log.js';
import {
  ACTIVE_STATUSES,
  MAX_CONCURRENT_IMPORTS,
  UPLOAD_ACCEPT,
  describeSpeed,
  formatBytes,
  getMegascans,
  percentDone,
  postMegascans,
  requestFailureFields,
  statusLabel,
} from './megascans-api';

const FAST_POLL_MS = 1200;
const SLOW_POLL_MS = 10000;
const log = createLog('megascans');

/** Polls the import queue: quickly while something is active, slowly otherwise. */
export function useImportQueue() {
  const [state, setState] = useState({ imports: [], summary: null, error: '', loaded: false });
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const hasActive = state.imports.some((item) => ACTIVE_STATUSES.includes(item.status));

  const hasLoggedFailure = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await getMegascans('/imports', { signal: controller.signal });
        hasLoggedFailure.current = false;
        setState({ imports: data.imports, summary: data.summary, error: '', loaded: true });
      } catch (error) {
        if (error?.name !== 'AbortError') {
          if (!hasLoggedFailure.current) {
            hasLoggedFailure.current = true;
            log.warn('megascans.imports.load.failed', requestFailureFields(error));
          }
          setState((current) => ({ ...current, error: error.message, loaded: true }));
        }
      }
    };
    load();
    log.debug('megascans.imports.poll.started', { isFastPoll: hasActive });
    const timer = setInterval(load, hasActive ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [hasActive, reload]);

  return { ...state, refresh };
}

function ImportRow({ item, projectName, onAction, busy, onOpenLibrary }) {
  const percent = percentDone(item);
  const active = ACTIVE_STATUSES.includes(item.status);
  const canRetry = ['failed', 'interrupted', 'cancelled'].includes(item.status);
  const speed = describeSpeed(item);
  return (
    <li className={`megascans-import megascans-import-${item.status}`}>
      <div className="megascans-import-head">
        <strong className="megascans-import-name">{item.filename}</strong>
        <span className={`megascans-status megascans-status-${item.status}`}>
          {item.status === 'running' && (
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
          )}
          {statusLabel(item.status)}
        </span>
      </div>
      <p className="megascans-import-meta">
        {item.source === 'fab' ? 'Downloaded from Fab · ' : 'Imported file · '}
        {projectName ? `Project: ${projectName} · ` : ''}
        {formatBytes(item.uploadBytes)}
        {item.stage && item.status === 'running' ? ` · ${item.stage}` : ''}
      </p>
      {item.status === 'running' && (
        <>
          <div
            className="megascans-progress"
            role="progressbar"
            aria-label={`${item.source === 'fab' ? 'Download' : 'Import'} progress for ${item.filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-valuetext={percent === null ? 'Starting' : `${percent} percent`}
          >
            <span style={{ width: `${percent ?? 8}%` }} />
          </div>
          <p className="megascans-import-meta">
            {percent === null
              ? 'Checking the file…'
              : `${percent}% of ${formatBytes(item.bytesTotal)}`}
            {speed ? ` · ${speed}` : ''}
          </p>
        </>
      )}
      {item.error && (
        <p className="megascans-import-error" role="alert">
          {item.error}
        </p>
      )}
      {item.status === 'completed' && item.output && (
        <p className="megascans-import-meta">
          Saved{' '}
          {item.output.files.length === 1 ? 'one model' : `${item.output.files.length} models`} to{' '}
          <code>{item.output.folder || item.output.files[0]}</code>
          {item.output.skipped ? ` · ${item.output.skipped} unsupported file(s) skipped` : ''}
        </p>
      )}
      <div className="megascans-import-actions">
        {active && (
          <button
            type="button"
            className="outline-button"
            disabled={busy || item.cancelRequested}
            onClick={() => onAction(item, 'cancel')}
          >
            <X size={14} aria-hidden="true" /> {item.cancelRequested ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {canRetry && (
          <button
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={() => onAction(item, 'retry')}
          >
            <RotateCcw size={14} aria-hidden="true" /> Retry
          </button>
        )}
        {item.status === 'completed' && (
          <button type="button" className="outline-button" onClick={onOpenLibrary}>
            Open Asset library
          </button>
        )}
        {!active && (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => onAction(item, 'dismiss')}
          >
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}

export function ImportsPanel({
  queue,
  uploads,
  projects,
  project,
  onChooseFile,
  onDropFile,
  onCancelUpload,
  onDismissUpload,
  onOpenLibrary,
  consent,
}) {
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');
  const [dragging, setDragging] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { imports, summary, error, loaded, refresh } = queue;
  const names = Object.fromEntries((projects || []).map((item) => [item.id, item.name]));

  async function act(item, action) {
    setBusyId(item.id);
    setActionError('');
    try {
      await postMegascans(`/imports/${item.id}/${action}`);
      log.info('megascans.import.action.completed', { action });
      refresh();
    } catch (failure) {
      log.warn('megascans.import.action.failed', { action, ...requestFailureFields(failure) });
      if (alive.current) {
        setActionError(failure.message);
      }
    } finally {
      if (alive.current) {
        setBusyId('');
      }
    }
  }

  return (
    <section
      className={`panel megascans-imports${dragging ? ' megascans-dragging' : ''}`}
      aria-labelledby="megascans-imports-title"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) {
          onDropFile(file);
        }
      }}
    >
      <div className="panel-heading">
        <div>
          <span className="mini-label">DOWNLOAD AND IMPORT QUEUE</span>
          <h2 id="megascans-imports-title">Downloads</h2>
        </div>
        <button
          type="button"
          className="primary"
          disabled={!project}
          onClick={() => onChooseFile(null)}
        >
          <Upload size={16} aria-hidden="true" /> Import file
        </button>
      </div>
      <p className="helper">
        {project
          ? `Choose, or drop here, the ZIP or 3D model you downloaded from Fab. It is saved to ${project.name}.`
          : 'Choose a project above before importing a file.'}{' '}
        Accepted: {UPLOAD_ACCEPT.replaceAll(',', ', ')}. At most {MAX_CONCURRENT_IMPORTS} downloads
        or imports run at the same time; the rest wait.
      </p>
      {consent && <DownloadConsent {...consent} />}
      {summary && (
        <p className="megascans-queue-summary" role="status">
          Running {summary.running} of {summary.maxConcurrent} · {summary.queued} waiting ·{' '}
          {summary.failed} need attention · {summary.completed} completed
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          Could not read the import queue: {error}{' '}
          <button type="button" className="link-button" onClick={refresh}>
            Try again
          </button>
        </p>
      )}
      {actionError && (
        <p className="settings-error" role="alert">
          {actionError}
        </p>
      )}
      <ul className="megascans-import-list" aria-label="Downloads and imports">
        {uploads.map((upload) => {
          const percent = upload.total ? Math.floor((upload.loaded / upload.total) * 100) : null;
          return (
            <li key={upload.key} className="megascans-import megascans-import-uploading">
              <div className="megascans-import-head">
                <strong className="megascans-import-name">{upload.name}</strong>
                <span className="megascans-status megascans-status-running">
                  {upload.error ? 'Not uploaded' : 'Uploading'}
                </span>
              </div>
              {upload.error ? (
                <p className="megascans-import-error" role="alert">
                  {upload.error}
                </p>
              ) : (
                <div
                  className="megascans-progress"
                  role="progressbar"
                  aria-label={`Upload progress for ${upload.name}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent ?? undefined}
                >
                  <span style={{ width: `${percent ?? 8}%` }} />
                </div>
              )}
              <div className="megascans-import-actions">
                {upload.error ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => onDismissUpload(upload)}
                  >
                    Dismiss
                  </button>
                ) : (
                  <button
                    type="button"
                    className="outline-button"
                    onClick={() => onCancelUpload(upload)}
                  >
                    <X size={14} aria-hidden="true" /> Cancel
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {imports.map((item) => (
          <ImportRow
            key={item.id}
            item={item}
            projectName={names[item.projectId]}
            busy={busyId === item.id}
            onAction={act}
            onOpenLibrary={onOpenLibrary}
          />
        ))}
      </ul>
      {loaded && !error && imports.length === 0 && uploads.length === 0 && (
        <p className="megascans-empty">
          No imports yet. After you download a model from Fab, import it here and it appears in the
          project&apos;s 3D assets.
        </p>
      )}
    </section>
  );
}
