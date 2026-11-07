import { useEffect, useState } from 'react';
import { LoaderCircle, Power, RefreshCw, X } from 'lucide-react';
import useDialogFocus from './useDialogFocus';
import './memory-dialog.css';

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
      setNotice(`${model.name} closed. Check memory again when you are ready.`);
    } catch (e) {
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
        <div className="memory-numbers">
          <div>
            <span>FREE NOW</span>
            <strong>{gib(conflict.freeBytes === null && system ? null : free)}</strong>
          </div>
          <div>
            <span>NEEDED</span>
            <strong>{gib(required)}</strong>
          </div>
          <div>
            <span>SHORT BY</span>
            <strong>{gib(conflict.shortfallBytes === null && system ? null : shortfall)}</strong>
          </div>
        </div>
        {conflict.estimate && <p className="helper">{conflict.estimate}</p>}
        <h3>Models and services</h3>
        <p className="helper">
          Close a service if it is idle, or force close it if it is stuck. Force close interrupts
          active work. Model files stay on disk.
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
                    {!model.managed && model.url ? ` · ${model.url}` : ''}
                  </small>
                </div>
                <div className="memory-candidate-actions">
                  <button
                    className="outline-button"
                    disabled={busy || closed.includes(model.id) || model.id === 'chat'}
                    onClick={() => closeService(model, false)}
                    title={
                      model.id === 'chat'
                        ? 'This server does not report whether it is idle.'
                        : 'Closes the service after checking it is idle.'
                    }
                  >
                    <Power size={15} /> Close if idle
                  </button>
                  <button
                    className="ghost-button"
                    disabled={busy || closed.includes(model.id)}
                    onClick={() => setForceTarget(model)}
                  >
                    Force close
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
          <div className="memory-force-confirm" role="alert">
            <strong>Force close {forceTarget.name}?</strong>
            <p>Active work in this service will be interrupted.</p>
            <div className="memory-candidate-actions">
              <button className="ghost-button" disabled={busy} onClick={() => setForceTarget(null)}>
                Go back
              </button>
              <button
                className="outline-button"
                disabled={busy}
                onClick={() => {
                  const model = forceTarget;
                  setForceTarget(null);
                  closeService(model, true);
                }}
              >
                Confirm force close
              </button>
            </div>
          </div>
        )}
        {notice && (
          <p className="helper" role="status">
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
