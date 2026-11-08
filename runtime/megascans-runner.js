// Runs queued Megascans imports and Fab downloads, at most MAX_CONCURRENT_IMPORTS at a time.
//
// The queue's claim step enforces the cap atomically; this class only starts what was claimed.
// A failed, cancelled or interrupted import keeps its staged upload so the user can retry it.
// Only completion and dismissal remove the staged upload.
import fs from 'node:fs/promises';
import path from 'node:path';
import { FabBlockedError, FabError } from './megascans-fab.js';
import { downloadFabFile } from './megascans-download.js';
import { ImportError, extensionOf, runImport } from './megascans-import.js';
import { recordMegascansImport } from './megascans-metadata.js';
import { createLogger } from './app-log.js';

const log = createLogger('megascans');

/** The hidden per-import folder inside the project; same volume as the final location. */
export function stagingDirectory(projectFolder, importId) {
  return path.join(projectFolder, '.forge-staging', 'megascans', importId);
}

/**
 * Path of the staged upload. The filename's extension is kept so the importer can tell the
 * archive type; the file itself lives in the import's staging folder.
 */
export function uploadFile(projectFolder, importId, filename) {
  return path.join(stagingDirectory(projectFolder, importId), `upload${extensionOf(filename)}`);
}

/**
 * @typedef {{ id: string, name: string, folder: string }} ResolvedProject
 */

export class ImportRunner {
  /**
   * @param {object} options
   * @param {import('./megascans-queue.js').ImportQueue} options.queue
   * @param {import('./megascans-library.js').MegascansLibrary} options.library
   * @param {(projectId: string) => Promise<ResolvedProject | null>} options.resolveProject
   * @param {Console} [options.logger]
   * @param {typeof runImport} [options.importFile] Replaceable in tests.
   * @param {number} [options.progressIntervalMs]
   * @param {import('./megascans-fab.js').FabClient | null} [options.client] Needed for downloads.
   * @param {(error: Error) => void} [options.onBlocked] Called when Fab or its CDN refuses Forge.
   * @param {() => boolean} [options.isBlocked] True while Fab requests are paused.
   * @param {typeof downloadFabFile} [options.downloadFile] Replaceable in tests.
   */
  constructor({
    queue,
    library,
    resolveProject,
    logger = console,
    importFile = runImport,
    progressIntervalMs = 400,
    client = null,
    onBlocked = () => {},
    isBlocked = () => false,
    downloadFile = downloadFabFile,
  }) {
    this.client = client;
    this.onBlocked = onBlocked;
    this.isBlocked = isBlocked;
    this.downloadFile = downloadFile;
    this.queue = queue;
    this.library = library;
    this.resolveProject = resolveProject;
    this.logger = logger;
    this.importFile = importFile;
    this.progressIntervalMs = progressIntervalMs;
    this.controllers = new Map();
    this.running = new Set();
    this.stopped = false;
  }

