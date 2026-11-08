import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { planMove } from '../runtime/queue-order.js';
import { jobAccessibleName } from './queue-groups.js';
import {
  isMovableJob,
  moveAnnouncement,
  queueEntries,
  rowMoveState,
  sortByOrder,
  waitingIds,
  withWaitingOrder,
} from './queue-reorder.js';
import { createLog } from './app-log.js';

const log = createLog('queue');

// A non-breaking space makes a repeated sentence a change the screen reader announces again.
const REPEAT_MARK = String.fromCharCode(160);
const CONFLICT_MESSAGE =
  'The waiting line was changed somewhere else, so this move was not applied. It now shows the current order.';

/**
 * Reordering of the waiting line: buttons, keyboard pick-up and pointer dragging.
 *
 * Moves are applied to the list at once and sent to the runtime; if the runtime refuses, the
 * list goes back (or to the order the runtime reports) and an error is shown. The runtime stays
 * the source of truth, and nothing here starts, stops or preempts a render.
 *
 * @param {object} options
 * @param {object[]} options.jobs Every job, in queue order.
 * @param {object[]} options.items The rows shown in the waiting section (hidden rows left out).
 * @param {(path: string, body: object) => Promise<object>} options.post JSON POST that rejects
 *   with `status` and `body` on a refusal.
 * @param {(order: string[], ranks?: object|null) => object[]} options.applyOrder
 * @param {(previous: object[]) => void} options.restoreJobs
 * @param {() => Promise<void>|void} options.refresh
 */
