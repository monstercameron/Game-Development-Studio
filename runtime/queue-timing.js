import { STANDARD_PIXELS, videoDimensions } from './video-options.js';

function videoPixelFactor(request) {
  const size = videoDimensions(request.aspect || 'landscape', request.resolution || 'standard');
  return size ? (size[0] * size[1]) / STANDARD_PIXELS : 1;
}

// Queue order comes from the durable runtime. These are estimates, not reservations;
// preparation, model loading, and outside GPU activity cannot be predicted reliably.
export const ACTIVE_QUEUE_STATES = new Set([
  'queued',
  'waiting_engine',
  'waiting_memory',
  'preparing',
  'needs_attention',
  'submitting',
  'running',
  'finalizing',
  'interrupted',
]);
const BLOCKED_STATES = new Set(['needs_attention', 'interrupted', 'waiting_memory']);

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'Unknown';
  }
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  const minutes = Math.floor(s / 60),
    rest = s % 60;
  if (minutes < 60) {
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60),
    remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

export function work(type, request) {
  const number = (value, fallback = 1) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  switch (type) {
    case 'images':
      // A size matched to the last reference is about one megapixel (Qwen's output_resolution of 1024).
      return (
        (request.size_from_reference
          ? 1024 * 1024
          : number(request.width) * number(request.height)) * number(request.num_inference_steps)
      );
    case 'video':
      // A larger picture has proportionally more tokens, and guidance runs the model twice.
      return (
        number(request.frames) *
        number(request.steps) *
        videoPixelFactor(request) *
        ((request.cfg_scale || 1) > 1 ? 2 : 1)
      );
    case 'sfx':
      return number(request.duration) * number(request.steps);
    case 'music':
      return number(request.duration_seconds) * number(request.ode_steps);
    case 'voices':
      return Math.max(1, (request.text || '').length);
    case '3d':
      return number(request.steps) * Math.pow(number(request.resolution, 128) / 128, 3);
    case 'trellis':
      return number(request.steps);
    case 'motion':
      return number(request.duration) * number(request.steps);
    case 'motion-bricks':
      return number(request.max_tokens);
    case 'segmentation':
      return 1;
    default:
      return null;
  }
}

// A reference that will come from an earlier render (request.referenceFrom) counts as soon as
// the render is queued, so a waiting chained render matches its finished siblings.
function referenceCount(request) {
  const own = request?.references?.length || 0;
  const pending = request?.referenceFrom && typeof request.referenceFrom.output !== 'string';
  return own + (pending ? 1 : 0);
}

// When there are no exact matches, use nearby completed settings only. This is
// deliberately labeled rough and is omitted if the workloads differ too much.
export function estimateFromNearbyHistory(type, request, jobs) {
  const target = work(type, request || {});
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const samples = [];
  for (const job of jobs) {
    if (job.type !== type || job.status !== 'completed' || !job.startedAt || !job.finishedAt) {
      continue;
    }
    const source = work(type, job.request || {}),
      ratio = target / source;
    if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 2) {
      continue;
    }
    if (
      ['images', 'video'].includes(type) &&
      referenceCount(request) !== referenceCount(job.request)
    ) {
      continue;
    }
    if (
      type === 'images' &&
      (request.true_cfg_scale || 1) > 1 !== (job.request?.true_cfg_scale || 1) > 1
    ) {
      continue;
    }
    if (
      type === 'music' &&
      (request.cot !== job.request?.cot ||
        (request.cfg_scale === null || request.cfg_scale === undefined
          ? request.cot === 'off'
          : request.cfg_scale !== 1) !==
          (job.request?.cfg_scale === null || job.request?.cfg_scale === undefined
            ? job.request?.cot === 'off'
            : job.request.cfg_scale !== 1))
    ) {
      continue;
    }
    if (type === 'motion' && (request.guidance !== 1) !== (job.request?.guidance !== 1)) {
      continue;
    }
    if (type === 'trellis' && request.texture_size !== job.request?.texture_size) {
      continue;
    }
    // Pipelines differ by far more than the 2x ratio check allows for.
    if (type === 'trellis' && (request.pipeline ?? '512') !== (job.request?.pipeline ?? '512')) {
      continue;
    }
    if (
      type === '3d' &&
      (request.texture === true ? request.texture_size : false) !==
        (job.request?.texture === true ? job.request.texture_size : false)
    ) {
      continue;
    }
    // More or larger painted views take about twice as long, so they never borrow default timings.
    if (
      type === '3d' &&
      request.texture === true &&
      (request.texture_views ?? 6) !== (job.request?.texture_views ?? 6)
    ) {
      continue;
    }
    if (
      type === '3d' &&
      request.texture === true &&
      (request.texture_view_size ?? 512) !== (job.request?.texture_view_size ?? 512)
    ) {
      continue;
    }
    const duration = (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000;
    if (Number.isFinite(duration) && duration > 0) {
      samples.push(duration * ratio);
    }
  }
  if (!samples.length) {
    return null;
  }
  samples.sort((a, b) => a - b);
  return {
    available: true,
    typicalSeconds: Math.max(1, Math.round(samples[Math.floor((samples.length - 1) / 2)])),
    sampleCount: samples.length,
    confidence: 'rough',
    note: 'Roughly scaled from completed renders with different but similar settings.',
  };
}

