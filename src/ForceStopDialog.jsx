import { CircleAlert, LoaderCircle, OctagonX, X } from 'lucide-react';
import { T, useT } from './i18n/index.js';
import useDialogFocus from './useDialogFocus';
import './force-stop.css';

export default function ForceStopDialog({ name, working, result, error, onClose, onForceStop }) {
  const { t } = useT();
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
            <span className="force-stop-kicker">
              {t('models.forceStop.kicker', 'Emergency control')}
            </span>
            <h2 id="force-stop-title">
              {result
                ? t('models.forceStop.stoppedTitle', 'Service stopped')
                : t('models.forceStop.confirmTitle', 'Force stop {name}?', { name })}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('models.forceStop.close', 'Close force stop dialog')}
            disabled={working}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {result ? (
          <>
            <p id="force-stop-result">
              {t(
                'models.forceStop.stoppedBody',
                'Forge stopped the verified process tree. GPU and system memory may take a moment to update.',
              )}
            </p>
            {result.interruptedJobId && (
              <p className="force-stop-warning">
                <CircleAlert size={18} />
                <span>
                  <T
                    id="models.forceStop.interrupted"
                    en="The affected render is marked <b>interrupted</b>. Review it in the render queue before continuing."
                    components={{ b: <strong /> }}
                  />
                </span>
              </p>
            )}
            {result.barrierNeedsReview && (
              <p className="force-stop-warning">
                <CircleAlert size={18} />
                <span>
                  {t(
                    'models.forceStop.barrierReview',
                    'A model-load check still needs review in Models & services.',
                  )}
                </span>
              </p>
            )}
          </>
        ) : (
          <>
            <p id="force-stop-summary">
              <T
                id="models.forceStop.summary"
                en="Try <b>Stop service</b> first. Use force stop only if the normal stop does not work."
                components={{ b: <strong /> }}
              />
            </p>
            <div className="force-stop-warning" id="force-stop-warning">
              <CircleAlert size={18} />
              <span>
                <T
                  id="models.forceStop.warning"
                  en="<b>Active work may be lost.</b> Forge will stop this service and its processes immediately. Any affected render will pause the queue for review. Model files and saved assets stay on disk."
                  components={{ b: <strong /> }}
                />
              </span>
            </div>
            <p className="helper">
              {t(
                'models.forceStop.eligibility',
                'Only a process whose identity and ownership Forge can verify is eligible. Memory may take a moment to be released.',
              )}
            </p>
          </>
        )}
        {error && (
          <div className="force-stop-error" role="alert">
            <strong>
              {t('models.forceStop.unconfirmed', 'Forge did not confirm that the service stopped.')}
            </strong>
            <p>
              {t(
                'models.forceStop.unconfirmedHelp',
                'The process may still be running. Check service status, the render queue, and Diagnostics before trying again.',
              )}
            </p>
            <p>{error}</p>
          </div>
        )}
        {working && (
          <p className="force-stop-progress" role="status" aria-live="polite">
            {t(
              'models.forceStop.progress',
              'Forge is checking the service and verifying the stop. Keep this dialog open.',
            )}
          </p>
        )}
        <div className="project-dialog-actions">
          {result ? (
            <button type="button" className="primary" onClick={onClose}>
              {t('common.action.done', 'Done')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="ghost-button force-stop-cancel"
                disabled={working}
                onClick={onClose}
              >
                {t('common.action.cancel', 'Cancel')}
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
                {working
                  ? t('models.forceStop.stopping', 'Stopping {name}…', { name })
                  : t('models.forceStop.confirm', 'Force stop {name}', { name })}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
