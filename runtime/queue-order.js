// Order of the durable render queue, and moving a waiting render within it.
//
// Every job row has a nullable `queue_rank` (REAL). The scheduler always takes the open job with
// the lowest (COALESCE(queue_rank, rowid), created_at, rowid). Rows written before the column
// existed keep a NULL rank and sort by their insertion order (rowid), exactly as before. A new job
// gets a rank above every rank and rowid already in the table, so it joins the end of the line.
//
// A move writes one rank (or, when a render has to carry the renders that wait for it, a few) that
// lies between the ranks of its new neighbours, so it never rewrites the rest of the queue. When
// two neighbours are too close for another midpoint, the open jobs are renumbered once in the same
// transaction. Ranks are internal ordering keys: clients compare them for equality only (the
// optional `expectedRank` check) and never do arithmetic with them.
//
// Only the planning half touches no database, so the studio page can reuse `planMove` to show a
// move before the runtime confirms it. The runtime stays the source of truth.

// Shared with the browser (src/queue-reorder.js), so it uses the browser-safe logger.
import { createLogger } from './shared-log.js';

const log = createLogger('queue');

export const WAITING_STATUSES = ['queued', 'waiting_engine', 'waiting_memory'];
export const OPEN_STATUSES = [
  'queued',
  'waiting_engine',
  'waiting_memory',
  'preparing',
  'needs_attention',
  'submitting',
  'running',
  'finalizing',
  'interrupted',
];

// Spacing used when open jobs are numbered afresh, and the smallest gap that still allows a
// midpoint. A gap of 1024 survives about 30 successive halvings before a renumbering is needed.
export const RANK_STEP = 1024;
export const MIN_RANK_GAP = 1e-6;

export const MOVE_TARGETS = ['next', 'top', 'end'];
export const MOVE_DIRECTIONS = ['up', 'down'];

const JOB_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MOVE_KEYS = ['to', 'before', 'after', 'direction', 'expectedRank', 'expectedAnchorRank'];

// SQL for "the order the scheduler walks the queue in". Keep every queue read on this expression.
export const QUEUE_ORDER_SQL = 'COALESCE(queue_rank,rowid),created_at,rowid';
// Rank for a job being inserted: above every stored rank and every row id.
export const NEXT_RANK_SQL =
  'MAX(COALESCE((SELECT MAX(queue_rank) FROM jobs),0),COALESCE((SELECT MAX(rowid) FROM jobs),0))+1';

/**
 * A refused or conflicting move. `status` is the HTTP status to answer with, `code` a stable
 * identifier for clients, and `extra` (when set) the fresh queue order for a 409.
 */
export class QueueMoveError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.name = 'QueueMoveError';
    // log-coverage: ignore -- error object field, not a job state change
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function isRankValue(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Strictly validates the body of a move request.
 * @param {unknown} input Parsed JSON body.
 * @returns {{kind: 'to'|'before'|'after'|'direction', value: string,
 *   expectedRank?: number|null, expectedAnchorRank?: number|null}}
 */
export function parseMoveRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new QueueMoveError(400, 'invalid_request', 'Expected a JSON object.');
  }
  const unknown = Object.keys(input).filter((key) => !MOVE_KEYS.includes(key));
  if (unknown.length) {
    throw new QueueMoveError(400, 'invalid_request', `Unknown field: ${unknown[0]}.`);
  }
  const chosen = ['to', 'before', 'after', 'direction'].filter((key) => input[key] !== undefined);
  if (chosen.length !== 1) {
    throw new QueueMoveError(
      400,
      'invalid_request',
      'Give exactly one of to, before, after or direction.',
    );
  }
  const kind = chosen[0];
  const value = input[kind];
  if (kind === 'to' && !MOVE_TARGETS.includes(value)) {
    throw new QueueMoveError(400, 'invalid_request', 'to must be "next", "top" or "end".');
  }
  if (kind === 'direction' && !MOVE_DIRECTIONS.includes(value)) {
    throw new QueueMoveError(400, 'invalid_request', 'direction must be "up" or "down".');
  }
  if ((kind === 'before' || kind === 'after') && !JOB_ID_PATTERN.test(String(value))) {
    throw new QueueMoveError(400, 'invalid_request', `${kind} must be a render ID.`);
  }
  const request = { kind, value };
  for (const key of ['expectedRank', 'expectedAnchorRank']) {
    if (input[key] === undefined) {
      continue;
    }
    if (!isRankValue(input[key])) {
      throw new QueueMoveError(400, 'invalid_request', `${key} must be a number or null.`);
    }
    if (key === 'expectedAnchorRank' && kind !== 'before' && kind !== 'after') {
      throw new QueueMoveError(
        400,
        'invalid_request',
        'expectedAnchorRank only applies with before or after.',
      );
    }
    request[key] = input[key];
  }
  return request;
}

