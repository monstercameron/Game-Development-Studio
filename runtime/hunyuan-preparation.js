import os from 'node:os';
import { createLogger } from './app-log.js';
import { planModelLoad, hostMemoryConflict, hostMemoryShort } from './model-load.js';
import { resolveAutoStart } from './service-preparation.js';

const log = createLogger('three-d');

// Measured one 128-resolution run at roughly 10 GiB GPU and 5 GiB host memory.
// Higher resolutions have not been calibrated; these remain admission estimates.
export const HUNYUAN_GPU_BUDGET_MIB = 16 * 1024;
export const HUNYUAN_HOST_REQUIRED_BYTES = 8 * 1024 ** 3;
// Optional texture stage, measured once at 1024: 14.0 GiB peak GPU allocation and 12.3 GiB peak
// worker RSS (model loading dominates) on top of the resident shape model. The shape stage's
// working memory is released before painting, so the stages need the larger of the two,
// not the sum.
export const HUNYUAN_TEXTURE_GPU_BUDGET_MIB = 16 * 1024;
export const HUNYUAN_TEXTURE_HOST_REQUIRED_BYTES = 12 * 1024 ** 3;
// Eight views at 768 px used about 15 GB more GPU memory than the default six at 512 px
// (measured 2026-11-07). The same increase is added for any larger painter setting.
export const HUNYUAN_TEXTURE_EXTRA_VIEWS_MIB = 16 * 1024;

/**
 * Creates the shape-model load gate for the 3D render path. Concurrent callers share one
 * in-flight check and load request. Worker status and load failures are returned as
 * { status, body } results (503 for an unreachable worker or an unknown load outcome), so the
 * caller can keep the queue barrier in place.
 */