export default function useQueueReorder({ jobs, items, post, applyOrder, restoreJobs, refresh }) {
  const helpId = useId();
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [held, setHeld] = useState(null);
  const [drag, setDrag] = useState(null);
  const heldRef = useRef(null);
  const dragRef = useRef(null);
  const pendingRef = useRef(false);
  const latest = useRef({ jobs, items });
  latest.current = { jobs, items };

  const announce = useCallback((text) => {
    // A repeated sentence is not read again unless the text changes.
    setAnnouncement((previous) => (previous === text ? `${text}${REPEAT_MARK}` : text));
  }, []);
  const jobById = (id) => latest.current.jobs.find((job) => job.id === id) || null;
  const nameOf = (id) => jobAccessibleName(jobById(id) || { id });

  const setHeldState = useCallback((next) => {
    heldRef.current = next;
    setHeld(next);
  }, []);
  const setDragState = useCallback((next) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  // The rows of the waiting section in the order currently shown (a held render is moved live).
  const orderedItems = useCallback((list) => sortByOrder(list, held ? held.order : null), [held]);

  async function move(job, spec) {
    if (pendingRef.current) {
      return;
    }
    const current = latest.current.jobs;
    const entries = queueEntries(current);
    const name = jobAccessibleName(job);
    let plan;
    try {
      plan = planMove(entries, job.id, spec);
    } catch (reason) {
      log.warn('queue.reorder.plan.failed', {
        kind: spec.kind,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      setError(reason.message);
      announce(reason.message);
      return;
    }
    const anchor = spec.kind === 'before' || spec.kind === 'after' ? jobById(spec.value) : null;
    const body = {
      [spec.kind === 'to' ? 'to' : spec.kind]: spec.value,
      expectedRank: job.queueRank ?? null,
      ...(anchor ? { expectedAnchorRank: anchor.queueRank ?? null } : {}),
    };
    if (!plan.moved) {
      log.debug('queue.reorder.unchanged', {
        kind: spec.kind,
        position: plan.to,
        count: plan.count,
        isClamped: Boolean(plan.clamped),
      });
      announce(moveAnnouncement(name, plan));
      return;
    }
    setError('');
    pendingRef.current = true;
    setPending(true);
    // Show the planned order right away; `before` is what to restore if the move fails.
    const movableIds = new Set(waitingIds(entries));
    const before = applyOrder(plan.order.filter((id) => movableIds.has(id)));
    log.debug('queue.reorder.requested', { jobId: job.id, kind: spec.kind, count: plan.count });
    const stopTiming = log.time('queue.reorder.moved', { jobId: job.id, kind: spec.kind });
    try {
      const result = await post(`/api/runtime/jobs/${job.id}/move`, body);
      applyOrder(result.order, result.ranks);
      stopTiming({
        position: result.position,
        count: result.count,
        isClamped: Boolean(result.clamped),
      });
      announce(moveAnnouncement(name, result));
      await refresh();
    } catch (reason) {
      const fresh = reason.body;
      if (reason.status === 409 && Array.isArray(fresh?.order)) {
        log.warn('queue.reorder.conflicted', {
          jobId: job.id,
          kind: spec.kind,
          httpStatus: reason.status,
          errorCode: fresh.code,
          count: fresh.order.length,
        });
        applyOrder(fresh.order, fresh.ranks);
        const message = fresh.code === 'stale' ? CONFLICT_MESSAGE : reason.message;
        setError(message);
        announce(`${name} was not moved. ${message}`);
      } else {
        log.error('queue.reorder.failed', {
          jobId: job.id,
          kind: spec.kind,
          httpStatus: reason?.status,
          errorClass: reason?.name,
        });
        restoreJobs(before);
        const message = reason.message || 'The render could not be moved.';
        setError(message);
        announce(`${name} was not moved. ${message}`);
      }
      await refresh();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const runNext = (job) => move(job, { kind: 'to', value: 'next' });
  const moveUp = (job, previousId) => move(job, { kind: 'before', value: previousId });
  const moveDown = (job, nextId) => move(job, { kind: 'after', value: nextId });

  // Keyboard: Space picks a render up, arrows move it, Space drops it, Escape puts it back.
  function pickUp(job) {
    const entries = queueEntries(latest.current.jobs);
    const state = rowMoveState(entries, job.id);
    if (pendingRef.current || !isMovableJob(job) || !state.position || state.total < 2) {
      log.debug('queue.reorder.pickup.refused', {
        isPending: pendingRef.current,
        isMovable: isMovableJob(job),
        position: state.position,
        count: state.total,
      });
      announce(state.next.reason || 'This render cannot be moved right now.');
      return;
    }
    const order = waitingIds(entries);
    setError('');
    setHeldState({ id: job.id, order, start: order });
    log.info('queue.reorder.pickup.started', { position: state.position, count: state.total });
    announce(
      `Picked up ${jobAccessibleName(job)}, position ${state.position} of ${state.total}. ` +
        'Use the arrow keys to move it, Space to drop it, Escape to cancel.',
    );
  }

  function stepHeld(job, spec) {
    const current = heldRef.current;
    if (!current || current.id !== job.id) {
      return;
    }
    const entries = withWaitingOrder(queueEntries(latest.current.jobs), current.order);
    let plan;
    try {
      plan = planMove(entries, job.id, spec);
    } catch (reason) {
      log.warn('queue.reorder.step.failed', {
        kind: spec.kind,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      announce(reason.message);
      return;
    }
    const total = waitingIds(entries).length;
    if (!plan.moved) {
      log.debug('queue.reorder.step.unchanged', {
        position: plan.to,
        count: total,
        isClamped: Boolean(plan.clamped),
      });
      const edge = plan.to === 1 ? 'first' : 'last';
      announce(
        plan.clamped
          ? `${jobAccessibleName(job)} has to stay behind the render it uses. Position ${plan.to} of ${total}.`
          : `${jobAccessibleName(job)} is already ${edge} in line. Position ${plan.to} of ${total}.`,
      );
      return;
    }
    const order = plan.order.filter((id) => entries.find((entry) => entry.id === id)?.movable);
    setHeldState({ ...current, order });
    announce(`${jobAccessibleName(job)}, position ${plan.to} of ${plan.count}.`);
  }

  function dropHeld(job) {
    const current = heldRef.current;
    if (!current || current.id !== job.id) {
      return;
    }
    setHeldState(null);
    const unchanged = current.order.join() === current.start.join();
    if (unchanged) {
      log.debug('queue.reorder.drop.unchanged', {
        position: current.start.indexOf(job.id) + 1,
        count: current.start.length,
      });
      announce(
        `${jobAccessibleName(job)} dropped where it was, position ${
          current.start.indexOf(job.id) + 1
        } of ${current.start.length}.`,
      );
      return;
    }
    // Place it by the row that is now above it (or below it when it is first).
    const shown = sortByOrder(latest.current.items, current.order);
    const index = shown.findIndex((item) => item.id === job.id);
    const above = shown[index - 1];
    const below = shown[index + 1];
    if (above) {
      move(job, { kind: 'after', value: above.id });
    } else if (below) {
      move(job, { kind: 'before', value: below.id });
    }
  }

  function cancelHeld(job, silent = false) {
    const current = heldRef.current;
    if (!current || (job && current.id !== job.id)) {
      return;
    }
    setHeldState(null);
    log.debug('queue.reorder.cancelled', {
      position: current.start.indexOf(current.id) + 1,
      count: current.start.length,
    });
    if (!silent) {
      announce(
        `Move cancelled. ${nameOf(current.id)} is back at position ${
          current.start.indexOf(current.id) + 1
        } of ${current.start.length}.`,
      );
    }
  }

  // Keep focus on the handle while its row changes place, so the next key press still lands.
  useLayoutEffect(() => {
    if (!held) {
      return;
    }
    const handle = document.querySelector(`[data-reorder-handle="${held.id}"]`);
    if (handle && document.activeElement !== handle) {
      handle.focus();
    }
  }, [held]);

  function handleKeyDown(event, job) {
    const { key } = event;
    const isHeld = heldRef.current?.id === job.id;
    const rows = orderedItems(latest.current.items);
    const index = rows.findIndex((item) => item.id === job.id);
    if (key === ' ' || key === 'Spacebar' || key === 'Enter') {
      event.preventDefault();
      if (isHeld) {
        dropHeld(job);
      } else {
        pickUp(job);
      }
      return;
    }
    if (!isHeld) {
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelHeld(job);
    } else if (key === 'ArrowUp' || key === 'ArrowLeft') {
      event.preventDefault();
      stepHeld(
        job,
        index > 0 ? { kind: 'before', value: rows[index - 1].id } : { kind: 'to', value: 'top' },
      );
    } else if (key === 'ArrowDown' || key === 'ArrowRight') {
      event.preventDefault();
      stepHeld(
        job,
        index < rows.length - 1
          ? { kind: 'after', value: rows[index + 1].id }
          : { kind: 'to', value: 'end' },
      );
    } else if (key === 'Home') {
      event.preventDefault();
      stepHeld(job, { kind: 'to', value: 'top' });
    } else if (key === 'End') {
      event.preventDefault();
      stepHeld(job, { kind: 'to', value: 'end' });
    }
  }

  // A space released on a button would click it; the handle has no click action.
  function handleKeyUp(event) {
    if (event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
    }
  }

  function handleBlur(job) {
    if (heldRef.current?.id === job.id) {
      cancelHeld(job);
    }
  }

  // Pointer (mouse, pen and touch): press the handle, move over another row, release to drop.
  function targetAt(event, id) {
    const group = event.currentTarget.closest('.queue-group-waiting');
    const rows = [...(group ? group.querySelectorAll('[data-job-id]') : [])].filter(
      (row) => row.dataset.jobId !== id,
    );
    for (const row of rows) {
      const box = row.getBoundingClientRect();
      if (event.clientY < box.top + box.height / 2) {
        return { id: row.dataset.jobId, edge: 'before' };
      }
    }
    const last = rows.at(-1);
    return last ? { id: last.dataset.jobId, edge: 'after' } : null;
  }

  function handlePointerDown(event, job) {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    const state = rowMoveState(queueEntries(latest.current.jobs), job.id);
    if (pendingRef.current || !isMovableJob(job) || !state.position || state.total < 2) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch (error) {
      log.debug('queue.reorder.capture.failed', { errorClass: error?.name });
      // Capture can fail for a pointer that has already ended; the drag then ends with it.
    }
    event.currentTarget.focus?.();
    setError('');
    setDragState({ id: job.id, pointerId: event.pointerId, target: null });
    log.info('queue.reorder.drag.started', { position: state.position, count: state.total });
    announce(`Dragging ${jobAccessibleName(job)}. Release over another render to drop it.`);
  }

  function handlePointerMove(event, job) {
    const current = dragRef.current;
    if (!current || current.id !== job.id || current.pointerId !== event.pointerId) {
      return;
    }
    const target = targetAt(event, job.id);
    const same =
      (current.target?.id ?? null) === (target?.id ?? null) &&
      (current.target?.edge ?? null) === (target?.edge ?? null);
    if (!same) {
      setDragState({ ...current, target });
    }
  }

  function handlePointerUp(event, job) {
    const current = dragRef.current;
    if (!current || current.id !== job.id || current.pointerId !== event.pointerId) {
      return;
    }
    const target = current.target;
    setDragState(null);
    if (!target) {
      log.debug('queue.reorder.drag.cancelled');
      announce(`Move cancelled. ${jobAccessibleName(job)} stays where it was.`);
      return;
    }
    move(job, { kind: target.edge, value: target.id });
  }

  function cancelDrag(announceIt = true) {
    const current = dragRef.current;
    if (!current) {
      return;
    }
    setDragState(null);
    log.debug('queue.reorder.drag.cancelled');
    if (announceIt) {
      announce(`Move cancelled. ${nameOf(current.id)} stays where it was.`);
    }
  }

  function handlePointerCancel(job) {
    if (dragRef.current?.id === job.id) {
      cancelDrag();
    }
  }

  // Escape cancels a drag from anywhere on the page.
  const isDragging = Boolean(drag);
  useEffect(() => {
    if (!isDragging) {
      return undefined;
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDrag();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // cancelDrag only reads refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDragging]);

  return {
    helpId,
    announcement,
    error,
    dismissError: () => setError(''),
    pending,
    held,
    drag,
    orderedItems,
    moveState: (id, neighbours) => rowMoveState(queueEntries(jobs), id, neighbours),
    runNext,
    moveUp,
    moveDown,
    handleProps: (job) => ({
      onKeyDown: (event) => handleKeyDown(event, job),
      onKeyUp: handleKeyUp,
      onBlur: () => handleBlur(job),
      onPointerDown: (event) => handlePointerDown(event, job),
      onPointerMove: (event) => handlePointerMove(event, job),
      onPointerUp: (event) => handlePointerUp(event, job),
      onPointerCancel: () => handlePointerCancel(job),
    }),
  };
}
