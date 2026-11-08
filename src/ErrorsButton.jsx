import { useEffect, useState } from 'react';
import { Bug } from 'lucide-react';
import { ERRORS_CHANGED_EVENT } from './error-capture.js';
import { getErrors } from './errors-api.js';
import { useT } from './i18n/index.js';
import './errors-dialog.css';

const POLL_MS = 15000;

/** Top-bar entry to the Errors review, with the number of new errors since it was last opened. */
export default function ErrorsButton({ onOpen, isOpen = false }) {
  const { t } = useT();
  const [unread, setUnread] = useState(null);
  const [isUnavailable, setIsUnavailable] = useState(false);
  useEffect(() => {
    let alive = true;
    let controller = null;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      controller?.abort();
      controller = new AbortController();
      try {
        const summary = await getErrors('/summary', { signal: controller.signal });
        if (alive) {
          setUnread(summary.unread);
          setIsUnavailable(false);
        }
      } catch (error) {
        if (alive && error.name !== 'AbortError') {
          setIsUnavailable(true);
        }
      }
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    window.addEventListener(ERRORS_CHANGED_EVENT, refresh);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(timer);
      window.removeEventListener(ERRORS_CHANGED_EVENT, refresh);
    };
  }, [isOpen]);
  const count = unread || 0;
  const label = isUnavailable
    ? t('errors.button.unavailable', 'Errors: count unavailable')
    : unread === null
      ? t('errors.button.checking', 'Errors: checking')
      : count
        ? t('errors.button.unread', 'Errors: {count} new since last opened', { count })
        : t('errors.button.noneNew', 'Errors: none new');
  const description = t('errors.button.description', '{label}. Open error review.', { label });
  return (
    <button
      type="button"
      className={'errors-button' + (count ? ' has-unread' : '')}
      aria-label={description}
      title={description}
      aria-haspopup="dialog"
      aria-expanded={isOpen}
      onClick={onOpen}
    >
      <Bug size={15} aria-hidden="true" />
      <span className="errors-button-text">{t('errors.button.text', 'Errors')}</span>
      {count > 0 && (
        <span className="errors-button-badge" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
