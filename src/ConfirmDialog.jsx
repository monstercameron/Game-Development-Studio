import { CircleAlert, LoaderCircle, X } from 'lucide-react';
import { useT } from './i18n/index.js';
import useDialogFocus from './useDialogFocus';
import './confirm-dialog.css';

/**
 * The studio's confirmation dialog. It replaces window.confirm, which embedded browsers suppress,
 * so a decision can never fail silently. `facts` are label and value pairs the person checks
 * before confirming; `error` stays in the dialog so a failed action can be read and retried.
 */
export default function ConfirmDialog({
  title,
  kicker,
  children,
  facts = null,
  factsStatus = 'ready',
  factsError = '',
  onRefreshFacts,
  error = '',
  notice = '',
  confirmLabel,
  busyLabel,
  cancelLabel,
  tone = 'default',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onClose,
}) {
  const { t } = useT();
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busy) {
        onClose();
      }
    },
    initialFocus: '.studio-confirm-cancel',
  });
  const closeIfIdle = () => {
    if (!busy) {
      onClose();
    }
  };
  return (
    <div className="modal-backdrop studio-confirm-backdrop" onClick={closeIfIdle}>
      <section
        ref={dialog}
        className="settings-modal studio-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-confirm-title"
        aria-describedby="studio-confirm-body"
        aria-busy={busy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            {kicker && <span className="studio-confirm-kicker">{kicker}</span>}
            <h2 id="studio-confirm-title">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('common.action.close', 'Close')}
            disabled={busy}
            onClick={closeIfIdle}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div id="studio-confirm-body" className="studio-confirm-body">
          {children}
        </div>
        {facts && (
          <div className="studio-confirm-facts">
            <div className="studio-confirm-facts-head">
              <h3>{t('common.confirm.checkFirst', 'Check before you continue')}</h3>
              {onRefreshFacts && (
                <button
                  type="button"
                  className="studio-confirm-link"
                  disabled={factsStatus === 'loading'}
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
            {factsError && (
              <p className="studio-confirm-error" role="alert">
                {factsError}
              </p>
            )}
          </div>
        )}
        {notice && (
          <p className="studio-confirm-notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}
        {error && (
          <div className="studio-confirm-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}
        {busy && (
          <p className="studio-confirm-progress" role="status" aria-live="polite">
            {busyLabel}
          </p>
        )}
        <div className="project-dialog-actions">
          <button
            type="button"
            className="ghost-button studio-confirm-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {cancelLabel || t('common.action.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'studio-confirm-danger' : 'primary'}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy && <LoaderCircle size={16} className="motion-spinner" aria-hidden="true" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
