import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LoaderCircle, Power, RefreshCw, X } from 'lucide-react';
import useDialogFocus from './useDialogFocus';
import { createLog } from './app-log.js';
import { useT } from './i18n/index.js';
import { gpuCoversRequirement } from './engine-controls.js';
import './memory-dialog.css';

const log = createLog('memory');
const gib = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} GiB` : 'Unavailable');
// Unknown readings must remain unknown: null divided by a number would become zero.
const toGiB = (value, divisor) => (Number.isFinite(value) && value >= 0 ? value / divisor : null);
// Live GPU figures from the runtime. Read-only: reading them never changes memory.
async function readLiveGpu(signal) {
  const response = await fetch('/api/runtime/hardware', { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(body.error || 'Could not read GPU memory.');
  }
  const device = (body.devices || []).find((item) => Number.isFinite(item.freeMiB));
  if (!device) {
    throw Error(body.error || 'No GPU reports its free memory right now.');
  }
  return {
    deviceName: device.name || 'GPU',
    freeMiB: device.freeMiB,
    totalMiB: device.totalMiB,
    checkedAt: Number.isFinite(Date.parse(body.measuredAt))
      ? body.measuredAt
      : new Date().toISOString(),
  };
}
const qwenFallback = () =>
  document.querySelector('.chat-config-heading button:not(:disabled)') ||
  document.querySelector('.chat-composer textarea:not(:disabled)') ||
  document.querySelector('.chat-model-selector:not(:disabled)');

// Status line under a service name. A service closed in this session wins, then an
// active render, then the model state; a missing state is reported as unknown.
function candidateStatusLabel(model, isClosed) {
  if (isClosed) {
    return 'Closed';
  }
  if (model.busy) {
    return 'Currently in use';
  }
  if (model.id === 'video') {
    return 'No active video render; its model is released between renders';
  }
  if (model.modelLoaded === false) {
    return 'Model not loaded';
  }
  if (model.modelLoaded === null || model.modelLoaded === undefined) {
    return 'Model state unknown';
  }
  return 'Model loaded';
}

export default function MemoryDialog({
  conflict,
  onClose,
  onRetry,
  working,
  target = 'YuE2',
  error = '',
}) {
  const { t } = useT();
  const [action, setAction] = useState(''),
    [outcomes, setOutcomes] = useState({}),
    [closed, setClosed] = useState([]),
    [gpuReload, setGpuReload] = useState(0),
    [gpu, setGpu] = useState({ status: 'loading', error: '' }),
    [forceTarget, setForceTarget] = useState(null);
  const forceTrigger = useRef(null),
    // Set when focus should go back to the force-close button after the prompt is dismissed.
    // Confirming clears it, because focus then moves to the dialog itself.
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
  // Host memory arrives in bytes and GPU memory in MiB; both are shown in GiB.
  const free = system
    ? toGiB(conflict.freeBytes, 1024 ** 3)
    : toGiB(conflict.device?.freeMiB, 1024);
  const required = system
    ? toGiB(conflict.requiredBytes, 1024 ** 3)
    : toGiB(conflict.requiredMiB, 1024);
  const shortfall = system
    ? toGiB(conflict.shortfallBytes, 1024 ** 3)
    : toGiB(conflict.shortfallMiB, 1024);
  const gpuVerdict =
    !system && gpu.status === 'ready' ? gpuCoversRequirement(required, gpu.freeMiB / 1024) : null;
  // Layout effect so focus moves before paint, when the prompt or its trigger is in the DOM.
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
    setOutcomes({});
  }, [conflict]);
  useEffect(() => {
    const controller = new AbortController();
    setGpu((current) => ({ ...current, status: 'loading', error: '' }));
    readLiveGpu(controller.signal).then(
      (figures) => {
        if (!controller.signal.aborted) {
          setGpu({ status: 'ready', error: '', ...figures });
        }
      },
      (readError) => {
        if (!controller.signal.aborted) {
          log.debug('memory.gpu.read.failed', { error: readError });
          setGpu({ status: 'error', error: readError.message });
        }
      },
    );
    return () => controller.abort();
  }, [gpuReload]);
  async function closeService(model, force) {
    setAction(model.id);
    setOutcomes((current) => ({ ...current, [model.id]: { state: 'closing', text: '' } }));
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
      setOutcomes((current) => ({
        ...current,
        [model.id]: {
          state: 'stopped',
          text: 'Stopped. Free memory may take a moment to update; check the live GPU numbers before retrying.',
        },
      }));
    } catch (closeError) {
      log.warn('memory.service.close.failed', {
        modelId: model.id,
        operation: force ? 'force-close' : 'close',
        error: closeError,
      });
      setOutcomes((current) => ({
        ...current,
        [model.id]: { state: 'failed', text: `Not stopped: ${closeError.message}` },
      }));
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
            <strong>{gib(free)}</strong>
          </div>
          <div>
            <span>Required</span>
            <strong>{gib(required)}</strong>
          </div>
          <div>
            <span>Additional memory needed</span>
            <strong>{gib(shortfall)}</strong>
          </div>
        </div>
        {conflict.estimate && <p className="helper">{conflict.estimate}</p>}
        <p className="helper memory-estimate-note">
          {system && conflict.hostPolicy === 'soft'
            ? t(
                'models.memory.hostFloor',
                'The system-memory requirement is the configured safety floor. GPU memory is checked separately.',
              )
            : t(
                'models.memory.estimate',
                'The required amount is a configured estimate, not a measurement. It is conservative and has not been calibrated for this computer, so it can refuse a render that would fit.',
              )}
        </p>
        <div className="memory-live" role="status" aria-live="polite">
          <div>
            <span>Live GPU memory now</span>
            <strong>
              {gpu.status === 'ready'
                ? Number.isFinite(gpu.totalMiB)
                  ? `${(gpu.freeMiB / 1024).toFixed(1)} GiB free of ${(gpu.totalMiB / 1024).toFixed(1)} GiB`
                  : t('models.memory.gpuFree', '{free} GiB free; total unavailable', {
                      free: (gpu.freeMiB / 1024).toFixed(1),
                    })
                : gpu.status === 'error'
                  ? 'Unavailable'
                  : 'Reading…'}
            </strong>
            {gpu.status === 'ready' && (
              <small>
                {gpu.deviceName}, read {new Date(gpu.checkedAt).toLocaleTimeString()}
              </small>
            )}
          </div>
          <button
            type="button"
            className="ghost-button"
            disabled={gpu.status === 'loading'}
            onClick={() => setGpuReload((count) => count + 1)}
          >
            <RefreshCw size={15} /> Refresh GPU numbers
          </button>
          {gpu.status === 'error' && <small>{gpu.error}</small>}
          {gpuVerdict === true && (
            <p>
              {t(
                'models.memory.gpuCovers',
                'Live free GPU memory now covers the estimate. Retry to check whether the render can start.',
              )}
            </p>
          )}
          {gpuVerdict === false && (
            <p>
              {t('models.memory.gpuShort', 'Live free GPU memory is still below the estimate.')}
            </p>
          )}
          <small>
            {t(
              'models.memory.gpuNote',
              'GPU free memory already accounts for loaded models and other GPU users. System memory is checked separately.',
            )}
          </small>
        </div>
        <h3>Models and services</h3>
        <ul className="memory-actions-help">
          <li>
            <strong>Close if idle</strong> stops that service only when it is not rendering. This is
            the safe choice.
          </li>
          <li>
            <strong>Force close</strong> stops the service now and interrupts any render it is
            running. Model files stay on disk.
          </li>
          <li>
            <strong>Retry the render</strong> sends the waiting work back through the runtime, which
            checks memory again before it starts.
          </li>
        </ul>
        {conflict.candidates?.length ? (
          <div className="memory-candidates">
            {conflict.candidates.map((model) => (
              <div className="memory-candidate" key={model.id}>
                <div>
                  <strong>{model.name}</strong>
                  <small>
                    {candidateStatusLabel(model, closed.includes(model.id))}
                    {!model.managed && model.url ? ` · External service at ${model.url}` : ''}
                    {model.id === 'chat' && !closed.includes(model.id)
                      ? ' · Idle state cannot be verified, so safe stop is unavailable'
                      : ''}
                  </small>
                  {outcomes[model.id] && (
                    <small
                      className={`memory-outcome memory-outcome-${outcomes[model.id].state}`}
                      role="status"
                    >
                      {outcomes[model.id].state === 'closing'
                        ? 'Closing service… Forge is verifying the stop.'
                        : outcomes[model.id].text}
                    </small>
                  )}
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
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="project-dialog-actions">
          <button className="ghost-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy} onClick={onRetry}>
            {working ? (
              <LoaderCircle size={15} className="motion-spinner" />
            ) : (
              <RefreshCw size={15} />
            )}{' '}
            {working ? 'Retrying…' : 'Retry the render'}
          </button>
        </div>
      </section>
    </div>
  );
}