function progressEta(stage) {
  const match =
    typeof stage === 'string' && /\bETA\s+(\d{1,3}):(\d{2})(?::(\d{2}))?\b/i.exec(stage);
  if (!match) {
    return null;
  }
  const parts = match.slice(1).filter(Boolean).map(Number);
  if (parts.slice(1).some((part) => part >= 60)) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function forecastQueue(jobs, estimates, now = Date.now(), limit = 50) {
  const active = (jobs || []).filter((job) => ACTIVE_QUEUE_STATES.has(job.status));
  const perJob = {};
  let seconds = 0,
    known = true,
    reason = '',
    hasRough = false,
    knownWorkSeconds = 0,
    knownWorkCount = 0;
  for (const [index, job] of active.entries()) {
    const estimate = estimates[job.id] || null;
    const priorKnown = known,
      priorSeconds = seconds;
    if (index >= limit) {
      known = false;
      reason = reason || 'Too many jobs to estimate at once.';
      perJob[job.id] = { estimate, waitSeconds: null, reason };
      continue;
    }
    let remaining = null;
    if (BLOCKED_STATES.has(job.status)) {
      known = false;
      reason =
        job.status === 'waiting_memory' ? 'Waiting for GPU memory.' : 'A render needs attention.';
    } else if (['waiting_engine', 'preparing', 'submitting'].includes(job.status)) {
      known = false;
      reason = 'A model or render is being prepared.';
    } else if (job.status === 'queued') {
      if (estimate?.available && Number.isFinite(estimate.typicalSeconds)) {
        remaining = estimate.typicalSeconds;
      } else {
        known = false;
        reason = reason || 'Not enough render history.';
      }
    } else if (['running', 'finalizing'].includes(job.status)) {
      const direct = progressEta(job.stage);
      if (direct !== null) {
        remaining = direct;
      } else if (estimate?.available && job.startedAt) {
        const elapsed = Math.max(0, (now - Date.parse(job.startedAt)) / 1000);
        if (Number.isFinite(elapsed) && elapsed < estimate.typicalSeconds) {
          remaining = estimate.typicalSeconds - elapsed;
        } else {
          known = false;
          reason = 'The active render is taking longer than its estimate.';
        }
      } else {
        known = false;
        reason = 'The active render has no timing history.';
      }
    }
    if (estimate?.confidence === 'rough') {
      hasRough = true;
    }
    // This is a sum of known render estimates, not a minimum or a finish time.
    // It remains useful when preparation or another job has unknown timing.
    const knownWork =
      remaining !== null
        ? remaining
        : !['running', 'finalizing', 'interrupted'].includes(job.status) && estimate?.available
          ? estimate.typicalSeconds
          : null;
    if (Number.isFinite(knownWork) && knownWork >= 0) {
      knownWorkSeconds += knownWork;
      knownWorkCount++;
    }
    perJob[job.id] = {
      estimate,
      remainingSeconds: remaining === null ? null : Math.ceil(remaining),
      waitSeconds: job.status === 'queued' && priorKnown ? Math.ceil(priorSeconds) : null,
      reason: job.status === 'queued' && !priorKnown ? reason : '',
    };
    if (known && remaining !== null) {
      seconds += remaining;
    }
  }
  return {
    count: active.length,
    seconds: known ? Math.ceil(seconds) : null,
    knownWorkSeconds: Math.ceil(knownWorkSeconds),
    knownWorkCount,
    blocked: active.some((job) => BLOCKED_STATES.has(job.status)),
    reason,
    hasRough,
    perJob,
  };
}
