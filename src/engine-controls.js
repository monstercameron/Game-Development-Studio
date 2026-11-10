// Engine (model service) helpers for the queue and the Models page: which engine a render uses,
// why "Stop service" is unavailable, and the facts a person checks before a manual decision.
// Mirrors engineId() in runtime/jobs.js; keep the two in step.
import { WAITING_STATUSES } from './queue-filters.js';

const ENGINE_NAMES = {
  music: 'YuE2',
  sfx: 'Stable Audio Lab',
  images: 'Qwen Image Studio',
  video: 'H3 Studio',
  voices: 'Qwen3-TTS',
  '3d': 'Hunyuan3D',
  trellis: 'TRELLIS.2',
  segmentation: 'SAM 3.1',
  motion: 'HY-Motion',
  'motion-bricks': 'MotionBricks',
  world: 'World generation',
};

// The engine id the runtime uses for a job type, or null when the type runs without an engine.
export function engineIdForJobType(type) {
  const ids = {
    voices: 'tts',
    '3d': '3d-hunyuan',
    trellis: '3d-trellis',
    motion: 'motion-hy',
    images: 'images',
    music: 'music',
    sfx: 'sfx',
    video: 'video',
    segmentation: 'segmentation',
    'motion-bricks': 'motion-bricks',
    world: 'world',
  };
  return ids[type] || null;
}

export function engineNameForJobType(type) {
  return ENGINE_NAMES[type] || 'the engine';
}

// Renders that wait for this engine, in queue order. A stop of the engine leaves them in line.
export function waitingJobsForEngine(jobs, engineId) {
  return jobs.filter(
    (job) => WAITING_STATUSES.includes(job.status) && engineIdForJobType(job.type) === engineId,
  );
}

/**
 * Why "Stop service" cannot run for a service, or null when it can. The runtime answers
 * `canUnload` only when the service is verified idle and owned by Forge, so each reason below
 * names the first condition that fails.
 */
export function stopServiceBlockReason(service) {
  if (!service) {
    return 'The service state is not known yet.';
  }
  if (service.canUnload) {
    return null;
  }
  if (service.status !== 'reachable') {
    return 'The service is not running, so there is nothing to stop.';
  }
  if (service.busy === true) {
    return 'A render is using this service. Wait for it to finish, or stop that render.';
  }
  if (service.managed !== true) {
    return 'This service runs in its own app. Stop it there.';
  }
  if (service.id === 'chat') {
    return 'Forge cannot verify that Qwen is idle, so a safe stop is unavailable. Use Force stop if you must.';
  }
  return 'Forge cannot verify that this service is idle, so a safe stop is unavailable.';
}

// The GPU memory the runtime reports, as one line. Null when no device reports it.
export function gpuMemoryText(hardware) {
  const devices = (hardware?.devices || []).filter(
    (device) => Number.isFinite(device.usedMiB) && Number.isFinite(device.totalMiB),
  );
  if (!devices.length) {
    return null;
  }
  const usedMiB = devices.reduce((sum, device) => sum + device.usedMiB, 0);
  const totalMiB = devices.reduce((sum, device) => sum + device.totalMiB, 0);
  return `${(usedMiB / 1024).toFixed(1)} of ${(totalMiB / 1024).toFixed(1)} GiB in use`;
}

/**
 * The facts a person checks before deciding about an engine, each as a label and a value. Unknown
 * values stay "Unknown"; nothing is inferred from a missing field.
 */
export function engineFacts(service, hardware) {
  const yesNo = (value) => (value === true ? 'Yes' : value === false ? 'No' : 'Unknown');
  const reachable =
    service?.status === 'reachable'
      ? 'Reachable'
      : service?.status
        ? `Not reachable (${service.status})`
        : 'Unknown';
  return [
    { label: 'Engine', value: reachable },
    { label: 'Busy with a render', value: yesNo(service?.busy) },
    { label: 'Model loaded', value: yesNo(service?.modelLoaded) },
    { label: 'Process verified as Forge’s', value: yesNo(service?.managed) },
    { label: 'GPU memory', value: gpuMemoryText(hardware) || 'Unavailable' },
  ];
}

/**
 * Whether the GPU's live free memory covers the requirement a memory dialog shows, or null when
 * either number is unknown. The requirement is a configured estimate, so "true" only means the
 * estimate may be what blocks the render; it does not prove that the load will succeed.
 */
export function gpuCoversRequirement(requiredGiB, liveFreeGiB) {
  if (!Number.isFinite(requiredGiB) || !Number.isFinite(liveFreeGiB)) {
    return null;
  }
  return liveFreeGiB >= requiredGiB;
}
