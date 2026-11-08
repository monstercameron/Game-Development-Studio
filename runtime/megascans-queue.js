// A durable import queue for Megascans files, separate from the render queue.
//
// Imports are CPU and disk work: they use no GPU, no model-load barrier and no render lease.
// State lives in `.forge-runtime/megascans.sqlite`. At most MAX_CONCURRENT_IMPORTS rows may be
// `running`; the claim step enforces that inside an immediate transaction, so two runners (or two
// processes) racing for the last slot cannot both win. A row left `running` by a crash becomes
// `interrupted` and is never restarted automatically, because Forge cannot know how far the
// extraction got. The user decides whether to retry.
import { createLogger } from './app-log.js';
import { transaction } from './megascans-db.js';

const log = createLogger('megascans');

export const MAX_CONCURRENT_IMPORTS = 2;
export const MAX_WAITING_IMPORTS = 50;
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted']);
export const RESTART_MESSAGE =
  'Forge stopped while this import was running. Retry to start it again.';

// Why a running import left the running state, as logged. Never the error text.
const FINISH_REASON_BY_STATUS = Object.freeze({
  completed: 'finished',
  failed: 'runner_error',
  cancelled: 'cancel_honored',
  interrupted: 'restart_detected',
});

export class QueueError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'QueueError';
    // log-coverage: ignore -- an HTTP status on the error object, not an import state change
    this.status = status;
  }
}

function elapsedMs(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(end - start, 0) : null;
}

// A user cancel is info (the service logs it); a failed import affects the user, so it is an error.
function finishLevel(status) {
  if (status === 'failed') {
    return 'error';
  }
  if (status === 'interrupted') {
    return 'warn';
  }
  return 'info';
}

