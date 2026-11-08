// Crash recovery helpers for render jobs. The queue itself (runtime/jobs.js) owns every status
// transition and the lease; this module only answers two questions from evidence on disk:
//
// 1. A job died while "finalizing". Did its output file reach the project complete?
//    (inspectFinishedOutput). A file is accepted only when its size and signature say so.
// 2. After a restart, which unfinished jobs need a person and which are provably safe to run
//    again? (classifyJobForRecovery). A job whose submission may have reached an engine is
//    never classed as safe: its remote outcome is unknown.
//
// Nothing here talks to an engine or changes a job.
import fs from 'node:fs';
import path from 'node:path';
import { verifyOutputFile } from './durable-file.js';

// Where each job type writes its main output (see the *-job.js workers and saveAsset).
const OUTPUTS = Object.freeze({
  images: { folder: 'images', extension: 'png' },
  sfx: { folder: 'sfx', extension: 'wav' },
  music: { folder: 'music', extension: 'flac' },
  voices: { folder: 'voices', extension: 'wav' },
  '3d': { folder: '3d', extension: 'glb' },
  trellis: { folder: '3d', extension: 'glb' },
  segmentation: { folder: 'masks', extension: 'png' },
  motion: { folder: 'motion', extension: 'bvh' },
  'motion-bricks': { folder: 'motion', extension: 'bvh' },
  video: { folder: 'video', extension: 'webm' },
});

/** The project-relative path a finished job would have saved, or null when it is not fixed. */
export function expectedOutputPath(job) {
  if (!job?.id || !/^[a-f0-9-]{36}$/i.test(job.id)) {
    return null;
  }
  const target =
    job.type === 'world'
      ? { folder: '3d', extension: job.request?.output === 'glb' ? 'glb' : 'ply' }
      : OUTPUTS[job.type];
  return target ? `${target.folder}/forge-${job.id}.${target.extension}` : null;
}

/**
 * Looks for the output a finalizing job left behind.
 * @param {{ id: string, type: string, request?: object }} job
 * @param {string} projectFolder
 * @returns {Promise<{ state: 'valid'|'unverified'|'invalid'|'missing'|'unknown', output?: string,
 *   reason?: string }>} `valid` is structurally complete; `unverified` exists but only its start
 *   could be checked; `invalid` exists but is damaged; `missing` is not on disk; `unknown` means
 *   this job type has no fixed output name.
 */
export async function inspectFinishedOutput(job, projectFolder) {
  const output = expectedOutputPath(job);
  if (!output) {
    return { state: 'unknown' };
  }
  const file = path.join(projectFolder, ...output.split('/'));
  const info = await fs.promises.lstat(file).catch(() => null);
  if (!info) {
    return { state: 'missing', output };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { state: 'invalid', output, reason: 'not a regular file' };
  }
  const result = await verifyOutputFile(file, path.extname(file));
  if (!result.ok) {
    return { state: 'invalid', output, reason: result.reason };
  }
  return { state: result.level === 'structural' ? 'valid' : 'unverified', output };
}

const BLOCKING = new Set(['interrupted', 'needs_attention']);

/**
 * Describes one unfinished job for the Recovery report.
 *
 * `safeToRetry` is true only when running the job again cannot duplicate remote work:
 * - needs_attention without a remote id: preparation failed before anything was submitted;
 * - a vegetation job: deterministic, CPU only and has no remote job;
 * - failed without a remote id: the engine refused it before accepting it.
 * An `interrupted` job without a remote id passed through `submitting`, so the engine may have
 * accepted it; it is never safe to retry automatically.
 */
export function classifyJobForRecovery(job) {
  const hasRemoteId = typeof job.remoteId === 'string' && job.remoteId !== '';
  let kind;
  let reason;
  let safeToRetry = false;
  if (job.type === 'vegetation') {
    kind = BLOCKING.has(job.status) ? 'needs_attention' : 'restartable';
    reason = 'Vegetation is deterministic and has no remote job; running it again is safe.';
    safeToRetry = true;
  } else if (job.status === 'interrupted') {
    kind = 'unknown_outcome';
    reason = hasRemoteId
      ? 'The engine accepted this render before the interruption; whether it finished is unknown.'
      : 'The submission may have reached the engine before the interruption; whether it accepted it is unknown.';
  } else if (job.status === 'needs_attention') {
    kind = 'needs_attention';
    safeToRetry = !hasRemoteId;
    reason = hasRemoteId
      ? 'The engine could not be reconnected for an accepted render.'
      : 'Preparation stopped before anything was submitted to an engine.';
  } else if (job.status === 'failed' && !hasRemoteId) {
    kind = 'failed';
    safeToRetry = true;
    reason = 'It failed before an engine accepted it.';
  } else {
    kind = 'continuing';
    reason = 'The queue continues this job on its own.';
  }
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    kind,
    reason,
    safeToRetry,
    hasRemoteId,
    stage: typeof job.stage === 'string' ? job.stage.slice(0, 160) : '',
    updatedAt: job.updatedAt || null,
  };
}
