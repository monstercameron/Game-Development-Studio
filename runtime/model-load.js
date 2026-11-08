import { createLogger } from './app-log.js';

const log = createLogger('model');

// YuE2's existing CUDA pipeline is configured with a 24 GiB memory budget.
// Keep 2 GiB free for the system; this is a conservative admission threshold,
// not a reservation or a guarantee against concurrent allocations.
export const YUE_BUDGET_MIB = 24 * 1024;
export const GPU_RESERVE_MIB = 2 * 1024;

export function memoryCandidates(services, exclude = []) {
  return (services || [])
    .filter(
      (s) =>
        !exclude.includes(s.id) &&
        (s.modelLoaded === true ||
          s.busy === true ||
          (s.status === 'reachable' &&
            (s.modelLoaded === null ||
              s.modelLoaded === undefined ||
              (s.managed === true && s.canUnload === true)))),
    )
    .map(({ id, name, canUnload, canForceStop, busy, managed, status, modelLoaded, url }) => ({
      id,
      name,
      canUnload: !!canUnload && busy !== true && managed === true,
      canForceStop: !!canForceStop,
      busy: busy === true,
      managed: managed === true,
      status,
      modelLoaded,
      url,
    }));
}

// Host RAM is a soft requirement. The per-engine budgets are uncalibrated estimates, and weights
// are loaded with memory mapping, so a desktop that is merely busy must not block a job while the
// GPU has room. Only a real shortage (below a small hard floor) blocks by default. Set
// FORGE_HOST_MEMORY_POLICY=strict (or the memory.hostPolicy setting) enforces the full per-engine
// budget again.
export const HOST_MEMORY_FLOOR_BYTES = 2 * 1024 ** 3;
const environmentHostMemoryPolicy = () => process.env.FORGE_HOST_MEMORY_POLICY;
let readHostMemoryPolicy = environmentHostMemoryPolicy;

/**
 * Chooses where the default policy comes from. The queue worker passes a reader of the live
 * memory.hostPolicy setting (environment variable, then saved override, then soft); with no
 * argument the plain environment variable is read again, as before the setting existed.
 *
 * @param {(() => string|undefined)|null} [reader]
 */
export function setHostMemoryPolicySource(reader = null) {
  readHostMemoryPolicy = reader ?? environmentHostMemoryPolicy;
}

export function hostMemoryShort(freeBytes, requiredBytes, policy = readHostMemoryPolicy()) {
  if (!Number.isFinite(freeBytes)) {
    return true;
  }
  const needed =
    String(policy || '').toLowerCase() === 'strict'
      ? requiredBytes
      : Math.min(requiredBytes, HOST_MEMORY_FLOOR_BYTES);
  return freeBytes < needed;
}

export function hostMemoryConflict(freeBytes, requiredBytes, services, exclude = []) {
  const free = Number.isFinite(freeBytes) && freeBytes >= 0 ? freeBytes : null;
  return {
    code: 'insufficient_host_memory',
    freeBytes: free,
    requiredBytes,
    shortfallBytes: free === null ? null : Math.max(0, requiredBytes - free),
    candidates: memoryCandidates(services, exclude),
    message: 'Available system memory is below the configured requirement.',
  };
}

/**
 * Decides whether the inference GPU has room for a model load. The result is blocking unless a
 * single GPU can be identified and its free memory verified.
 *
 * @param {object} hardware GPU snapshot with `devices` (name, index, freeMiB).
 * @param {object[]} services Service records used to suggest unload candidates on a shortage.
 * @param {number} [budgetMiB] Model budget estimate in MiB, not a measured requirement.
 * @returns {object} `{ code: 'ready', device, requiredMiB }`, or a blocking code
 *   (`gpu_memory_unavailable` or `insufficient_gpu_memory`) with a message.
 */
