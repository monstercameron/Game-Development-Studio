// HTTP routes for the Megascans page: the Fab cache, the local library and the import queue.
//
// Everything is loopback-only. Writes need the studio Origin and `X-Forge-Request: megascans`,
// like the project and credential routes. The only outbound requests are the polite, read-only
// ones made by megascans-sync.js and megascans-thumbs.js, and only when the user asks (Refresh,
// Scan, opening a listing) or a thumbnail is displayed. Files arrive as uploads from the user's
// browser. See docs/MEGASCANS.md.
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { openMegascansDb, ValidatorStore } from './megascans-db.js';
import {
  FAB_SELLER,
  FAB_SELLER_URL,
  LIBRARY_LIMITS,
  LibraryError,
  MegascansLibrary,
  parseFabListing,
} from './megascans-library.js';
import { ImportQueue, MAX_CONCURRENT_IMPORTS, QueueError } from './megascans-queue.js';
import {
  IMPORT_LIMITS,
  ImportError,
  UPLOAD_EXTENSIONS,
  cleanUploadName,
  ensureFreeSpace,
  extensionOf,
} from './megascans-import.js';
import { ImportRunner, stagingDirectory, uploadFile } from './megascans-runner.js';
import { FabBlockedError, FabClient, FabError, FabSource } from './megascans-fab.js';
import { FabSync, SyncError } from './megascans-sync.js';
import { ThumbnailCache } from './megascans-thumbs.js';
import { pickFile } from './megascans-files.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_METADATA = '.forge-project.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const ORPHAN_AGE_MS = 60 * 60 * 1000;

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function isLocalRequest(req) {
  return LOCAL_HOST.test(req.headers.host || '');
}

function isLocalWrite(req) {
  const host = req.headers.host;
  return (
    isLocalRequest(req) &&
    req.headers.origin === `http://${host}` &&
    req.headers['x-forge-request'] === 'megascans'
  );
}

async function readJson(req, limit = 20000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) {
      throw new LibraryError('Request too large.', 413);
    }
  }
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new LibraryError('Invalid request body.', 400);
  }
}

/** Finds a project by its id. Only real folders directly inside the projects root count. */
export function createProjectResolver(projectsRoot) {
  return async function resolveProject(projectId) {
    if (!UUID.test(String(projectId))) {
      return null;
    }
    let entries;
    try {
      entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const folder = path.join(projectsRoot, entry.name);
      try {
        const meta = JSON.parse(await fs.readFile(path.join(folder, PROJECT_METADATA), 'utf8'));
        if (typeof meta.id === 'string' && meta.id.toLowerCase() === projectId.toLowerCase()) {
          return { id: meta.id, name: String(meta.name || ''), folder: await fs.realpath(folder) };
        }
      } catch {
        continue;
      }
    }
    return null;
  };
}

/** Creates the staging folder for one upload and proves it stayed inside the project. */
async function prepareStaging(project, importId) {
  const directory = stagingDirectory(project.folder, importId);
  await fs.mkdir(directory, { recursive: true });
  const real = await fs.realpath(directory);
  const relative = path.relative(project.folder, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new ImportError('The project staging folder is not usable.');
  }
  return directory;
}