export function createHunyuanLoader({
  hardware,
  services,
  baseUrl,
  freeMemory = os.freemem,
  fetcher = fetch,
}) {
  let inFlight = null;
  return function loadHunyuan() {
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
          status.engine !== 'forge-hunyuan-shape-v1' ||
          typeof status.loaded !== 'boolean'
        ) {
          throw Error('Unexpected response');
        }
      } catch (error) {
        log.debug('three-d.hunyuan.status.failed', { error });
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Start the Hunyuan shape worker first.' },
        };
      }
      if (status.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'Hunyuan shape model is already loaded.' },
        };
      }
      if (status.phase === 'loading') {
        return {
          status: 202,
          body: { code: 'loading', message: 'Hunyuan shape model is already loading.' },
        };
      }
      if (status.model_downloaded !== true) {
        return {
          status: 409,
          body: { code: 'model_missing', message: 'Hunyuan shape model files are missing.' },
        };
      }
      const freeHostBytes = freeMemory();
      if (hostMemoryShort(freeHostBytes, HUNYUAN_HOST_REQUIRED_BYTES)) {
        log.warn('three-d.hunyuan.memory.rejected', { reason: 'insufficient_host_memory' });
        return {
          status: 409,
          body: hostMemoryConflict(freeHostBytes, HUNYUAN_HOST_REQUIRED_BYTES, await services(), [
            '3d-hunyuan',
          ]),
        };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, [], HUNYUAN_GPU_BUDGET_MIB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), HUNYUAN_GPU_BUDGET_MIB),
          estimate: 'Conservative, uncalibrated Hunyuan shape GPU budget plus system reserve.',
        };
      }
      log.info('three-d.hunyuan.memory.checked', {
        freeMiB: plan.device?.freeMiB,
        requiredMiB: plan.requiredMiB,
        budgetMiB: HUNYUAN_GPU_BUDGET_MIB,
      });
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
          log.warn('three-d.hunyuan.load.rejected', { httpStatus: response.status });
          return response.status >= 500
            ? {
                status: 503,
                body: {
                  code: 'load_unknown',
                  message:
                    'The shape model may be loading. Check its worker before clearing the queue barrier.',
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `Shape worker rejected loading (HTTP ${response.status}).`,
                },
              };
        }
        log.info('three-d.hunyuan.load.requested');
        return {
          status: 202,
          body: {
            code: 'load_requested',
            message: 'Hunyuan shape model loading requested.',
            memory: plan,
          },
        };
      } catch (error) {
        log.warn('three-d.hunyuan.load.unknown', { error, reason: 'load_unknown' });
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              'The shape model may be loading. Check its worker before clearing the queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * Creates the queue preparation step that starts, loads, or waits for the shape worker.
 * Returns null when another caller already holds the model-load barrier (claimLoad() returned
 * false). Callers must not treat null as a ready state.
 */
export function createHunyuanPreparation({ startEngine, loadModel, autoStart = true }) {
  return async ({ health, reachable, claimLoad, retryModel = false }) => {
    if (!reachable) {
      if (!resolveAutoStart(autoStart)) {
        log.info('three-d.hunyuan.start.skipped', { reason: 'autostart_disabled' });
        return { status: 'waiting_engine', stage: 'Waiting for the configured shape worker.' };
      }
      log.info('three-d.hunyuan.start.started');
      const result = await startEngine('3d-hunyuan');
      if (result.status === 'recovery_unresolved') {
        log.warn('three-d.hunyuan.start.unresolved', { reason: 'recovery_unresolved' });
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
        log.warn('three-d.hunyuan.start.rejected', {
          reason: 'start_failed',
          status: result.status,
        });
        return {
          status: 'needs_attention',
          stage: 'Shape worker could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      log.info('three-d.hunyuan.start.completed', { status: result.status });
      return { status: 'waiting_engine', stage: 'Starting the shape worker.' };
    }
    if (health.phase === 'generating') {
      return { status: 'waiting_engine', stage: 'Waiting for the current 3D render.' };
    }
    if (health.phase === 'loading') {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading Hunyuan shape model.', loadBarrier: true };
    }
    if (!health.model_downloaded) {
      return {
        status: 'needs_attention',
        stage: 'Shape model files are missing.',
        error: 'Install Hunyuan3D shape files, then retry.',
      };
    }
    if (health.phase === 'error' && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'Shape model could not load.',
        error: 'Check the shape worker logs in Diagnostics, then retry.',
      };
    }
    if (!claimLoad()) {
      return null;
    }
    log.info('three-d.hunyuan.barrier.persisted');
    const result = await loadModel();
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'Shape model load needs review.',
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
        stage: 'Shape model could not load.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for Hunyuan.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}

/**
 * Creates the admission check for a 3D render. Returns null when the resolution and texture
 * settings fit the GPU budget; otherwise returns a waiting_memory or needs_attention stage.
 */
export function createHunyuanRenderPreparation({ hardware, services, freeMemory = os.freemem }) {
  return async ({ resolution, texture = false, texture_views = 6, texture_view_size = 512 }) => {
    const freeHostBytes = freeMemory();
    const hostRequired = texture ? HUNYUAN_TEXTURE_HOST_REQUIRED_BYTES : 4 * 1024 ** 3;
    if (hostMemoryShort(freeHostBytes, hostRequired)) {
      return {
        status: 'waiting_memory',
        stage: 'Waiting for system memory.',
        details: hostMemoryConflict(freeHostBytes, hostRequired, await services(), ['3d-hunyuan']),
      };
    }
    const shapeBudget = { 128: 4096, 256: 8192, 384: 16384 }[resolution];
    const budget =
      shapeBudget && texture
        ? Math.max(shapeBudget, HUNYUAN_TEXTURE_GPU_BUDGET_MIB) +
          (texture_views > 6 || texture_view_size > 512 ? HUNYUAN_TEXTURE_EXTRA_VIEWS_MIB : 0)
        : shapeBudget;
    if (!budget) {
      return {
        status: 'needs_attention',
        stage: 'Invalid 3D resolution.',
        error: 'Choose a supported mesh resolution.',
      };
    }
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], budget);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = {
        ...planModelLoad(
          snapshot,
          (await services()).filter((service) => service.id !== '3d-hunyuan'),
          budget,
        ),
        estimate: texture
          ? 'Uncalibrated additional working-memory estimate for this 3D resolution plus the texture stage.'
          : 'Uncalibrated additional working-memory estimate for this 3D resolution.',
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