export function planModelLoad(hardware, services, budgetMiB = YUE_BUDGET_MIB) {
  const devices = Array.isArray(hardware?.devices) ? hardware.devices : [];
  const gpuDevices = devices.filter(
    (item) => item && typeof item === 'object' && !/\bNPU\b/i.test(item.name || ''),
  );
  // CUDA's default-device order can differ from the order reported by the
  // management tool. Until per-engine UUID mapping is available, never use
  // another device's free memory to admit a load on a multi-GPU machine.
  if (gpuDevices.length > 1) {
    return {
      code: 'gpu_memory_unavailable',
      message:
        'Multiple GPUs are present, but the inference device cannot be identified safely. The model was not loaded.',
      devices,
    };
  }
  const device = gpuDevices[0];
  if (
    !device ||
    !Number.isFinite(device.freeMiB) ||
    device.freeMiB < 0 ||
    (devices.some((item) => Number.isInteger(item?.index)) && device.index !== 0)
  ) {
    return {
      code: 'gpu_memory_unavailable',
      message: 'The inference GPU memory could not be verified. The model was not loaded.',
      devices,
    };
  }
  const requiredMiB = budgetMiB + GPU_RESERVE_MIB;
  if (device.freeMiB >= requiredMiB) {
    return { code: 'ready', device, requiredMiB };
  }
  return {
    code: 'insufficient_gpu_memory',
    device,
    requiredMiB,
    shortfallMiB: requiredMiB - device.freeMiB,
    candidates: memoryCandidates(services),
    message: 'Free GPU memory is below the configured model budget plus the system reserve.',
  };
}

export function createModelLoader({
  hardware,
  services,
  baseUrl = 'http://127.0.0.1:8765',
  fetcher = fetch,
}) {
  let inFlight = null;
  let lastRequested = 0;
  return async function loadMusic() {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      let health;
      try {
        const response = await fetcher(`${baseUrl}/api/v1/health`, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        health = await response.json();
        if (
          !response.ok ||
          health.api_version !== '1' ||
          typeof health.model?.loaded !== 'boolean'
        ) {
          throw Error('Unexpected engine response');
        }
      } catch (error) {
        log.debug('model.health.failed', {
          engine: 'yue2',
          errorClass: error.name,
          errorCode: error.code,
        });
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Start YuE2 before loading its model.' },
        };
      }
      if (health.model.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'YuE2 is already loaded.' },
        };
      }
      if (health.model.loading || Date.now() - lastRequested < 15000) {
        return {
          status: 202,
          body: { code: 'loading', message: 'YuE2 is already loading or waiting to load.' },
        };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, []);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = planModelLoad(snapshot, await services());
      }
      if (plan.code !== 'ready') {
        log.warn('model.load.blocked', {
          engine: 'yue2',
          reason: plan.code,
          requiredMiB: plan.requiredMiB,
          freeMiB: plan.device?.freeMiB,
        });
        return { status: 409, body: plan };
      }
      try {
        const response = await fetcher(`${baseUrl}/api/model/load`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) {
          log.warn('model.load.failed', { engine: 'yue2', httpStatus: response.status });
          return response.status >= 500
            ? {
                status: 503,
                body: {
                  code: 'load_unknown',
                  message: `YuE2 returned HTTP ${response.status}; the load request may have started. Check the worker before clearing its queue barrier.`,
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `YuE2 rejected the load request (HTTP ${response.status}).`,
                },
              };
        }
        lastRequested = Date.now();
        log.info('model.load.requested', {
          engine: 'yue2',
          requiredMiB: plan.requiredMiB,
          freeMiB: plan.device.freeMiB,
        });
        return {
          status: 202,
          body: { code: 'load_requested', message: 'YuE2 model loading requested.', memory: plan },
        };
      } catch (error) {
        log.warn('model.load.failed', {
          engine: 'yue2',
          outcome: 'unknown',
          errorClass: error.name,
          errorCode: error.code,
        });
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              'The YuE2 load request may have started. Check the worker before clearing its queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
