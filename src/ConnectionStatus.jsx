import { useQueueTiming } from './QueueTiming';
import { useT } from './i18n/index.js';
import './recovery-panel.css';

/**
 * Tells the person that the studio stopped answering and that polling goes on. It is driven by
 * the queue poll (src/QueueTiming.jsx), keeps its live region mounted so a change is announced,
 * and clears itself when the studio answers again. Nothing the person typed is touched.
 */
export default function ConnectionStatus() {
  const { t } = useT();
  const { error } = useQueueTiming();
  return (
    <span className="connection-status" role="status" aria-live="polite">
      {error ? (
        <span className="connection-status-text">
          {t('shell.connection.reconnecting', 'Studio is not responding, reconnecting…')}
        </span>
      ) : null}
    </span>
  );
}
