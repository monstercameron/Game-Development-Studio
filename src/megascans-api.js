import { createLog } from './app-log.js';

const log = createLog('megascans');

// Client helpers for the Megascans page. The server owns every rule; these only shape requests,
// read errors, and format numbers. Nothing here contacts Fab.

export const FAB_SELLER_URL =
  'https://www.fab.com/sellers/Quixel%20Megascans?listing_types=3d-model&is_free=1';
export const UPLOAD_ACCEPT = '.zip,.glb,.gltf,.fbx,.obj,.ply,.stl';
export const UPLOAD_EXTENSIONS = UPLOAD_ACCEPT.split(',');
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
export const MAX_CONCURRENT_IMPORTS = 2;
export const ACTIVE_STATUSES = ['queued', 'running'];
export const DEFAULT_SORT = 'newest';
export const SORTS = [
  ['newest', 'Newest on Fab'],
  ['title', 'Title A to Z'],
  ['recent', 'Recently saved by you'],
];

const STATUS_LABELS = {
  queued: 'Waiting',
  running: 'Importing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || 'Unknown';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown size';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  if (seconds < 60) {
    return `${Math.max(Math.round(seconds), 1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} min ${Math.round(seconds % 60)} s`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Percent done for a progress bar, or null when the size is not known yet. */
export function percentDone(item) {
  if (!item || !(item.bytesTotal > 0)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.floor((item.bytesDone / item.bytesTotal) * 100)));
}

/** One line for the speed and time left. The time is an estimate from the average speed. */
export function describeSpeed(item) {
  if (item.status !== 'running' || !item.bytesPerSecond) {
    return '';
  }
  const speed = `${formatBytes(item.bytesPerSecond)}/s`;
  return item.secondsRemaining === null || item.secondsRemaining === undefined
    ? speed
    : `${speed} · about ${formatDuration(item.secondsRemaining)} left (estimate)`;
}

/** Reads the file's extension and says whether the page will offer to upload it. */
/**
 * Validates a file before upload. Returns the message to show, or an empty string when the
 * file can be uploaded. Checks run in order: extension, empty file, then size limit.
 * @param {File | null | undefined} file
 * @returns {string}
 */
export function checkChosenFile(file) {
  if (!file) {
    return 'Choose a file to import.';
  }
  const dot = file.name.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
  if (!UPLOAD_EXTENSIONS.includes(extension)) {
    return 'Choose a ZIP archive or a GLB, glTF, FBX, OBJ, PLY or STL model. Unreal Engine packages are not supported.';
  }
  if (file.size <= 0) {
    return 'That file is empty.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is ${formatBytes(file.size)}. Imports are limited to ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  }
  return '';
}

export class MegascansRequestError extends Error {
  constructor(message, status, details = {}) {
    super(message);
    this.name = 'MegascansRequestError';
    this.status = status;
    // True when Fab is refusing automated requests; the page then offers Import instead.
    this.blocked = details.blocked === true;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

/**
 * Log fields for a failed studio request. The message is left out because it can quote server
 * text; the status is kept so a 404 and a network failure read differently.
 * @param {unknown} error
 * @returns {{ errorClass: string, httpStatus?: number }}
 */
export function requestFailureFields(error) {
  const fields = { errorClass: typeof error?.name === 'string' ? error.name : 'Error' };
  if (Number.isInteger(error?.status)) {
    fields.httpStatus = error.status;
  }
  return fields;
}

async function readResponse(response) {
  const responseBody = await response.json().catch((error) => {
    log.debug('megascans.response.unparsed', {
      httpStatus: response.status,
      errorClass: error?.name || 'Error',
    });
    return null;
  });
  if (!response.ok) {
    throw new MegascansRequestError(
      responseBody?.error || `The studio returned an error (${response.status}).`,
      response.status,
      responseBody || {},
    );
  }
  return responseBody;
}

/**
 * GET a studio Megascans route. Resolves with the parsed JSON body.
 * Throws MegascansRequestError when the studio is unreachable or answers with a non-OK status,
 * and rethrows the AbortError when `signal` cancels the request.
 * @param {string} path route below /api/megascans, such as "/status" or "/imports"
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function getMegascans(path, { signal } = {}) {
  let response;
  try {
    // log-coverage: ignore -- the fetch wrapper in src/app-log.js logs failed /api requests
    response = await fetch(`/api/megascans${path}`, { signal, cache: 'no-store' });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    throw new MegascansRequestError('Could not reach the studio. Is it running?', 0);
  }
  return readResponse(response);
}

export async function postMegascans(path, body = {}) {
  let response;
  try {
    // log-coverage: ignore -- the fetch wrapper in src/app-log.js logs failed /api requests
    response = await fetch(`/api/megascans${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'megascans' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new MegascansRequestError('Could not reach the studio. Is it running?', 0);
  }
  return readResponse(response);
}

/**
 * Sends a chosen file to the local studio with upload progress.
 * @returns {{ promise: Promise<object>, abort: () => void }}
 */
export function uploadImportFile({ file, projectId, listingId, onProgress }) {
  const request = new XMLHttpRequest();
  const query = new URLSearchParams({ project: projectId, filename: file.name });
  if (listingId) {
    query.set('listing', listingId);
  }
  const promise = new Promise((resolve, reject) => {
    request.open('POST', `/api/megascans/imports?${query}`);
    request.setRequestHeader('X-Forge-Request', 'megascans');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded, event.total);
      }
    };
    request.onerror = () =>
      reject(new MegascansRequestError('Could not reach the studio. Is it running?', 0));
    request.onabort = () =>
      reject(Object.assign(new Error('Upload cancelled.'), { name: 'AbortError' }));
    request.onload = () => {
      let responseBody;
      try {
        responseBody = JSON.parse(request.responseText);
      } catch (error) {
        log.debug('megascans.upload.response.unparsed', {
          httpStatus: request.status,
          errorClass: error?.name || 'Error',
        });
        responseBody = null;
      }
      if (request.status >= 200 && request.status < 300 && responseBody?.import) {
        resolve(responseBody.import);
      } else {
        reject(
          new MegascansRequestError(
            responseBody?.error || `The studio returned an error (${request.status}).`,
            request.status,
          ),
        );
      }
    };
    request.send(file);
  });
  return { promise, abort: () => request.abort() };
}

/** "just now", "3 h ago", "2 days ago" for a cache timestamp; empty when unknown. */
export function formatAge(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!iso || Number.isNaN(time)) {
    return '';
  }
  const seconds = Math.max(Math.round((now - time) / 1000), 0);
  if (seconds < 60) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} h ago`;
  }
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** A short size range such as "7.0 MiB to 375 MiB". */
export function describeSizeRange(listing) {
  if (!(listing.sizeMax > 0)) {
    return '';
  }
  return listing.sizeMin && listing.sizeMin !== listing.sizeMax
    ? `${formatBytes(listing.sizeMin)} to ${formatBytes(listing.sizeMax)}`
    : formatBytes(listing.sizeMax);
}

/** Whether a scan status means work is still going on. */
export function isScanActive(scan) {
  return scan?.status === 'running';
}

/** Words for a finished or stopped scan. Empty while idle or running. */
export function describeScan(scan) {
  if (!scan) {
    return '';
  }
  const seen = `${(scan.listingsSeen || 0).toLocaleString('en-US')} listings read`;
  const states = {
    running: `Scanning: page ${scan.pagesThisRun + 1} of up to ${scan.maxPages} this run · ${seen}`,
    capped: `Paused after ${scan.pagesThisRun} pages (the limit for one run) · ${seen}. Resume to read more.`,
    completed: `Scan complete · ${seen}.`,
    cancelled: `Scan cancelled · ${seen}. Resume to continue.`,
    interrupted: `Scan interrupted · ${seen}. Resume to continue.`,
    blocked: 'Scan stopped because Fab is blocking automated requests.',
    failed: `Scan stopped: ${scan.error || 'unexpected error'}`,
  };
  return states[scan.status] || '';
}

/**
 * Fab's format names for a card or dialog. The bundled "additional files" are not a model
 * format, so they are left out.
 */
export function describeFormats(listing) {
  return listing.formats
    .filter((format) => format.code !== 'additional-files')
    .map((format) => (format.code === 'converted-files' ? 'glTF, GLB, USDZ' : format.name))
    .join(', ');
}