function notMovableMessage(entry) {
  if (
    entry.status === 'running' ||
    entry.status === 'finalizing' ||
    entry.status === 'submitting'
  ) {
    return 'A render that is already running cannot be moved.';
  }
  if (entry.status === 'preparing') {
    return 'A render that is being prepared cannot be moved.';
  }
  if (entry.status === 'interrupted' || entry.status === 'needs_attention') {
    return 'A render that needs attention cannot be moved. Retry or resolve it first.';
  }
  if (WAITING_STATUSES.includes(entry.status)) {
    return 'A render that already has an engine job cannot be moved.';
  }
  return 'Only waiting renders can be moved.';
}

/**
 * Plans where a waiting render goes. Pure: it reads and returns arrays only.
 *
 * Rules: renders that are not waiting (running, preparing, needing attention) never move and keep
 * their place. A chained render that still waits for its source cannot be placed ahead of that
 * source, so it is put directly after it. When a render is moved behind renders that wait for its
 * output, those renders are carried along and stay behind it, in their original order.
 *
 * @param {Array<{id: string, status: string, movable: boolean, parentId: string|null}>} entries
 *   Every open job in queue order.
 * @param {string} id The job to move.
 * @param {{kind: string, value: string}} spec A parsed move request.
 * @returns {{moved: boolean, order: string[], block: string[], clamped: string|null,
 *   carried: string[], from: number, to: number, count: number, note: string}}
 *   `order` is the whole open queue afterwards, `block` the ids that get new ranks (the moved
 *   job first, then carried jobs), `from`/`to` the 1-based places among waiting renders.
 */
export function planMove(entries, id, spec) {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new QueueMoveError(404, 'not_found', 'That render is not in the queue.');
  }
  const self = entries[index];
  if (!self.movable) {
    throw new QueueMoveError(409, 'not_movable', notMovableMessage(self));
  }
  const waiting = entries.filter((entry) => entry.movable);
  const place = waiting.indexOf(self);
  const rest = entries.filter((entry) => entry.id !== id);
  const firstWaiting = rest.findIndex((entry) => entry.movable);
  let lastWaiting = -1;
  rest.forEach((entry, position) => {
    if (entry.movable) {
      lastWaiting = position;
    }
  });
  let at = index;
  let note = '';
  if (spec.kind === 'to') {
    if (spec.value === 'end') {
      at = lastWaiting < 0 ? index : lastWaiting + 1;
    } else {
      at = firstWaiting < 0 ? index : firstWaiting;
    }
  } else if (spec.kind === 'before' || spec.kind === 'after') {
    if (spec.value === id) {
      throw new QueueMoveError(400, 'invalid_request', 'A render cannot be moved next to itself.');
    }
    const anchor = rest.findIndex((entry) => entry.id === spec.value);
    if (anchor < 0) {
      throw new QueueMoveError(
        404,
        'anchor_not_found',
        'The render to move next to is not in the queue.',
      );
    }
    if (!rest[anchor].movable) {
      throw new QueueMoveError(
        409,
        'anchor_not_movable',
        'Renders can only be placed next to other waiting renders.',
      );
    }
    at = spec.kind === 'before' ? anchor : anchor + 1;
  } else if (spec.value === 'up') {
    at = place === 0 ? index : rest.findIndex((entry) => entry.id === waiting[place - 1].id);
  } else {
    at =
      place === waiting.length - 1
        ? index
        : rest.findIndex((entry) => entry.id === waiting[place + 1].id) + 1;
  }
  let clamped = null;
  if (self.parentId) {
    const parent = rest.findIndex((entry) => entry.id === self.parentId);
    if (parent >= 0 && at <= parent) {
      at = parent + 1;
      clamped = self.parentId;
      note = 'It uses the result of an earlier render, so it was placed right after that render.';
    }
  }
  // Renders still waiting on this one's output must stay behind it.
  const descendants = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of rest) {
      if (entry.movable && entry.parentId && descendants.has(entry.parentId)) {
        if (!descendants.has(entry.id)) {
          descendants.add(entry.id);
          grew = true;
        }
      }
    }
  }
  descendants.delete(id);
  const carried = rest
    .filter((entry, position) => descendants.has(entry.id) && position < at)
    .map((entry) => entry.id);
  let remaining = rest;
  if (carried.length) {
    const shift = carried.length;
    remaining = rest.filter((entry) => !carried.includes(entry.id));
    at -= shift;
    note =
      `${note} ${shift === 1 ? '1 render' : `${shift} renders`} that use${shift === 1 ? 's' : ''} its result moved with it.`.trim();
  }
  const block = [id, ...carried];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const planned = [
    ...remaining.slice(0, at),
    ...block.map((blockId) => byId.get(blockId)),
    ...remaining.slice(at),
  ].map((entry) => entry.id);
  // Only the order among waiting renders is the caller's business: renders that cannot move keep
  // their place, so a move that leaves the waiting sequence as it was changes nothing.
  const waitingAfter = planned.filter((entryId) => byId.get(entryId).movable);
  const moved = waitingAfter.some((entryId, position) => entryId !== waiting[position].id);
  return {
    moved,
    order: moved ? planned : entries.map((entry) => entry.id),
    block,
    clamped,
    carried,
    from: place + 1,
    to: moved ? waitingAfter.indexOf(id) + 1 : place + 1,
    count: waiting.length,
    note,
  };
}