function limitedStream(limit, counter) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      counter.bytes += chunk.length;
      if (counter.bytes > limit) {
        const error = new ImportError('The file is larger than the import limit.');
        error.status = 413;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Removes staging folders that no queue row owns, left by a crash during an upload. */
export async function sweepOrphanStaging(
  projectsRoot,
  knownIds,
  { maxAgeMs = ORPHAN_AGE_MS } = {},
) {
  let projects;
  try {
    projects = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) {
      continue;
    }
    const root = path.join(projectsRoot, project.name, '.forge-staging', 'megascans');
    let children;
    try {
      children = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink() || knownIds.has(child.name)) {
        continue;
      }
      const target = path.join(root, child.name);
      const stat = await fs.stat(target).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > maxAgeMs) {
        await fs.rm(target, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

/**
 * @param {object} [options]
 * @param {string} [options.directory] Runtime folder for megascans.sqlite.
 * @param {string} [options.projectsRoot] Folder that holds the projects.
 * @param {number} [options.maxUploadBytes] Upload cap, overridable in tests.
 * @param {number} [options.maxConcurrent] Simultaneous imports, overridable in tests.
 * @param {Console} [options.logger]
 */
export function megascansService(options = {}) {
  const projectsRoot =
    options.projectsRoot || process.env.FORGE_PROJECTS_DIR || path.join(appRoot, 'projects');
  const maxUploadBytes = options.maxUploadBytes ?? IMPORT_LIMITS.maxUploadBytes;
  const logger = options.logger || console;
  const resolveProject = createProjectResolver(projectsRoot);
  let state = null;
  let startupError = null;

  function start() {
    if (state || startupError) {
      return state;
    }
    try {
      const handle = openMegascansDb(options.directory);
      const library = new MegascansLibrary(handle);
      const queue = new ImportQueue(handle, { maxConcurrent: options.maxConcurrent });
      const client = new FabClient({
        baseUrl: options.fabBaseUrl,
        imageHosts: options.fabImageHosts,
        minIntervalMs: options.fabMinIntervalMs,
        imageIntervalMs: options.fabImageIntervalMs,
        sleep: options.sleep,
        cdnHosts: options.cdnHosts,
        allowInsecureCdn: options.allowInsecureCdn,
      });
      client.validators = new ValidatorStore(handle.db);
      const sync = new FabSync({
        handle,
        library,
        source: new FabSource(client),
        logger,
        scanMaxPages: options.scanMaxPages,
      });
      sync.recoverScan();
      const runner = new ImportRunner({
        queue,
        library,
        resolveProject,
        logger,
        client,
        isBlocked: () => Boolean(sync.block()),
        onBlocked: (error) => sync.recordBlock(error),
      });
      const thumbs = new ThumbnailCache({
        client,
        library,
        directory: options.thumbsDirectory,
        isBlocked: () => Boolean(sync.block()),
        onBlocked: (error) => sync.recordBlock(error),
        logger,
      });
      const interrupted = queue.recoverInterrupted();
      if (interrupted) {
        logger.warn(`Megascans: ${interrupted} import(s) were interrupted by a restart.`);
      }
      state = { handle, library, queue, runner, sync, thumbs, client };
      const known = new Set(queue.list({ limit: 1000 }).map((item) => item.id));
      sweepOrphanStaging(projectsRoot, known).catch((error) =>
        logger.warn('Megascans staging sweep failed:', error.message),
      );
      runner.pump();
    } catch (error) {
      startupError = error;
      logger.error('Megascans database could not be opened:', error.message);
    }
    return state;
  }

  /** Queues a download of one file Fab lists. The file's name and size come from the cache. */
  async function handleDownload(req, res) {
    const { library, queue, runner, sync } = state;
    if (!sync.eula().confirmed) {
      return send(res, 403, {
        error:
          'Confirm that you accept the Fab license agreement on the Megascans page before downloading.',
        needsConfirmation: true,
      });
    }
    sync.assertNotBlocked();
    const body = await readJson(req);
    const projectId = typeof body.project === 'string' ? body.project : '';
    const listingId = parseFabListing(body.listing)?.id;
    if (!UUID.test(projectId) || !listingId) {
      return send(res, 400, { error: 'Choose a project and a listing.' });
    }
    const project = await resolveProject(projectId);
    if (!project) {
      return send(res, 404, { error: 'Project not found.' });
    }
    if (library.get(listingId)?.source !== 'fab') {
      return send(res, 404, { error: 'That listing was not read from Fab yet.' });
    }
    // Reads the file list from Fab when the cache lacks it (a paced request, never the download).
    const { listing } = await sync.loadDetail(listingId);
    const file = pickFile(listing.detail, {
      fileUid: body.fileUid,
      format: body.format,
      quality: body.quality,
    });
    if (!file) {
      return send(res, 404, { error: 'That file is not offered for this listing.' });
    }
    if (!file.importable) {
      return send(res, 400, {
        error: 'Forge cannot import that kind of file. Choose a GLB, glTF or FBX file.',
      });
    }
    if (file.isLarge && body.confirmLarge !== true) {
      return send(res, 400, {
        error: `That file is ${Math.round(file.size / 1024 ** 2)} MB. Confirm that you want such a large download.`,
        needsLargeConfirmation: true,
      });
    }
    if (!file.size || file.size > maxUploadBytes) {
      return send(res, 400, { error: 'That file is larger than the import limit.' });
    }
    const duplicate = queue
      .list({ limit: 200 })
      .find(
        (item) =>
          item.fileUid === file.uid &&
          item.projectId === project.id &&
          ['queued', 'running'].includes(item.status),
      );
    if (duplicate) {
      return send(res, 409, { error: 'This file is already downloading or waiting.' });
    }
    await ensureFreeSpace(project.folder, file.size);
    const item = queue.enqueue({
      id: randomUUID(),
      projectId: project.id,
      listingId,
      filename: file.name,
      kind: extensionOf(file.name) === '.zip' ? 'archive' : 'model',
      uploadBytes: file.size,
      source: 'fab',
      fileUid: file.uid,
      formatCode: file.formatCode,
    });
    runner.pump();
    return send(res, 201, { import: item });
  }

  async function handleUpload(req, res, url) {
    const { library, queue, runner } = state;
    const projectId = url.searchParams.get('project') || '';
    if (!UUID.test(projectId)) {
      return send(res, 400, { error: 'Choose a project first.' });
    }
    let filename;
    try {
      filename = cleanUploadName(url.searchParams.get('filename'));
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
    let listingId = null;
    if (url.searchParams.get('listing')) {
      listingId = parseFabListing(url.searchParams.get('listing'))?.id || null;
      if (!listingId || !library.get(listingId)) {
        return send(res, 404, { error: 'That listing is not in the library.' });
      }
    }
    const declared = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared <= 0) {
      return send(res, 411, { error: 'The upload needs a known size.' });
    }
    if (declared > maxUploadBytes) {
      res.setHeader('Connection', 'close');
      res.on('finish', () => req.destroy());
      return send(res, 413, {
        error: `The file is larger than the ${Math.round(maxUploadBytes / 1024 ** 2)} MiB import limit.`,
      });
    }
    const project = await resolveProject(projectId);
    if (!project) {
      return send(res, 404, { error: 'Project not found.' });
    }
    await ensureFreeSpace(project.folder, declared);
    const id = randomUUID();
    const directory = await prepareStaging(project, id);
    const destination = uploadFile(project.folder, id, filename);
    const counter = { bytes: 0 };
    try {
      await pipeline(
        req,
        limitedStream(maxUploadBytes, counter),
        createWriteStream(`${destination}.part`, { flags: 'wx' }),
      );
      if (counter.bytes !== declared) {
        throw new ImportError('The upload was incomplete. Try again.');
      }
      await fs.rename(`${destination}.part`, destination);
      const item = queue.enqueue({
        id,
        projectId: project.id,
        listingId,
        filename,
        kind: extensionOf(filename) === '.zip' ? 'archive' : 'model',
        uploadBytes: counter.bytes,
      });
      runner.pump();
      return send(res, 201, { import: queue.get(item.id) });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (res.headersSent || req.destroyed) {
        return undefined;
      }
      throw error;
    }
  }

  async function route(req, res, url) {
    const { library, queue, runner, sync, thumbs } = state;
    const parts = url.pathname.split('/').filter(Boolean);
    const write = req.method === 'POST';
    if (write && !isLocalWrite(req)) {
      return send(res, 403, { error: 'Local studio requests only.' });
    }
    if (req.method !== 'GET' && !write) {
      return send(res, 405, { error: 'Method not allowed.' });
    }
    if (!write && !isLocalRequest(req)) {
      return send(res, 403, { error: 'Local studio requests only.' });
    }

    if (parts.length === 1 && parts[0] === 'status' && !write) {
      return send(res, 200, {
        // Listing metadata and thumbnails are read from Fab's public JSON, slowly and cached.
        fabMetadata: true,
        // Forge downloads only after the user confirms Fab's license agreement in the page.
        automatedDownload: sync.eula().confirmed,
        downloadNote:
          'Forge downloads a file only after you confirm that you accept the Fab license agreement. Until then, download in your browser and use Import.',
        fab: sync.status(),
        seller: FAB_SELLER,
        sellerUrl: FAB_SELLER_URL,
        library: { count: library.count(), maxListings: LIBRARY_LIMITS.maxListings },
        queue: queue.summary(),
        limits: {
          maxUploadBytes,
          maxExpandedBytes: IMPORT_LIMITS.maxExpandedBytes,
          maxConcurrent: queue.maxConcurrent || MAX_CONCURRENT_IMPORTS,
          extensions: UPLOAD_EXTENSIONS,
        },
      });
    }
    if (parts[0] === 'thumbs' && parts.length === 2 && !write) {
      const image = await thumbs.get(parts[1]);
      if (!image) {
        return send(res, 404, { error: 'No preview is available.' });
      }
      res.writeHead(200, {
        'Content-Type': image.type,
        'Content-Length': image.bytes.length,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(image.bytes);
    }
    if (parts[0] === 'refresh' && parts.length === 1 && write) {
      await readJson(req);
      const result = await sync.refresh();
      return send(res, 200, { ...result, fab: sync.status() });
    }
    if (parts[0] === 'more' && parts.length === 1 && write) {
      await readJson(req);
      const result = await sync.loadMore();
      return send(res, 200, { ...result, fab: sync.status() });
    }
    if (parts[0] === 'scan' && parts.length === 1) {
      if (!write) {
        return send(res, 200, { scan: sync.scanStatus() });
      }
      const body = await readJson(req);
      if (body.action === 'cancel') {
        return send(res, 200, { scan: sync.cancelScan() });
      }
      if (body.action === 'start' || body.action === 'resume') {
        return send(res, 202, { scan: sync.startScan({ resume: body.action === 'resume' }) });
      }
      return send(res, 400, { error: 'Choose start, resume or cancel.' });
    }
    if (parts[0] === 'fab' && parts[1] === 'recheck' && parts.length === 2 && write) {
      sync.recheck();
      return send(res, 200, { fab: sync.status() });
    }
    if (parts[0] === 'listings') {
      if (parts.length === 1 && !write) {
        const params = url.searchParams;
        return send(res, 200, {
          ...library.search({
            q: params.get('q') || '',
            tag: params.get('tag') || '',
            sort: ['title', 'recent'].includes(params.get('sort')) ? params.get('sort') : 'newest',
            page: params.get('page'),
            pageSize: params.get('pageSize'),
          }),
          tags: library.tagCounts(),
        });
      }
      if (parts.length === 1 && write) {
        return send(res, 201, { listing: library.upsert(await readJson(req)) });
      }
      const id = parseFabListing(parts[1])?.id;
      if (!id) {
        return send(res, 404, { error: 'Listing not found.' });
      }
      if (parts.length === 2 && !write) {
        const listing = library.get(id);
        return listing
          ? send(res, 200, { listing, imports: queue.forListing(id) })
          : send(res, 404, { error: 'Listing not found.' });
      }
      if (parts.length === 3 && parts[2] === 'refresh' && write) {
        const body = await readJson(req);
        const { listing, fetched } = await sync.loadDetail(id, { force: body.force === true });
        return send(res, 200, { listing, fetched, imports: queue.forListing(id) });
      }
      if (parts.length === 3 && parts[2] === 'remove' && write) {
        return send(res, 200, { removed: library.remove(id) });
      }
    }
    if (parts[0] === 'downloads' && write) {
      if (parts.length === 2 && parts[1] === 'confirm') {
        const body = await readJson(req);
        if (body.accepted !== true) {
          return send(res, 400, { error: 'Tick the box to confirm.' });
        }
        return send(res, 200, { downloads: sync.acceptEula() });
      }
      if (parts.length === 2 && parts[1] === 'revoke') {
        return send(res, 200, { downloads: sync.revokeEula() });
      }
      if (parts.length === 1) {
        return handleDownload(req, res);
      }
    }
    if (parts[0] === 'imports') {
      if (parts.length === 1 && write) {
        return handleUpload(req, res, url);
      }
      if (parts.length === 1) {
        return send(res, 200, { imports: queue.list(), summary: queue.summary() });
      }
      const id = UUID.test(parts[1]) ? parts[1].toLowerCase() : null;
      if (!id) {
        return send(res, 404, { error: 'Import not found.' });
      }
      if (parts.length === 2 && !write) {
        const item = queue.get(id);
        return item
          ? send(res, 200, { import: item })
          : send(res, 404, { error: 'Import not found.' });
      }
      if (parts.length === 3 && write) {
        if (parts[2] === 'cancel') {
          const { import: item, wasRunning } = queue.cancel(id);
          if (wasRunning) {
            runner.cancel(id);
          }
          runner.pump();
          return send(res, 200, { import: item });
        }
        if (parts[2] === 'retry') {
          const row = queue.row(id);
          if (!row) {
            return send(res, 404, { error: 'Import not found.' });
          }
          const project = await resolveProject(row.project_id);
          // A download resumes from its partial file or starts again; an upload must still exist.
          const present =
            row.source === 'fab' ||
            (project &&
              (await fs
                .access(uploadFile(project.folder, id, row.filename))
                .then(() => true)
                .catch(() => false)));
          if (!present) {
            return send(res, 409, {
              error: 'The uploaded file was removed. Choose the file again.',
            });
          }
          const item = queue.retry(id);
          runner.pump();
          return send(res, 200, { import: item });
        }
        if (parts[2] === 'dismiss') {
          const row = queue.dismiss(id);
          const project = await resolveProject(row.project_id);
          if (project) {
            await fs
              .rm(stagingDirectory(project.folder, id), { recursive: true, force: true })
              .catch((error) => logger.warn('Megascans staging cleanup failed:', error.message));
          }
          return send(res, 200, { dismissed: true });
        }
      }
    }
    return send(res, 404, { error: 'Not found.' });
  }

  function attach(server) {
    start();
    server.middlewares.use('/api/megascans', async (req, res) => {
      if (!isLocalRequest(req)) {
        return send(res, 403, { error: 'Local studio requests only.' });
      }
      if (!state) {
        return send(res, 503, {
          error: 'The Megascans database is unavailable. Check Diagnostics.',
        });
      }
      try {
        return await route(req, res, new URL(req.url, 'http://127.0.0.1'));
      } catch (error) {
        if (
          error instanceof LibraryError ||
          error instanceof QueueError ||
          error instanceof ImportError
        ) {
          return send(res, error.status || 400, { error: error.message });
        }
        if (error instanceof FabBlockedError) {
          return send(res, 503, {
            error: error.message,
            blocked: true,
            kind: error.kind,
            retryAfterSeconds: error.retryAfterSeconds,
          });
        }
        if (error instanceof SyncError) {
          return send(res, error.status, {
            error: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          });
        }
        if (error instanceof FabError) {
          return send(res, 502, { error: error.message });
        }
        logger.error('Megascans service error:', error.message);
        return send(res, 500, { error: 'Megascans service failed. Check Diagnostics.' });
      }
    });
    server.httpServer?.once('close', () => {
      state?.sync.cancelScan();
      state?.runner.stop();
    });
  }

  return {
    name: 'forge-megascans',
    configureServer: attach,
    configurePreviewServer: attach,
    /** For tests: the live parts of the service. */
    get state() {
      return start();
    },
  };
}
