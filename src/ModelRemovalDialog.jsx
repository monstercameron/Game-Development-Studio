import { useEffect, useId, useState } from 'react';
import { LoaderCircle, Power, ShieldCheck, Trash2, X } from 'lucide-react';
import { createLog } from './app-log.js';
import useDialogFocus from './useDialogFocus';
import './model-removal-dialog.css';

const log = createLog('model');

// Milliseconds between onRefresh calls while a removal is in progress.
const REMOVAL_POLL_INTERVAL_MS = 1200;

// Byte counts use binary units. null means the size was never measured, not zero.
const formatSize = (value) =>
  value === null || value === undefined
    ? 'Not measured'
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(1)} GiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;

async function post(path, body = {}) {
  // log-coverage: ignore -- failed /api calls are already logged by app-log-install (http.request.failed)
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || result.message || 'Request failed.');
  }
  return result;
}

// Explains the removal state. Conditions are checked in priority order, so the first
// match wins; a managed model that is still scanning must not be told to stop its service.
function getRemovalExplanation({ managed, storage, inProgress, inventoryState, failed, stopped }) {
  if (!managed) {
    return 'This model is stored in another application or has not been installed. Manage those files in their original location.';
  }
  if (storage.removable === false) {
    return 'Forge does not remove this model’s files. Other apps or preview pipelines may depend on them, so manage them in their original location.';
  }
  if (inProgress) {
    return 'Removing the model files. You can close this dialog while cleanup continues.';
  }
  if (inventoryState === 'scanning') {
    return 'Checking model storage. Removal will be available when the scan finishes.';
  }
  if (storage.installed === false) {
    return 'This model folder is not currently installed.';
  }
  if (storage.installed !== true && !failed) {
    return 'The installation state could not be confirmed. Refresh model storage before removing files.';
  }
  if (!stopped) {
    return 'Stop the model service before removing its files.';
  }
  if (failed) {
    return 'The previous removal did not finish. Retry cleanup after resolving the error.';
  }
  return 'This permanently deletes the model files. It does not delete project assets. You will need to reinstall the model to use it again.';
}

export default function ModelRemovalDialog({
  model,
  id,
  storage,
  service,
  removal,
  inventoryState,
  onClose,
  onRefresh,
}) {
  const titleId = useId();
  const [busyAction, setBusyAction] = useState('');
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const busy = Boolean(busyAction);
  const inProgress = ['prepared', 'deleting'].includes(removal?.state);
  const failed = removal?.state === 'failed';
  const managed = Boolean(storage);
  const stopped = service?.status === 'unavailable' && !service?.managed;
  const canRemove =
    managed &&
    storage.removable !== false &&
    !inProgress &&
    inventoryState !== 'scanning' &&
    stopped &&
    (failed || storage.installed === true);
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busy) {
        dismiss();
      }
    },
    initialFocus: '.settings-head button',
  });
  useEffect(() => {
    if (!inProgress) {
      return;
    }
    log.debug('model.removal.polling.started');
    const timer = setInterval(() => onRefresh(), REMOVAL_POLL_INTERVAL_MS);
    return () => {
      log.debug('model.removal.polling.stopped');
      clearInterval(timer);
    };
  }, [inProgress, onRefresh]);
  function dismiss() {
    log.debug('model.removal.dismissed', { modelId: id });
    onClose();
  }
  // The server checks the confirmation phrase itself; the checkbox only prevents a stray click.
  async function handleRemove() {
    log.info('model.removal.confirmed', { modelId: id, isRetry: failed });
    setBusyAction('remove');
    setError('');
    try {
      await post(`/api/runtime/models/${id}/remove`, {
        confirmation: 'permanently-delete-model',
        retry: failed,
      });
      log.info('model.removal.accepted', { modelId: id });
      await onRefresh();
    } catch (reason) {
      log.warn('model.removal.failed', { modelId: id, errorClass: reason?.name });
      setError(reason.message);
    } finally {
      setBusyAction('');
    }
  }
  async function handleStop() {
    log.info('model.offload.requested', { modelId: id });
    setBusyAction('stop');
    setError('');
    try {
      await post(`/api/runtime/models/${id}/offload`);
      log.info('model.offload.completed', { modelId: id });
      await onRefresh();
    } catch (reason) {
      log.warn('model.offload.failed', { modelId: id, errorClass: reason?.name });
      setError(reason.message);
    } finally {
      setBusyAction('');
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) {
          dismiss();
        }
      }}
    >
      <section
        ref={dialog}
        className="settings-modal model-remove-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || inProgress}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">MODEL STORAGE</span>
            <h2 id={titleId}>Remove model files</h2>
            <p>
              Remove this model’s managed files. Disk space recovered may be less than the measured
              size when files are also used elsewhere, such as through hard links.
            </p>
          </div>
          <button className="icon-btn" aria-label="Close" disabled={busy} onClick={dismiss}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="model-remove-summary">
          <div className={'tool-icon ' + model.tone}>
            <model.icon size={19} />
          </div>
          <div>
            <strong>{model.name}</strong>
            <span>{model.category}</span>
          </div>
        </div>
        <dl className="model-remove-details">
          <div>
            <dt>Location</dt>
            <dd>{storage?.path || 'Outside Forge-managed storage'}</dd>
          </div>
          <div>
            <dt>Measured file size</dt>
            <dd>{storage?.installed ? formatSize(storage.bytes) : 'Not available'}</dd>
          </div>
        </dl>
        <div className="model-preview-explanation">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>
            {getRemovalExplanation({
              managed,
              storage,
              inProgress,
              inventoryState,
              failed,
              stopped,
            })}
          </p>
        </div>
        {(error || removal?.error) && (
          <p className="settings-error" role="alert">
            {error || removal.error}
          </p>
        )}
        {canRemove && !inProgress && (
          <label className="model-remove-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand these model files will be permanently deleted and cannot be restored from
              Forge.
            </span>
          </label>
        )}
        <div className="project-dialog-actions">
          <button className="ghost-button" disabled={busy} onClick={dismiss}>
            Close
          </button>
          {managed && !stopped && !inProgress && service?.canUnload && (
            <button className="icon-outline" disabled={busy} onClick={handleStop}>
              <Power size={14} aria-hidden="true" />{' '}
              {busyAction === 'stop' ? 'Stopping service…' : 'Stop service'}
            </button>
          )}
          <button
            className="danger-solid"
            disabled={busy || !canRemove || (!inProgress && !acknowledged)}
            title={canRemove && !acknowledged ? 'Tick the confirmation box first.' : undefined}
            onClick={handleRemove}
          >
            {busyAction === 'remove' || inProgress ? (
              <LoaderCircle size={15} className="motion-spinner" aria-hidden="true" />
            ) : (
              <Trash2 size={15} aria-hidden="true" />
            )}{' '}
            {busyAction === 'remove'
              ? 'Starting removal…'
              : inProgress
                ? 'Removing…'
                : failed
                  ? 'Retry removal'
                  : 'Permanently delete model'}
          </button>
        </div>
        {(busy || inProgress) && (
          <p className="model-remove-status" role="status" aria-live="polite" aria-atomic="true">
            {busyAction === 'remove'
              ? 'Starting model removal.'
              : busyAction === 'stop'
                ? 'Stopping the model service.'
                : 'Removing model files. Cleanup continues in the background.'}
          </p>
        )}
      </section>
    </div>
  );
}