  /** Starts as many waiting imports as the queue allows. */
  pump() {
    while (!this.stopped) {
      let row;
      try {
        row = this.queue.claimNext();
      } catch (error) {
        log.error('megascans.queue.claim.failed', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
        this.logger.error('Megascans queue claim failed:', error.message);
        return;
      }
      if (!row) {
        return;
      }
      const controller = new AbortController();
      this.controllers.set(row.id, controller);
      const work = this.execute(row, controller)
        .catch((error) => {
          log.error('megascans.runner.crashed', {
            errorClass: error?.name,
            errorCode: error?.code,
          });
          this.logger.error('Megascans import crashed:', error.message);
        })
        .finally(() => {
          this.controllers.delete(row.id);
          this.running.delete(work);
          this.pump();
        });
      this.running.add(work);
    }
  }

  /** Asks a running import in this process to stop. */
  cancel(id) {
    this.controllers.get(id)?.abort();
  }

  /** Resolves when every started import has settled. */
  async idle() {
    while (this.running.size) {
      await Promise.all([...this.running]);
    }
  }

  stop() {
    this.stopped = true;
    log.info('megascans.runner.stopped', { activeCount: this.controllers.size });
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
  }

  /**
   * Downloads the file of a 'fab' row into the staging folder.
   * @returns {Promise<'done' | 'cancelled' | string>} A failure message when it did not finish.
   */
  async fetchFromFab(row, { project, staging, upload, signal, onProgress }) {
    if (!this.client || !row.listing_id || !row.file_uid || !row.format_code) {
      return 'This download is missing its file details. Start it again from the listing.';
    }
    if (this.isBlocked()) {
      return 'Fab is blocking automated requests. Try again later, or download from Fab yourself and use Import.';
    }
    try {
      await fs.mkdir(staging, { recursive: true });
      const real = await fs.realpath(staging);
      const relative = path.relative(project.folder, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return 'The project staging folder is not usable.';
      }
      await this.downloadFile({
        client: this.client,
        listingId: row.listing_id,
        file: { uid: row.file_uid, formatCode: row.format_code, size: row.upload_bytes || null },
        partPath: `${upload}.part`,
        finalPath: upload,
        signal,
        onProgress,
      });
      return 'done';
    } catch (error) {
      if (error?.name === 'AbortError' || signal.aborted) {
        return 'cancelled';
      }
      if (error instanceof FabBlockedError) {
        log.warn('megascans.download.blocked', { importId: row.id, httpStatus: error.status });
        this.onBlocked(error);
        return 'Fab is blocking automated requests. Try again later, or download from Fab yourself and use Import.';
      }
      if (error instanceof FabError) {
        return error.message;
      }
      // Never put the underlying error (it could include a signed address) in the page.
      this.logger.error('Megascans download failed:', error?.name);
      return 'The download failed unexpectedly. Check Diagnostics.';
    }
  }

  async execute(row, controller) {
    const { signal } = controller;
    const startedAt = Date.now();
    log.info('megascans.runner.started', { importId: row.id, source: row.source });
    const project = await this.resolveProject(row.project_id);
    if (!project) {
      log.warn('megascans.import.failed', { importId: row.id, reason: 'project_missing' });
      this.queue.fail(row.id, 'The project for this import no longer exists.');
      return;
    }
    const staging = stagingDirectory(project.folder, row.id);
    const upload = uploadFile(project.folder, row.id, row.filename);
    const listing = row.listing_id ? this.library.get(row.listing_id) : null;
    let lastWrite = 0;
    let phase = { stage: '', at: Date.now(), base: 0 };
    const onProgress = ({ bytesDone, bytesTotal, stage }) => {
      const now = Date.now();
      if (stage !== phase.stage) {
        // Speed is measured within one phase (download, then extraction).
        phase = { stage, at: now, base: bytesDone };
      }
      if (now - lastWrite < this.progressIntervalMs) {
        return;
      }
      lastWrite = now;
      const seconds = (now - phase.at) / 1000;
      this.queue.setProgress(row.id, {
        bytesDone,
        bytesTotal,
        stage,
        bytesPerSecond: seconds > 0.5 ? (bytesDone - phase.base) / seconds : null,
      });
      // Another process may have asked for the cancel; this process owns the work.
      if (this.queue.isCancelRequested(row.id)) {
        controller.abort();
      }
    };
    if (row.source === 'fab') {
      const outcome = await this.fetchFromFab(row, {
        project,
        staging,
        upload,
        signal,
        onProgress,
      });
      if (outcome === 'cancelled') {
        log.info('megascans.import.cancelled', {
          importId: row.id,
          durationMs: Date.now() - startedAt,
        });
        this.queue.markCancelled(row.id);
        return;
      }
      if (outcome !== 'done') {
        log.warn('megascans.import.failed', { importId: row.id, reason: 'download_failed' });
        this.queue.fail(row.id, outcome);
        return;
      }
    } else {
      try {
        await fs.access(upload);
      } catch (error) {
        log.warn('megascans.import.failed', {
          importId: row.id,
          reason: 'upload_missing',
          errorCode: error?.code,
        });
        this.queue.fail(row.id, 'The uploaded file is gone. Choose the file again.');
        return;
      }
    }
    try {
      const result = await this.importFile({
        id: row.id,
        projectFolder: project.folder,
        uploadPath: upload,
        stagingDirectory: staging,
        filename: row.filename,
        title: listing?.title || '',
        signal,
        onProgress,
      });
      let recorded = 0;
      try {
        recorded = recordMegascansImport(
          project.folder,
          result.files,
          {
            listing,
            filename: row.filename,
            title: result.suggestedTitle,
            fileUid: row.source === 'fab' ? row.file_uid : null,
          },
          { logger: this.logger },
        );
      } catch (error) {
        log.warn('megascans.provenance.record.failed', {
          importId: row.id,
          errorClass: error?.name,
          errorCode: error?.code,
        });
        this.logger.warn('Megascans provenance record failed:', error.message);
      }
      this.queue.setProgress(row.id, {
        bytesDone: result.bytes,
        bytesTotal: result.bytes,
        stage: 'Saved',
      });
      // The staged upload is consumed once the files are in the project, so remove it before the
      // import reads as completed.
      await fs.rm(staging, { recursive: true, force: true }).catch((error) => {
        log.debug('megascans.staging.remove.failed', {
          importId: row.id,
          errorClass: error?.name,
          errorCode: error?.code,
        });
      });
      this.queue.complete(row.id, {
        files: result.files,
        folder: result.folder,
        skipped: result.skipped,
        bytes: result.bytes,
        detailsRecorded: recorded === result.files.length,
      });
      log.info('megascans.import.completed', {
        importId: row.id,
        fileCount: result.files.length,
        skippedCount: result.skipped,
        bytes: result.bytes,
        isDetailsRecorded: recorded === result.files.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || signal.aborted) {
        log.info('megascans.import.cancelled', {
          importId: row.id,
          durationMs: Date.now() - startedAt,
        });
        this.queue.markCancelled(row.id);
      } else if (error instanceof ImportError) {
        log.warn('megascans.import.failed', {
          importId: row.id,
          reason: error.reason,
          durationMs: Date.now() - startedAt,
        });
        this.queue.fail(row.id, error.message);
      } else {
        log.error('megascans.import.failed', {
          importId: row.id,
          errorClass: error?.name,
          errorCode: error?.code,
          durationMs: Date.now() - startedAt,
        });
        this.logger.error('Megascans import failed:', error?.message);
        this.queue.fail(row.id, 'The import failed unexpectedly. Check Diagnostics.');
      }
      // runImport already removed its work folder; only the staged upload remains for a retry.
    }
  }
}