function publicImport(row) {
  const remaining = Math.max(row.bytes_total - row.bytes_done, 0);
  const rate = row.status === 'running' && row.rate_bps > 0 ? row.rate_bps : null;
  return {
    id: row.id,
    projectId: row.project_id,
    listingId: row.listing_id,
    filename: row.filename,
    kind: row.kind,
    // 'upload' (a file the user chose) or 'fab' (downloaded by Forge from a listing).
    source: row.source,
    fileUid: row.file_uid,
    status: row.status,
    stage: row.stage,
    error: row.error,
    uploadBytes: row.upload_bytes,
    bytesDone: row.bytes_done,
    bytesTotal: row.bytes_total,
    // Bytes written per second, or null when unknown. The time left is an estimate.
    bytesPerSecond: rate,
    secondsRemaining: rate ? Math.ceil(remaining / rate) : null,
    cancelRequested: row.cancel_requested === 1,
    output: row.output ? JSON.parse(row.output) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class ImportQueue {
  /**
   * @param {{ db: import('node:sqlite').DatabaseSync }} handle
   * @param {{ maxConcurrent?: number, now?: () => Date }} [options]
   */
  constructor({ db }, { maxConcurrent = MAX_CONCURRENT_IMPORTS, now = () => new Date() } = {}) {
    this.db = db;
    this.maxConcurrent = maxConcurrent;
    this.now = now;
  }

  stamp() {
    return this.now().toISOString();
  }

  /** Turns rows left `running` by a previous process into `interrupted`. Returns the count. */
  recoverInterrupted() {
    const stamp = this.stamp();
    const result = this.db
      .prepare(
        `UPDATE imports SET status='interrupted', stage='Interrupted', error=?, finished_at=?,
           updated_at=?, rate_bps=NULL WHERE status='running'`,
      )
      .run(RESTART_MESSAGE, stamp, stamp);
    const interruptedCount = Number(result.changes);
    if (interruptedCount > 0) {
      log.info('megascans.import.recovered', { interruptedCount, to: 'interrupted' });
    }
    return interruptedCount;
  }

  enqueue({
    id,
    projectId,
    listingId = null,
    filename,
    kind,
    uploadBytes,
    source = 'upload',
    fileUid = null,
    formatCode = null,
  }) {
    const stamp = this.stamp();
    transaction(this.db, () => {
      const { count } = this.db
        .prepare("SELECT COUNT(*) AS count FROM imports WHERE status='queued'")
        .get();
      if (count >= MAX_WAITING_IMPORTS) {
        log.warn('megascans.import.rejected', {
          reason: 'too_many_waiting',
          queueLength: count,
          limit: MAX_WAITING_IMPORTS,
        });
        throw new QueueError('Too many imports are waiting. Wait for some to finish.', 429);
      }
      this.db
        .prepare(
          `INSERT INTO imports (id,project_id,listing_id,filename,kind,status,stage,upload_bytes,
             source,file_uid,format_code,created_at,updated_at)
           VALUES (?,?,?,?,?,'queued','Waiting',?,?,?,?,?,?)`,
        )
        .run(
          id,
          projectId,
          listingId,
          filename,
          kind,
          uploadBytes,
          source,
          fileUid,
          formatCode,
          stamp,
          stamp,
        );
    });
    return this.get(id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM imports WHERE id=?').get(String(id));
    return row ? publicImport(row) : null;
  }

  /** Raw row for the runner, which needs no public shaping. */
  row(id) {
    return this.db.prepare('SELECT * FROM imports WHERE id=?').get(String(id)) || null;
  }

  list({ limit = 100 } = {}) {
    return this.db
      .prepare(
        `SELECT * FROM imports ORDER BY
           CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
           CASE WHEN status IN ('running','queued') THEN created_at END ASC,
           created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map(publicImport);
  }

  summary() {
    const counts = Object.fromEntries(
      this.db
        .prepare('SELECT status, COUNT(*) AS count FROM imports GROUP BY status')
        .all()
        .map((row) => [row.status, row.count]),
    );
    return {
      running: counts.running || 0,
      queued: counts.queued || 0,
      failed: (counts.failed || 0) + (counts.interrupted || 0),
      completed: counts.completed || 0,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * Claims the oldest waiting import if a slot is free. The slot count and the status change
   * happen in one immediate transaction.
   * @returns {object | null} The raw row, now `running`, or null when nothing can start.
   */
  claimNext() {
    let runningCount = 0;
    const claimed = transaction(this.db, () => {
      const { count } = this.db
        .prepare("SELECT COUNT(*) AS count FROM imports WHERE status='running'")
        .get();
      if (count >= this.maxConcurrent) {
        return null;
      }
      const next = this.db
        .prepare("SELECT id FROM imports WHERE status='queued' ORDER BY created_at, rowid LIMIT 1")
        .get();
      if (!next) {
        return null;
      }
      const stamp = this.stamp();
      // log-coverage: ignore -- the started event is logged by claimNext after the commit
      this.db
        .prepare(
          `UPDATE imports SET status='running', stage='Starting', started_at=?, finished_at=NULL,
             updated_at=?, error=NULL, bytes_done=0, rate_bps=NULL WHERE id=?`,
        )
        .run(stamp, stamp, next.id);
      runningCount = count + 1;
      return this.row(next.id);
    });
    // Logged after the commit, so a rolled-back claim is never reported as started.
    if (claimed) {
      log.info('megascans.import.started', {
        importId: claimed.id,
        kind: claimed.kind,
        source: claimed.source,
        from: 'queued',
        to: 'running',
        runningCount,
        limit: this.maxConcurrent,
      });
    }
    return claimed;
  }

  /** Records progress of a running import. Ignored once it left `running`. */
  setProgress(id, { bytesDone, bytesTotal, bytesPerSecond, stage }) {
    // log-coverage: ignore -- progress tick once per chunk; the status is only a guard, not a change
    this.db
      .prepare(
        `UPDATE imports SET bytes_done=?, bytes_total=?, rate_bps=?, stage=?, updated_at=?
         WHERE id=? AND status='running'`,
      )
      .run(
        Math.max(Math.trunc(bytesDone) || 0, 0),
        Math.max(Math.trunc(bytesTotal) || 0, 0),
        Number.isFinite(bytesPerSecond) ? bytesPerSecond : null,
        stage || null,
        this.stamp(),
        id,
      );
  }

  /**
   * Moves a running import to a final status. Only a row still `running` changes, so a late
   * result from a runner that lost its row (or was cancelled) is ignored.
   * @returns {boolean} True when this call made the change.
   */
  finish(id, status, { error = null, output = null, stage = null } = {}) {
    const stamp = this.stamp();
    const before = this.row(id);
    const result = this.db
      .prepare(
        `UPDATE imports SET status=?, stage=?, error=?, output=?, finished_at=?, updated_at=?,
           rate_bps=NULL, bytes_done=CASE WHEN ?='completed' THEN bytes_total ELSE bytes_done END
         WHERE id=? AND status='running'`,
      )
      .run(
        status,
        stage || status,
        error,
        output ? JSON.stringify(output) : null,
        stamp,
        stamp,
        status,
        id,
      );
    const isChanged = Number(result.changes) > 0;
    if (isChanged) {
      log[finishLevel(status)]('megascans.import.state.changed', {
        importId: id,
        from: 'running',
        to: status,
        reason: FINISH_REASON_BY_STATUS[status] || 'finished',
        durationMs: elapsedMs(before?.started_at, stamp),
        bytesTotal: before?.bytes_total,
      });
      log.debug('megascans.import.slot.released', { importId: id, to: status });
    }
    return isChanged;
  }

  complete(id, output) {
    return this.finish(id, 'completed', { output, stage: 'Completed' });
  }

  fail(id, message) {
    // The stored error is capped at 500 characters so one message cannot bloat the row.
    return this.finish(id, 'failed', { error: String(message).slice(0, 500), stage: 'Failed' });
  }

  markCancelled(id) {
    return this.finish(id, 'cancelled', { stage: 'Cancelled' });
  }

  /**
   * Cancels a waiting import at once, or asks a running one to stop.
   * @returns {{ import: object, wasRunning: boolean }}
   */
  cancel(id) {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) {
        log.warn('megascans.import.rejected', { reason: 'not_found', operation: 'cancel' });
        throw new QueueError('Import not found.', 404);
      }
      const stamp = this.stamp();
      if (row.status === 'queued') {
        this.db
          .prepare(
            `UPDATE imports SET status='cancelled', stage='Cancelled', finished_at=?, updated_at=?
             WHERE id=?`,
          )
          .run(stamp, stamp, id);
        log.debug('megascans.import.state.changed', {
          importId: id,
          from: 'queued',
          to: 'cancelled',
          reason: 'cancel_waiting',
        });
        return { import: this.get(id), wasRunning: false };
      }
      if (row.status === 'running') {
        this.db
          .prepare(
            "UPDATE imports SET cancel_requested=1, stage='Cancelling', updated_at=? WHERE id=?",
          )
          .run(stamp, id);
        log.debug('megascans.import.cancel.requested', { importId: id, from: 'running' });
        return { import: this.get(id), wasRunning: true };
      }
      log.warn('megascans.import.rejected', {
        importId: id,
        reason: 'already_finished',
        status: row.status,
      });
      throw new QueueError('This import already finished.');
    });
  }

  /** Puts a failed, interrupted or cancelled import back in line. */
  retry(id) {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) {
        log.warn('megascans.import.rejected', { reason: 'not_found', operation: 'retry' });
        throw new QueueError('Import not found.', 404);
      }
      if (!['failed', 'interrupted', 'cancelled'].includes(row.status)) {
        log.warn('megascans.import.rejected', {
          importId: id,
          reason: 'not_retryable',
          status: row.status,
        });
        throw new QueueError('Only failed, interrupted or cancelled imports can be retried.');
      }
      const stamp = this.stamp();
      this.db
        .prepare(
          `UPDATE imports SET status='queued', stage='Waiting', error=NULL, output=NULL,
             cancel_requested=0, bytes_done=0, bytes_total=0, rate_bps=NULL, started_at=NULL,
             finished_at=NULL, created_at=?, updated_at=? WHERE id=?`,
        )
        .run(stamp, stamp, id);
      return this.get(id);
    });
  }

  /** Deletes the record of a finished import. Returns the raw row so staging can be removed. */
  dismiss(id) {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) {
        log.warn('megascans.import.rejected', { reason: 'not_found', operation: 'dismiss' });
        throw new QueueError('Import not found.', 404);
      }
      if (ACTIVE_STATUSES.includes(row.status)) {
        log.warn('megascans.import.rejected', {
          importId: id,
          reason: 'still_active',
          status: row.status,
        });
        throw new QueueError('Cancel this import before dismissing it.');
      }
      this.db.prepare('DELETE FROM imports WHERE id=?').run(id);
      log.debug('megascans.import.dismissed', { importId: id, status: row.status });
      return row;
    });
  }

  isCancelRequested(id) {
    return this.row(id)?.cancel_requested === 1;
  }

  /** Imports saved from one listing, for its detail view. */
  forListing(listingId) {
    return this.db
      .prepare('SELECT * FROM imports WHERE listing_id=? ORDER BY created_at DESC LIMIT 20')
      .all(String(listingId))
      .map(publicImport);
  }
}