// Ranks for `count` jobs placed in order between two neighbours (either may be missing).
// Returns null when the neighbours leave no room, which means the queue needs renumbering.
export function ranksBetween(previous, next, count) {
  const hasPrevious = Number.isFinite(previous);
  const hasNext = Number.isFinite(next);
  if (!hasPrevious && !hasNext) {
    return Array.from({ length: count }, (_, position) => (position + 1) * RANK_STEP);
  }
  if (!hasNext) {
    return Array.from({ length: count }, (_, position) => previous + position + 1);
  }
  if (!hasPrevious) {
    return Array.from({ length: count }, (_, position) => next - count + position);
  }
  const step = (next - previous) / (count + 1);
  if (!(step >= MIN_RANK_GAP)) {
    return null;
  }
  return Array.from({ length: count }, (_, position) => previous + step * (position + 1));
}

function openEntries(db) {
  return db
    .prepare(
      `SELECT id,status,remote_id,depends_on,queue_rank,COALESCE(queue_rank,rowid) AS rank_value,
        CASE WHEN depends_on IS NULL THEN NULL ELSE request END AS chain_request
        FROM jobs WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})
        ORDER BY ${QUEUE_ORDER_SQL}`,
    )
    .all(...OPEN_STATUSES)
    .map((row) => {
      let waitingOnSource = false;
      if (row.depends_on && row.chain_request) {
        try {
          const from = JSON.parse(row.chain_request).referenceFrom;
          waitingOnSource = !!from && typeof from.output !== 'string';
        } catch (error) {
          log.debug('queue.chain.parse.failed', { jobId: row.id, error });
          waitingOnSource = false;
        }
      }
      return {
        id: row.id,
        status: row.status,
        movable: WAITING_STATUSES.includes(row.status) && row.remote_id === null,
        parentId: waitingOnSource ? row.depends_on : null,
        rank: row.rank_value,
        queueRank: row.queue_rank ?? null,
      };
    });
}

/**
 * The waiting renders in the order the scheduler will take them, with each stored rank
 * (`null` for rows from before ranks existed).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{order: string[], ranks: Record<string, number|null>}}
 */
export function waitingOrder(db) {
  const waiting = openEntries(db).filter((entry) => entry.movable);
  return {
    order: waiting.map((entry) => entry.id),
    ranks: Object.fromEntries(waiting.map((entry) => [entry.id, entry.queueRank])),
  };
}

function rollback(db) {
  try {
    db.exec('ROLLBACK');
  } catch (error) {
    log.warn('queue.transaction.rollback.failed', { error });
    console.error('Could not roll back queue move:', error.message);
  }
}

// Logs one committed move. Positions, counts and ids only: never a render's name or prompt.
function logMoveCommitted(jobId, spec, plan, renumbered) {
  log.info('queue.move.completed', {
    jobId,
    kind: spec.kind,
    wasMoved: plan.moved,
    fromPosition: plan.from,
    toPosition: plan.to,
    waitingCount: plan.count,
    carriedCount: plan.carried.length,
    wasClamped: plan.clamped !== null,
    wasRenumbered: renumbered,
  });
  if (renumbered) {
    log.info('queue.ranks.renumbered', { openCount: plan.order.length });
  } else if (plan.moved) {
    log.debug('queue.rank.written', { jobId, rankCount: plan.block.length });
  }
}

