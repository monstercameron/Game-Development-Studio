import os from 'node:os';
import { planModelLoad, hostMemoryConflict, hostMemoryShort } from './model-load.js';

// One still-image test succeeded. These admission budgets remain conservative
// estimates, not reservations or limits on other applications.
export const SAM31_HOST_LOAD_BYTES = 9 * 1024 ** 3;
export const SAM31_GPU_LOAD_MIB = 12 * 1024;
export const SAM31_GPU_RENDER_MIB = 8 * 1024;

export function createSam31Loader({
  hardware,
  services,
  baseUrl,
  freeMemory = os.freemem,
  fetcher = fetch,
}) {
  let inFlight = null;
  return function loadSam31() {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      let status;
      try {
        const response = await fetcher(`${baseUrl}/api/status`, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        status = await response.json();
        if (
          !response.ok ||
          status.engine !== 'forge-sam31-image-experimental-v1' ||
          typeof status.loaded !== 'boolean'
        ) {
          throw Error('Unexpected response');
        }
      } catch {
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Start the SAM 3.1 worker first.' },
        };
      }
      if (status.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'SAM 3.1 is already loaded.' },
        };
      }
      if (status.phase === 'loading') {
        return { status: 202, body: { code: 'loading', message: 'SAM 3.1 is already loading.' } };
      }
      if (status.model_downloaded !== true) {
        return {
          status: 409,
          body: { code: 'model_missing', message: 'The SAM 3.1 checkpoint is missing.' },
        };
      }
      const free = freeMemory();
      if (hostMemoryShort(free, SAM31_HOST_LOAD_BYTES)) {
        return {
          status: 409,
          body: hostMemoryConflict(free, SAM31_HOST_LOAD_BYTES, await services(), ['segmentation']),
        };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, [], SAM31_GPU_LOAD_MIB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), SAM31_GPU_LOAD_MIB),
          estimate: 'Conservative, uncalibrated SAM 3.1 GPU budget plus system reserve.',
        };
      }
      if (plan.code !== 'ready') {
        return { status: 409, body: plan };
      }
      try {
        const response = await fetcher(`${baseUrl}/api/model/load`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) {
          return response.status >= 500
            ? {
                status: 503,
                body: {
                  code: 'load_unknown',
                  message:
                    'SAM 3.1 may be loading. Check the worker before clearing its queue barrier.',
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `SAM worker rejected loading (HTTP ${response.status}).`,
                },
              };
        }
        return {
          status: 202,
          body: { code: 'load_requested', message: 'SAM 3.1 loading requested.', memory: plan },
        };
      } catch {
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message: 'SAM 3.1 may be loading. Check the worker before clearing its queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createSam31Preparation({ startEngine, loadModel, autoStart = true }) {
  return async ({ health, reachable, claimLoad, retryModel = false }) => {
    if (!reachable) {
      if (!autoStart) {
        return { status: 'waiting_engine', stage: 'Waiting for the configured SAM worker.' };
      }
      const result = await startEngine('segmentation');
      if (result.status === 'recovery_unresolved') {
        if (!claimLoad()) {
          return null;
        }
        return {
          status: 'needs_attention',
          stage: 'Worker recovery needs review.',
          error: result.message || 'A previous worker may still be starting or loading.',
          loadBarrier: true,
        };
      }
      if (['missing', 'failed', 'port_in_use'].includes(result.status)) {
        return {
          status: 'needs_attention',
          stage: 'SAM worker could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      return { status: 'waiting_engine', stage: 'Starting the SAM worker.' };
    }
    if (['preparing', 'generating'].includes(health.phase)) {
      return { status: 'waiting_engine', stage: 'Waiting for the current segmentation.' };
    }
    if (health.phase === 'loading') {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading SAM 3.1.', loadBarrier: true };
    }
    if (!health.model_downloaded) {
      return {
        status: 'needs_attention',
        stage: 'SAM 3.1 checkpoint is missing.',
        error: 'Install the SAM 3.1 checkpoint, then retry.',
      };
    }
    if (health.phase === 'error' && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'SAM 3.1 could not load.',
        error: health.error || 'Check the worker logs in Diagnostics, then retry.',
      };
    }
    if (!claimLoad()) {
      return null;
    }
    const result = await loadModel();
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'SAM model load needs review.',
        error: result.body.message,
        loadBarrier: true,
      };
    }
    if (['insufficient_gpu_memory', 'insufficient_host_memory'].includes(result.body?.code)) {
      return {
        status: 'waiting_memory',
        stage:
          result.body.code === 'insufficient_host_memory'
            ? 'Waiting for system memory.'
            : 'Waiting for GPU memory.',
        details: result.body,
      };
    }
    if (result.status >= 400 && result.body?.code !== 'engine_unavailable') {
      return {
        status: 'needs_attention',
        stage: 'SAM 3.1 could not load.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for SAM 3.1.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}

export function createSam31RenderPreparation({ hardware, services, freeMemory = os.freemem }) {
  return async () => {
    const free = freeMemory();
    if (hostMemoryShort(free, 3 * 1024 ** 3)) {
      return {
        status: 'waiting_memory',
        stage: 'Waiting for system memory.',
        details: hostMemoryConflict(free, 3 * 1024 ** 3, await services(), ['segmentation']),
      };
    }
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], SAM31_GPU_RENDER_MIB);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = {
        ...planModelLoad(
          snapshot,
          (await services()).filter((service) => service.id !== 'segmentation'),
          SAM31_GPU_RENDER_MIB,
        ),
        estimate: 'Uncalibrated additional working-memory estimate for SAM 3.1.',
      };
    }
    if (plan.code === 'insufficient_gpu_memory') {
      return { status: 'waiting_memory', stage: 'Waiting for GPU memory.', details: plan };
    }
    if (plan.code !== 'ready') {
      return {
        status: 'needs_attention',
        stage: 'GPU memory is unavailable.',
        error: plan.message,
      };
    }
    return null;
  };
}
