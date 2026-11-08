// Client-side helpers for reordering the waiting line. The runtime decides the real order; these
// helpers show a move before it answers (using the same planner) and describe it in words.
import { WAITING_STATUSES, planMove } from '../runtime/queue-order.js';
import { ACTIVE_QUEUE_STATES } from '../runtime/queue-timing.js';
import { isWaitingForReference } from './queue-chain.js';

// A render can be reordered while it waits and has no engine job yet.
export function isMovableJob(job) {
  return WAITING_STATUSES.includes(job?.status) && !job?.remoteId;
}

// Every open render in queue order, in the shape the planner expects.
export function queueEntries(jobs) {
  return (jobs || [])
    .filter((job) => ACTIVE_QUEUE_STATES.has(job.status))
    .map((job) => ({
      id: job.id,
      status: job.status,
      movable: isMovableJob(job),
      parentId: job.dependsOn && isWaitingForReference(job) ? job.dependsOn : null,
    }));
}

export const waitingIds = (entries) =>
  entries.filter((entry) => entry.movable).map((entry) => entry.id);

// The same entries with the waiting ones laid out in `order`; other renders keep their place.
export function withWaitingOrder(entries, order) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sequence = order.filter((id) => byId.get(id)?.movable);
  const missing = waitingIds(entries).filter((id) => !sequence.includes(id));
  const queue = [...sequence, ...missing];
  let next = 0;
  return entries.map((entry) => (entry.movable ? byId.get(queue[next++]) : entry));
}

// Puts `items` (rows of one section) in `order`; rows missing from `order` keep their place.
export function sortByOrder(items, order) {
  if (!order) {
    return items;
  }
  const ranked = new Map(order.map((id, index) => [id, index]));
  const known = items.filter((item) => ranked.has(item.id));
  known.sort((a, b) => ranked.get(a.id) - ranked.get(b.id));
  let next = 0;
  return items.map((item) => (ranked.has(item.id) ? known[next++] : item));
}

// The list after the runtime (or an optimistic guess) changed the waiting order. Waiting rows
// are refilled into the slots the waiting rows already occupy; `ranks` refreshes queueRank.
export function applyWaitingOrder(jobs, order, ranks = null) {
  const slots = [];
  const present = new Map();
  jobs.forEach((job, index) => {
    if (order.includes(job.id) && isMovableJob(job)) {
      slots.push(index);
      present.set(job.id, job);
    }
  });
  const sequence = order.filter((id) => present.has(id));
  const result = [...jobs];
  slots.forEach((slot, position) => {
    result[slot] = present.get(sequence[position]);
  });
  if (!ranks) {
    return result;
  }
  return result.map((job) =>
    Object.hasOwn(ranks, job.id) ? { ...job, queueRank: ranks[job.id] } : job,
  );
}

const FIRST = 'Already first in line.';
const LAST = 'Already last in line.';
const CLAMPED = 'It uses the result of the render above it, so it has to wait behind it.';

function reasonFor(entries, id, spec) {
  try {
    const plan = planMove(entries, id, spec);
    if (plan.moved) {
      return '';
    }
    return plan.clamped ? CLAMPED : 'It is already there.';
    // log-coverage: ignore -- render-time helper; its message is shown, not logged
  } catch (error) {
    return error.message;
  }
}

/**
 * What each reorder control of one waiting row may do, with the reason when it may not.
 * @param {object[]} entries `queueEntries` of the whole list.
 * @param {string} id The row's job id.
 * @param {{previousId?: string|null, nextId?: string|null}} neighbours The rows shown directly
 *   above and below it, which can differ from the runtime order when some rows are hidden.
 */
export function rowMoveState(entries, id, { previousId = null, nextId = null } = {}) {
  const order = waitingIds(entries);
  const position = order.indexOf(id) + 1;
  const total = order.length;
  const none = (reason) => ({ allowed: false, reason });
  if (position === 0) {
    const reason = 'This render already has an engine job, so it can no longer be reordered.';
    return { position: null, total, next: none(reason), up: none(reason), down: none(reason) };
  }
  if (total < 2) {
    const reason = 'Only one render is waiting.';
    return { position, total, next: none(reason), up: none(reason), down: none(reason) };
  }
  const check = (spec, edge, missing) => {
    if (!edge) {
      return none(missing);
    }
    const reason = reasonFor(entries, id, spec);
    return reason ? none(reason) : { allowed: true, reason: '' };
  };
  return {
    position,
    total,
    next: check({ kind: 'to', value: 'next' }, position > 1, FIRST),
    up: check({ kind: 'before', value: previousId }, previousId, FIRST),
    down: check({ kind: 'after', value: nextId }, nextId, LAST),
  };
}

/** The sentence announced after a move, from the runtime's answer. */
export function moveAnnouncement(name, { moved, position, count, note, clamped }) {
  const where = `position ${position} of ${count}`;
  const base = moved ? `Moved ${name} to ${where}.` : `${name} stays at ${where}.`;
  const reason = note || (clamped ? CLAMPED : '');
  return reason ? `${base} ${reason}` : base;
}

export const REORDER_HELP =
  'To change the order, drag the handle, or focus it and press Space to pick the render up, ' +
  'use the arrow keys to move it, press Space to drop it, or Escape to cancel. ' +
  'Run next puts a render first in line. A running render is never interrupted.';
