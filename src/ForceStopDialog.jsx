import { CircleAlert, LoaderCircle, OctagonX, X } from 'lucide-react';
import { T, useT } from './i18n/index.js';
import useDialogFocus from './useDialogFocus';
import { jobAccessibleName } from './queue-groups.js';
import { jobShortId } from './queue-filters.js';
import './force-stop.css';

/**
 * Force stop of one engine. `reason` is 'render' when the person pressed Stop this render, or
 * 'service' from the Models page. `waitingJobs` lists the renders queued for this engine, which
 * a stop leaves in line; `facts` are the engine checks read when the dialog opened.
 */
export default function ForceStopDialog({
  name,
  reason = 'service',
  working,
  result,
  error,
  onClose,
  onForceStop,
  waitingJobs = [],
  projectNameOf = () => '',
  facts = null,
  factsStatus = 'ready',
  factsError = '',
  onRefreshFacts,
}) {
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
                : reason === 'render'
                  ? t('models.forceStop.renderTitle', 'Stop this render?')
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
        ) : reason === 'render' ? (
          <>
            <p id="force-stop-summary">
              {t(
                'models.forceStop.renderSummary',
                'Forge stops the {name} process that is running this render. This is the only stop that works while a render is busy: Stop service is unavailable until the render finishes.',
                { name },
              )}
            </p>
            <div className="force-stop-warning" id="force-stop-warning">
              <CircleAlert size={18} />
              <span>
                {t(
                  'models.forceStop.renderWarning',
                  'The render is marked interrupted and the queue pauses until you review it in the render queue. Partial output may remain in the project. Nothing is deleted, and model files stay on disk.',
                )}
              </span>
            </div>
            <p className="helper">
              {t(
                'models.forceStop.eligibility',
                'Only a process whose identity and ownership Forge can verify is eligible. Memory may take a moment to be released.',
              )}
            </p>
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
        {!result && facts && (
          <div className="force-stop-facts">
            <div className="force-stop-facts-head">
              <h3>{t('models.forceStop.factsTitle', 'Check before you stop')}</h3>
              {onRefreshFacts && (
                <button
                  type="button"
                  className="force-stop-link"
                  disabled={working || factsStatus === 'loading'}
                  onClick={onRefreshFacts}
                >
                  {t('common.confirm.refreshFacts', 'Check again')}
                </button>
              )}
            </div>
            {factsStatus === 'loading' && !facts.length ? (
              <p role="status" aria-live="polite">
                {t('common.confirm.factsLoading', 'Reading the engine state…')}
              </p>
            ) : (
              <dl>
                {facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {factsError && <p role="alert">{factsError}</p>}
          </div>
        )}
        {!result && (
          <div className="force-stop-waiting">
            <h3>
              {t('models.forceStop.waitingTitle', 'Renders waiting for this engine')}{' '}
              {factsStatus === 'ready' && (
                <span className="queue-group-count">{waitingJobs.length}</span>
              )}
            </h3>
            {factsStatus === 'loading' ? (
              <p className="helper" role="status">
                {t('models.forceStop.waitingLoading', 'Checking waiting renders…')}
              </p>
            ) : factsStatus !== 'ready' ? (
              <p className="helper">
                {t(
                  'models.forceStop.waitingUnknown',
                  'Waiting renders could not be checked. Check again before deciding.',
                )}
              </p>
            ) : waitingJobs.length ? (
              <>
                <p>
                  {reason === 'render'
                    ? t(
                        'models.forceStop.waitingRender',
                        'These stay in line after the stop. The queue pauses until the interrupted render is reviewed. A render that uses the interrupted render is cancelled only when you mark that one cancelled. Closing this dialog keeps all of them.',
                      )
                    : t(
                        'models.forceStop.waitingService',
                        'Force stop does not cancel these. They stay in line, and the queue waits for the interrupted render to be reviewed. Closing this dialog keeps all of them.',
                      )}
                </p>
                <ol className="force-stop-waiting-list">
                  {waitingJobs.map((job) => (
                    <li key={job.id}>
                      <strong>{jobAccessibleName(job)}</strong>{' '}
                      <span className="helper">
                        {[jobShortId(job), projectNameOf(job), job.status.replaceAll('_', ' ')]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="helper">
                {t('models.forceStop.waitingNone', 'No renders are waiting for this engine.')}
              </p>
            )}
          </div>
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
                  : reason === 'render'
                    ? t('models.forceStop.renderConfirm', 'Stop this render')
                    : t('models.forceStop.confirm', 'Force stop {name}', { name })}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
