import { ArrowDown, ArrowUp, ArrowUpToLine, GripVertical, X } from 'lucide-react';
import { jobAccessibleName } from './queue-groups.js';
import { REORDER_HELP } from './queue-reorder.js';
import './queue-reorder.css';

// What the controls of a row need to know about its neighbours in the order shown.
function neighboursOf(rows, job) {
  const index = rows.findIndex((row) => row.id === job.id);
  return {
    previousId: index > 0 ? rows[index - 1].id : null,
    nextId: index >= 0 && index < rows.length - 1 ? rows[index + 1].id : null,
  };
}

/** Extra classes for a waiting row while it is held, dragged, or the place something will land. */
export function reorderRowClass(job, reorder) {
  let classes = '';
  if (reorder.held?.id === job.id) {
    classes += ' queue-row-held';
  }
  if (reorder.drag?.id === job.id) {
    classes += ' queue-row-dragging';
  }
  if (reorder.drag?.target?.id === job.id) {
    classes += ` queue-drop-${reorder.drag.target.edge}`;
  }
  return classes;
}

/** The "#2" badge: where the render is in the waiting line. */
export function QueuePosition({ job, reorder }) {
  const { position, total } = reorder.moveState(job.id);
  if (!position) {
    return null;
  }
  return (
    <span
      className="queue-position"
      title="Place in the waiting line. Renders start from #1."
      aria-label={`Position ${position} of ${total} in the waiting line`}
    >
      #{position}
    </span>
  );
}

/**
 * Run next, Move up, Move down and a drag handle for one waiting render. A control that cannot
 * act stays focusable (aria-disabled) so the reason in its title can be read.
 */
export function QueueReorderControls({ job, rows, reorder }) {
  const name = jobAccessibleName(job);
  const { previousId, nextId } = neighboursOf(rows, job);
  const state = reorder.moveState(job.id, { previousId, nextId });
  const busyReason = reorder.pending ? 'Saving the new order…' : '';
  const control = (entry, action) => {
    const reason = busyReason || entry.reason;
    const allowed = !busyReason && entry.allowed;
    return {
      'aria-disabled': allowed ? undefined : 'true',
      title: allowed ? undefined : reason,
      onClick: () => {
        if (allowed) {
          action();
        }
      },
    };
  };
  const canDrag = !busyReason && Boolean(state.position) && state.total > 1;
  const held = reorder.held?.id === job.id;
  const position = state.position
    ? `Position ${state.position} of ${state.total}.`
    : 'This render can no longer be reordered.';
  return (
    <div className="queue-reorder" role="group" aria-label={`Order controls for ${name}`}>
      <button
        type="button"
        className="icon-outline queue-reorder-handle"
        data-reorder-handle={job.id}
        aria-label={`Reorder ${name}. ${position}`}
        aria-describedby={reorder.helpId}
        aria-pressed={held}
        aria-disabled={canDrag ? undefined : 'true'}
        title={
          canDrag
            ? 'Drag to reorder, or press Space to pick up and use the arrow keys.'
            : busyReason || state.next.reason
        }
        {...reorder.handleProps(job)}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-outline queue-reorder-button"
        aria-label={`Run next: ${name}`}
        {...control(state.next, () => reorder.runNext(job))}
      >
        <ArrowUpToLine size={14} aria-hidden="true" />
        <span>Run next</span>
      </button>
      <button
        type="button"
        className="icon-outline queue-reorder-button queue-reorder-icon"
        aria-label={`Move ${name} up`}
        {...control(state.up, () => reorder.moveUp(job, previousId))}
      >
        <ArrowUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="icon-outline queue-reorder-button queue-reorder-icon"
        aria-label={`Move ${name} down`}
        {...control(state.down, () => reorder.moveDown(job, nextId))}
      >
        <ArrowDown size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Instructions, the live announcements and the inline error for the waiting section. */
export function QueueReorderNotes({ reorder }) {
  return (
    <>
      <details className="queue-reorder-help">
        <summary>How to change the order</summary>
        <p id={reorder.helpId}>{REORDER_HELP}</p>
      </details>
      <div
        className="sr-only queue-reorder-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {reorder.announcement}
      </div>
      {reorder.error && (
        <p className="settings-error queue-reorder-error" role="alert">
          <span>{reorder.error}</span>
          <button
            type="button"
            className="icon-outline"
            aria-label="Dismiss this message"
            onClick={reorder.dismissError}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </p>
      )}
    </>
  );
}