// Logs a refused move (expected, warn) or an unexpected failure (error). The error text is not
// logged: a rejection carries a stable code, and other failures keep only the error's class.
function logMoveFailed(jobId, error) {
  if (error instanceof QueueMoveError) {
    log.warn('queue.move.rejected', { jobId, reason: error.code, status: error.status });
    return;
  }
  log.error('queue.move.failed', { jobId, error });
}

function writeRank(db, id, rank) {
  const result = db
    .prepare(
      `UPDATE jobs SET queue_rank=? WHERE id=? AND remote_id IS NULL AND status IN (${WAITING_STATUSES.map(() => '?').join(',')})`,
    )
    .run(rank, id, ...WAITING_STATUSES);
  if (result.changes !== 1) {
    throw new QueueMoveError(409, 'stale', 'The queue changed while moving this render.');
  }
}

/**
 * Moves one waiting render in a single immediate transaction. It never touches a job's status,
 * lease or claim, so a render that is already running is unaffected and the change applies to
 * the next claim only.
 *
 * `expectedRank` (the stored rank the caller last saw, or null for an older row) makes the move
 * conditional: if another tab or tool moved the render meanwhile, nothing is written and a 409
 * `stale` error carries the fresh order.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} id
 * @param {ReturnType<typeof parseMoveRequest>} spec
 * @returns {ReturnType<typeof planMove> & {renumbered: boolean, waiting: {order: string[],
 *   ranks: Record<string, number|null>}}}
 */
export function moveQueuedJob(db, id, spec) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const entries = openEntries(db);
    const self = entries.find((entry) => entry.id === id);
    if (!self) {
      const exists = db.prepare('SELECT status FROM jobs WHERE id=?').get(id);
      if (!exists) {
        throw new QueueMoveError(404, 'not_found', 'That render was not found.');
      }
      throw new QueueMoveError(409, 'not_movable', notMovableMessage({ status: exists.status }));
    }
    if (spec.expectedRank !== undefined && spec.expectedRank !== self.queueRank) {
      throw new QueueMoveError(
        409,
        'stale',
        'This render was moved somewhere else. The queue shown here is out of date.',
      );
    }
    if (spec.expectedAnchorRank !== undefined) {
      const anchor = entries.find((entry) => entry.id === spec.value);
      if (anchor && spec.expectedAnchorRank !== anchor.queueRank) {
        throw new QueueMoveError(
          409,
          'stale',
          'The render to move next to was moved somewhere else. The queue shown here is out of date.',
        );
      }
    }
    const plan = planMove(entries, id, spec);
    let renumbered = false;
    if (plan.moved) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const start = plan.order.indexOf(id);
      const previous = byId.get(plan.order[start - 1])?.rank;
      const next = byId.get(plan.order[start + plan.block.length])?.rank;
      const ranks = ranksBetween(previous, next, plan.block.length);
      if (ranks) {
        plan.block.forEach((blockId, position) => writeRank(db, blockId, ranks[position]));
      } else {
        // The neighbours are too close for a midpoint: number every open job afresh, once.
        renumbered = true;
        plan.order.forEach((openId, position) => {
          const result = db
            .prepare(
              `UPDATE jobs SET queue_rank=? WHERE id=? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
            )
            .run((position + 1) * RANK_STEP, openId, ...OPEN_STATUSES);
          if (result.changes !== 1) {
            throw new QueueMoveError(409, 'stale', 'The queue changed while moving this render.');
          }
        });
      }
    }
    const waiting = waitingOrder(db);
    db.exec('COMMIT');
    logMoveCommitted(id, spec, plan, renumbered);
    return { ...plan, renumbered, waiting };
  } catch (error) {
    rollback(db);
    if (error instanceof QueueMoveError && error.status === 409 && !error.extra) {
      error.extra = waitingOrder(db);
    }
    logMoveFailed(id, error);
    throw error;
  }
}

/**
 * Describes a move for people: "Moved Image: red fox to position 2 of 5."
 * @param {string} name Short display name of the render.
 */
export function describeMove(name, result) {
  const sentence = result.moved
    ? `Moved ${name} to position ${result.to} of ${result.count}.`
    : `${name} stays at position ${result.to} of ${result.count}.`;
  return result.note ? `${sentence} ${result.note}` : sentence;
}
