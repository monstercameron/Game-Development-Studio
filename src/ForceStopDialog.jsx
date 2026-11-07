import { CircleAlert, LoaderCircle, OctagonX, X } from 'lucide-react';
import useDialogFocus from './useDialogFocus';
import './force-stop.css';

export default function ForceStopDialog({ name, working, result, error, onClose, onForceStop }) {
  const dialog = useDialogFocus({
    onClose: () => {
      if (!working) {
        onClose();
      }
    },
    initialFocus: '.force-stop-cancel',
  });
  return (
    <div
      className="modal-backdrop force-stop-backdrop"
      onClick={() => {
        if (!working) {
          onClose();
        }
      }}
    >
      <section
        ref={dialog}
        className="settings-modal force-stop-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="force-stop-title"
        aria-describedby={result ? 'force-stop-result' : 'force-stop-summary force-stop-warning'}
        aria-busy={working}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="force-stop-kicker">Emergency control</span>
            <h2 id="force-stop-title">{result ? 'Service stopped' : `Force stop ${name}?`}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close force stop dialog"
            disabled={working}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {result ? (
          <>
            <p id="force-stop-result">
              Forge stopped the verified process tree. GPU and system memory may take a moment to
              update.
            </p>
            {result.interruptedJobId && (
              <p className="force-stop-warning">
                <CircleAlert size={18} />
                <span>
                  The affected render is marked <strong>interrupted</strong>. Review it in the
                  render queue before continuing.
                </span>
              </p>
            )}
            {result.barrierNeedsReview && (
              <p className="force-stop-warning">
                <CircleAlert size={18} />
                <span>A model-load check still needs review in Models & services.</span>
              </p>
            )}
          </>
        ) : (
          <>
            <p id="force-stop-summary">
              Try <strong>Stop service</strong> first. Use force stop only if the normal stop does
              not work.
            </p>
            <div className="force-stop-warning" id="force-stop-warning">
              <CircleAlert size={18} />
              <span>
                <strong>Active work may be lost.</strong> Forge will stop this service and its
                processes immediately. Any affected render will pause the queue for review. Model
                files and saved assets stay on disk.
              </span>
            </div>
            <p className="helper">
              Only a process whose identity and ownership Forge can verify is eligible. Memory may
              take a moment to be released.
            </p>
          </>
        )}
        {error && (
          <div className="force-stop-error" role="alert">
            <strong>Forge did not confirm that the service stopped.</strong>
            <p>
              The process may still be running. Check service status, the render queue, and
              Diagnostics before trying again.
            </p>
            <p>{error}</p>
          </div>
        )}
        {working && (
          <p className="force-stop-progress" role="status" aria-live="polite">
            Forge is checking the service and verifying the stop. Keep this dialog open.
          </p>
        )}
        <div className="project-dialog-actions">
          {result ? (
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="ghost-button force-stop-cancel"
                disabled={working}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="force-stop-confirm"
                disabled={working}
                onClick={onForceStop}
              >
                {working ? (
                  <LoaderCircle size={16} className="motion-spinner" />
                ) : (
                  <OctagonX size={16} />
                )}{' '}
                {working ? `Stopping ${name}…` : `Force stop ${name}`}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
