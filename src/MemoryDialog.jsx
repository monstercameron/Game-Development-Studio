import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Power, RefreshCw, X } from 'lucide-react';
import useDialogFocus from './useDialogFocus';
import { createLog } from './app-log.js';
import './memory-dialog.css';

const log = createLog('memory');
const gib = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} GiB` : 'Unavailable');
const qwenFallback = () =>
  document.querySelector('.chat-config-heading button:not(:disabled)') ||
  document.querySelector('.chat-composer textarea:not(:disabled)') ||
  document.querySelector('.chat-model-selector:not(:disabled)');

export default function MemoryDialog({
  conflict,
  onClose,
  onRetry,
  working,
  target = 'YuE2',
  error = '',
}) {
  const [action, setAction] = useState(''),
    [actionError, setActionError] = useState(''),
    [notice, setNotice] = useState(''),
    [closed, setClosed] = useState([]),
    [forceTarget, setForceTarget] = useState(null);
  const forceTrigger = useRef(null),
    returnToForceTrigger = useRef(false),
    forceHeading = useRef(null);
  const busy = working || !!action;
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busy) {
        onClose();
      }
    },
    initialFocus: '.settings-head button',
    fallbackFocus: target === 'Qwen' ? qwenFallback : undefined,
  });
  const system = conflict.code === 'insufficient_host_memory';
  const free = system ? conflict.freeBytes / 1024 ** 3 : conflict.device?.freeMiB / 1024;
  const required = system ? conflict.requiredBytes / 1024 ** 3 : conflict.requiredMiB / 1024;
  const shortfall = system ? conflict.shortfallBytes / 1024 ** 3 : conflict.shortfallMiB / 1024;
  useLayoutEffect(() => {
    if (forceTarget) {
      forceHeading.current?.focus();
    } else if (returnToForceTrigger.current) {
      returnToForceTrigger.current = false;
      forceTrigger.current?.focus();
    }
  }, [forceTarget]);
  useEffect(() => {
    setClosed([]);
    setNotice('');
    setActionError('');
  }, [conflict]);
  async function closeService(model, force) {
    setAction(model.id);
    setActionError('');
    setNotice('');
    try {
      const response = await fetch(
        `/api/runtime/models/${model.id}/${force ? 'force-stop' : 'close'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
          body: JSON.stringify(force ? { confirmation: 'force-stop-engine' } : {}),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || result.message || 'Could not close the service.');
      }
      setClosed((items) => [...items, model.id]);
      log.info('memory.service.closed', {
        modelId: model.id,
        operation: force ? 'force-close' : 'close',
      });
      setNotice(
        `${model.name} service stopped. Check memory again when you are ready; available memory may take a moment to update.`,
      );
    } catch (e) {
      log.warn('memory.service.close.failed', {
        modelId: model.id,
        operation: force ? 'force-close' : 'close',
        error: e,
      });
      setActionError(e.message);
    } finally {
      setAction('');
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <section
        ref={dialog}
        className="settings-modal memory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">{system ? 'SYSTEM' : 'GPU'} MEMORY</span>
            <h2 id="memory-dialog-title">Make room for {target}</h2>
            <p>Available {system ? 'system' : 'GPU'} memory is below the configured requirement.</p>
          </div>
          <button
            className="icon-btn"
            aria-label="Close memory dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="memory-numbers" aria-label="Memory availability">
          <div>
            <span>Available now</span>
            <strong>{gib(conflict.freeBytes === null && system ? null : free)}</strong>
          </div>
          <div>
            <span>Required</span>
            <strong>{gib(required)}</strong>
          </div>
          <div>
            <span>Additional memory needed</span>
            <strong>{gib(conflict.shortfallBytes === null && system ? null : shortfall)}</strong>
          </div>
        </div>
        {conflict.estimate && <p className="helper">{conflict.estimate}</p>}
        <h3>Models and services</h3>
        <p className="helper">
          Stop an idle service to release its loaded model. Force close stops it immediately and
          interrupts active work. Model files stay on disk; memory availability can take a moment to
          update.
        </p>
        {conflict.candidates?.length ? (
          <div className="memory-candidates">
            {conflict.candidates.map((model) => (
              <div className="memory-candidate" key={model.id}>
                <div>
                  <strong>{model.name}</strong>
                  <small>
                    {closed.includes(model.id)
                      ? 'Closed'
                      : model.busy
                        ? 'Currently in use'
                        : model.id === 'video'
                          ? 'No active video render; its model is released between renders'
                          : model.modelLoaded === false
                            ? 'Model not loaded'
                            : model.modelLoaded === null || model.modelLoaded === undefined
                              ? 'Model state unknown'
                              : 'Model loaded'}
                    {!model.managed && model.url ? ` · External service at ${model.url}` : ''}
                    {model.id === 'chat' && !closed.includes(model.id)
                      ? ' · Idle state cannot be verified, so safe stop is unavailable'
                      : ''}
                  </small>
                </div>
                <div className="memory-candidate-actions">
                  <button
                    className="outline-button"
                    disabled={busy || closed.includes(model.id) || model.id === 'chat'}
                    onClick={() => closeService(model, false)}
                    aria-label={`Stop ${model.name} if idle`}
                  >
                    <Power size={15} /> Close if idle
                  </button>
                  <button
                    className="ghost-button"
                    disabled={busy || closed.includes(model.id)}
                    onClick={(event) => {
                      forceTrigger.current = event.currentTarget;
                      returnToForceTrigger.current = false;
                      setForceTarget(model);
                    }}
                  >
                    Force close {model.name}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="helper">
            No running model services were identified. Close other applications or services, then
            retry.
          </p>
        )}
        {forceTarget && (
          <div
            className="memory-force-confirm"
            role="group"
            aria-labelledby="memory-force-title"
            aria-describedby="memory-force-description"
          >
            <h3 id="memory-force-title" ref={forceHeading} tabIndex={-1}>
              Force close {forceTarget.name}?
            </h3>
            <p id="memory-force-description">Active work in this service will be interrupted.</p>
            <div className="memory-candidate-actions">
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() => {
                  returnToForceTrigger.current = true;
                  setForceTarget(null);
                }}
              >
                Go back
              </button>
              <button
                className="outline-button"
                disabled={busy}
                onClick={() => {
                  const model = forceTarget;
                  returnToForceTrigger.current = false;
                  setForceTarget(null);
                  dialog.current?.focus();
                  closeService(model, true);
                }}
              >
                Confirm force close
              </button>
            </div>
          </div>
        )}
        {notice && (
          <p className="helper" role="status" aria-live="polite">
            {notice}
          </p>
        )}
        {(error || actionError) && (
          <p className="settings-error" role="alert">
            {actionError || error}
          </p>
        )}
        <div className="project-dialog-actions">
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy} onClick={onRetry}>
            {busy ? <LoaderCircle size={15} className="motion-spinner" /> : <RefreshCw size={15} />}{' '}
            {action ? 'Closing service…' : working ? 'Checking memory…' : 'Retry memory check'}
          </button>
        </div>
      </section>
    </div>
  );
}
