import os from 'node:os';
import { planModelLoad, hostMemoryConflict, hostMemoryShort } from './model-load.js';

// Conservative, uncalibrated budgets. A free-memory reading is not a reservation.
const HOST_LOAD = 8 * 1024 ** 3,
  HOST_RENDER = 12 * 1024 ** 3,
  GPU_LOAD = 4 * 1024,
  GPU_RENDER = 24 * 1024;
const engine = 'forge-trellis2-512-experimental-v1';
// Per-pipeline render budgets. Only the 512 budget has any measurement behind it; the
// higher-resolution values are deliberately generous guesses for a large GPU. The first render
// that needs the 1024 checkpoints also reads about 5 GiB of them into host memory, which is why
// the host figure is higher. Host memory is only a soft floor unless FORGE_HOST_MEMORY_POLICY=strict.
export const TRELLIS_RENDER_BUDGETS = {
  512: { hostBytes: HOST_RENDER, gpuMiB: GPU_RENDER },
  1024: { hostBytes: 18 * 1024 ** 3, gpuMiB: 40 * 1024 },
  '1024_cascade': { hostBytes: 18 * 1024 ** 3, gpuMiB: 48 * 1024 },
  '1536_cascade': { hostBytes: 20 * 1024 ** 3, gpuMiB: 64 * 1024 },
};
export function trellisRenderBudget(request) {
  return TRELLIS_RENDER_BUDGETS[request?.pipeline ?? '512'] || TRELLIS_RENDER_BUDGETS[512];
}

export function createTrellisLoader({
  hardware,
  services,
  baseUrl,
  freeMemory = os.freemem,
  fetcher = fetch,
}) {
  let inFlight = null;
  return function load() {
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
        if (!response.ok || status.engine !== engine || typeof status.loaded !== 'boolean') {
          throw Error('Unexpected response');
        }
      } catch {
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Start the TRELLIS.2 worker first.' },
        };
      }
      if (status.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'TRELLIS.2 is already loaded.' },
        };
      }
      if (status.phase === 'loading') {
        return { status: 202, body: { code: 'loading', message: 'TRELLIS.2 is already loading.' } };
      }
      if (status.model_downloaded !== true) {
        return {
          status: 409,
          body: { code: 'model_missing', message: 'TRELLIS.2 model files are missing.' },
        };
      }
      const free = freeMemory();
      if (hostMemoryShort(free, HOST_LOAD)) {
        return {
          status: 409,
          body: hostMemoryConflict(free, HOST_LOAD, await services(), ['3d-trellis']),
        };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, [], GPU_LOAD);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), GPU_LOAD),
          estimate: 'Uncalibrated TRELLIS.2 load budget plus GPU reserve.',
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
                    'TRELLIS.2 may be loading. Check its worker before clearing the queue barrier.',
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `TRELLIS.2 worker rejected loading (HTTP ${response.status}).`,
                },
              };
        }
        return {
          status: 202,
          body: { code: 'load_requested', message: 'TRELLIS.2 loading requested.', memory: plan },
        };
      } catch {
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              'TRELLIS.2 may be loading. Check its worker before clearing the queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createTrellisPreparation({
  startEngine,
  loadModel,
  autoStart = true,
  freeMemory = os.freemem,
  services = async () => [],
}) {
  return async ({ health, reachable, claimLoad, retryModel = false }) => {
    if (!reachable) {
      if (!autoStart) {
        return { status: 'waiting_engine', stage: 'Waiting for the configured TRELLIS.2 worker.' };
      }
      const result = await startEngine('3d-trellis');
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
      if (['missing', 'failed', 'port_in_use', 'recovery_unresolved'].includes(result.status)) {
        return {
          status: 'needs_attention',
          stage: 'TRELLIS.2 worker could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      return { status: 'waiting_engine', stage: 'Starting the TRELLIS.2 worker.' };
    }
    if (health.phase === 'generating') {
      return { status: 'waiting_engine', stage: 'Waiting for the current TRELLIS.2 render.' };
    }
    if (health.phase === 'loading') {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading TRELLIS.2.', loadBarrier: true };
    }
    if (!health.model_downloaded) {
      return {
        status: 'needs_attention',
        stage: 'TRELLIS.2 model files are missing.',
        error: 'Install the TRELLIS.2, decoder, and DINOv3 files, then retry.',
      };
    }
    if (health.phase === 'error' && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'TRELLIS.2 could not load.',
        error: 'Check the TRELLIS.2 worker logs in Diagnostics, then retry.',
      };
    }
    const free = freeMemory();
    if (hostMemoryShort(free, HOST_RENDER)) {
      return {
        status: 'waiting_memory',
        stage: 'Waiting for system memory.',
        details: hostMemoryConflict(free, HOST_RENDER, await services(), ['3d-trellis']),
      };
    }
    if (!claimLoad()) {
      return null;
    }
    const result = await loadModel();
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'TRELLIS.2 load needs review.',
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
        stage: 'TRELLIS.2 could not load.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for TRELLIS.2.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}

export function createTrellisRenderPreparation({ hardware, services, freeMemory = os.freemem }) {
  return async (request = {}) => {
    const budget = trellisRenderBudget(request);
    const free = freeMemory();
    if (hostMemoryShort(free, budget.hostBytes)) {
      return {
        status: 'waiting_memory',
        stage: 'Waiting for system memory.',
        details: hostMemoryConflict(free, budget.hostBytes, await services(), ['3d-trellis']),
      };
    }
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], budget.gpuMiB);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = {
        ...planModelLoad(
          snapshot,
          (await services()).filter((service) => service.id !== '3d-trellis'),
          budget.gpuMiB,
        ),
        estimate: 'Uncalibrated additional TRELLIS.2 rendering budget plus GPU reserve.',
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
