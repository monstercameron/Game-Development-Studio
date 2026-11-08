// A durable import queue for Megascans files, separate from the render queue.
//
// Imports are CPU and disk work: they use no GPU, no model-load barrier and no render lease.
// State lives in `.forge-runtime/megascans.sqlite`. At most MAX_CONCURRENT_IMPORTS rows may be
// `running`; the claim step enforces that inside an immediate transaction, so two runners (or two
// processes) racing for the last slot cannot both win. A row left `running` by a crash becomes
// `interrupted` and is never restarted automatically, because Forge cannot know how far the
// extraction got. The user decides whether to retry.
import { transaction } from './megascans-db.js';

export const MAX_CONCURRENT_IMPORTS = 2;
export const MAX_WAITING_IMPORTS = 50;
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'interrupted']);
export const RESTART_MESSAGE =
  'Forge stopped while this import was running. Retry to start it again.';

export class QueueError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'QueueError';
    this.status = status;
  }
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
    return Number(result.changes);
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
    return transaction(this.db, () => {
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
      this.db
        .prepare(
          `UPDATE imports SET status='running', stage='Starting', started_at=?, finished_at=NULL,
             updated_at=?, error=NULL, bytes_done=0, rate_bps=NULL WHERE id=?`,
        )
        .run(stamp, stamp, next.id);
      return this.row(next.id);
    });
  }

  /** Records progress of a running import. Ignored once it left `running`. */
  setProgress(id, { bytesDone, bytesTotal, bytesPerSecond, stage }) {
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

  finish(id, status, { error = null, output = null, stage = null } = {}) {
    const stamp = this.stamp();
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
    return Number(result.changes) > 0;
  }

  complete(id, output) {
    return this.finish(id, 'completed', { output, stage: 'Completed' });
  }

  fail(id, message) {
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
        return { import: this.get(id), wasRunning: false };
      }
      if (row.status === 'running') {
        this.db
          .prepare(
            "UPDATE imports SET cancel_requested=1, stage='Cancelling', updated_at=? WHERE id=?",
          )
          .run(stamp, id);
        return { import: this.get(id), wasRunning: true };
      }
      throw new QueueError('This import already finished.');
    });
  }

  /** Puts a failed, interrupted or cancelled import back in line. */
  retry(id) {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row) {
        throw new QueueError('Import not found.', 404);
      }
      if (!['failed', 'interrupted', 'cancelled'].includes(row.status)) {
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
        throw new QueueError('Import not found.', 404);
      }
      if (ACTIVE_STATUSES.includes(row.status)) {
        throw new QueueError('Cancel this import before dismissing it.');
      }
      this.db.prepare('DELETE FROM imports WHERE id=?').run(id);
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
