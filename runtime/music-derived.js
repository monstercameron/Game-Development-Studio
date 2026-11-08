// Extending or re-synthesizing a finished YuE2 track. YuE2 keeps the song tokens of every track it
// rendered and refers to them by its own job ID, so Forge never uploads audio: the request names a
// project music asset, and the queue resolves that asset to the engine job that produced it.
import { randomInt } from 'node:crypto';
import { readAssetMeta, validateAssetPath } from './asset-metadata.js';

export const MUSIC_OPERATIONS = ['extend', 'resynth'];
export const EXTEND_SECONDS = { min: 1, max: 300, fallback: 30 };
const forgeJobName =
  /^forge-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:-converted(?:-\d+)?)*\.[a-z0-9]{2,5}$/i;
const remoteIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const isSeed = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;

/**
 * Shape checks only. The source asset is resolved by resolveDerivedMusic when the job is queued.
 *
 * @param {object} request The client request: operation, source, and optional seed, title,
 *   add_seconds, lyrics_addition and ode_steps.
 * @returns {object} A copy with a seed (random when omitted) and only the fields that apply to the
 *   operation.
 * @throws {Error} When the operation, source path, seed, title, length or steps are invalid.
 */
export function normalizeDerivedMusic(request) {
  const {
    operation,
    source,
    seed = null,
    title = '',
    add_seconds: addSeconds = EXTEND_SECONDS.fallback,
    lyrics_addition: lyricsAddition = '',
    ode_steps: odeSteps = null,
  } = request;
  if (!MUSIC_OPERATIONS.includes(operation)) {
    throw Error('Music operation must be extend or resynth.');
  }
  validateAssetPath(source);
  if (!(seed === null || isSeed(seed))) {
    throw Error('Use a music seed from 0 to 2147483647.');
  }
  if (typeof title !== 'string' || title.length > 200) {
    throw Error('Title must be at most 200 characters.');
  }
  const out = {
    operation,
    source,
    seed: seed === null ? randomInt(0, 2147483648) : seed,
    ...(title.trim() ? { title: title.trim() } : {}),
  };
  if (operation === 'extend') {
    if (
      !Number.isFinite(addSeconds) ||
      addSeconds < EXTEND_SECONDS.min ||
      addSeconds > EXTEND_SECONDS.max
    ) {
      throw Error('Seconds to add must be from 1 to 300.');
    }
    if (typeof lyricsAddition !== 'string' || lyricsAddition.length > 5000) {
      throw Error('Lyrics to add must be at most 5000 characters.');
    }
    if (odeSteps !== null) {
      throw Error('Synthesis steps apply only when re-synthesizing.');
    }
    out.add_seconds = addSeconds;
    if (lyricsAddition.trim()) {
      out.lyrics_addition = lyricsAddition.trim();
    }
    return out;
  }
  if (request.add_seconds !== undefined || lyricsAddition) {
    throw Error('Seconds and lyrics to add apply only when extending.');
  }
  if (odeSteps !== null) {
    if (!Number.isInteger(odeSteps) || odeSteps < 1 || odeSteps > 100) {
      throw Error('Synthesis steps must be a whole number from 1 to 100.');
    }
    out.ode_steps = odeSteps;
  }
  return out;
}

// A style line is a long description, so a title taken from it stops at a whole word.
const derivedSuffixPattern = /(?:\s*\((?:extended|re-synthesized)\))+$/i;
function shortenAtWord(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:-]+$/, '');
}

// The Forge job that rendered a music asset: from its metadata record, else from its file name.
export function sourceJobId(projectFolder, source) {
  const meta = readAssetMeta(projectFolder, source);
  if (meta?.job?.id && meta.job.type === 'music') {
    return meta.job.id;
  }
  return forgeJobName.exec(source.split('/').pop())?.[1]?.toLowerCase() || null;
}

// `lookup(id)` returns a queue job. The engine job ID of the completed source is copied into the
// request so the worker can ask YuE2 for its track; style and lyrics are copied for display.
export function resolveDerivedMusic(value, { projectFolder, lookup }) {
  const request = value.request;
  const jobId = sourceJobId(projectFolder, request.source);
  const job = jobId ? lookup(jobId) : null;
  if (
    !job ||
    job.type !== 'music' ||
    job.projectId !== value.projectId ||
    job.status !== 'completed' ||
    !remoteIdPattern.test(job.remoteId || '')
  ) {
    throw Error(
      'Only a finished YuE2 track from this project can be extended or re-synthesized. Choose a music file that Forge rendered.',
    );
  }
  const style = typeof job.request?.style === 'string' ? job.request.style : '';
  const lyrics = typeof job.request?.lyrics === 'string' ? job.request.lyrics : '';
  const combined =
    request.lyrics_addition && lyrics
      ? `${lyrics.trimEnd()}\n\n${request.lyrics_addition}`
      : request.lyrics_addition || lyrics;
  const suffix = request.operation === 'extend' ? ' (extended)' : ' (re-synthesized)';
  const sourceTitle = typeof job.request?.title === 'string' ? job.request.title : '';
  const baseTitle = (sourceTitle || shortenAtWord(style, 60) || 'Track')
    .replace(derivedSuffixPattern, '')
    .trim();
  return {
    ...value,
    request: {
      ...request,
      source_job: job.id,
      source_remote: job.remoteId,
      ...(style ? { style } : {}),
      ...(combined ? { lyrics: combined.slice(0, 20000) } : {}),
      title: request.title || `${baseTitle || 'Track'}${suffix}`.slice(0, 200),
      // Extending reports the added length so timing history has a size to compare.
      ...(request.operation === 'extend' ? { duration_seconds: request.add_seconds } : {}),
    },
  };
}
