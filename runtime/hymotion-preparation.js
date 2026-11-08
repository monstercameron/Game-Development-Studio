import os from 'node:os';
import { createLogger } from './app-log.js';
import { planModelLoad, hostMemoryConflict, hostMemoryShort } from './model-load.js';
import { resolveAutoStart } from './service-preparation.js';

const log = createLogger('motion');

// One short text-to-motion test succeeded. These admission budgets remain conservative
// estimates, not reservations or limits on other applications.
export const HYMOTION_HOST_LOAD_BYTES = 9 * 1024 ** 3;
export const HYMOTION_GPU_LOAD_MIB = 26 * 1024;
export const HYMOTION_GPU_RENDER_MIB = 8 * 1024;

export function createHyMotionLoader({
  hardware,
  services,
  baseUrl,
  freeMemory = os.freemem,
  fetcher = fetch,
}) {
  let inFlight = null;
  return function loadHyMotion() {
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
          status.engine !== 'forge-hy-motion-v1' ||
          typeof status.loaded !== 'boolean'
        ) {
          throw Error('Unexpected response');
        }
      } catch (error) {
        log.debug('motion.hymotion.status.failed', { error });
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Start the HY-Motion worker first.' },
        };
      }
      if (status.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'HY-Motion is already loaded.' },
        };
      }
      if (status.phase === 'loading') {
        return { status: 202, body: { code: 'loading', message: 'HY-Motion is already loading.' } };
      }
      if (status.model_downloaded !== true) {
        return {
          status: 409,
          body: { code: 'model_missing', message: 'The HY-Motion checkpoint is missing.' },
        };
      }
      const free = freeMemory();
      if (hostMemoryShort(free, HYMOTION_HOST_LOAD_BYTES)) {
        log.warn('motion.hymotion.memory.rejected', { reason: 'insufficient_host_memory' });
        return {
          status: 409,
          body: hostMemoryConflict(free, HYMOTION_HOST_LOAD_BYTES, await services(), ['motion-hy']),
        };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, [], HYMOTION_GPU_LOAD_MIB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), HYMOTION_GPU_LOAD_MIB),
          estimate: 'Conservative, uncalibrated HY-Motion GPU budget plus system reserve.',
        };
      }
      log.info('motion.hymotion.memory.checked', {
        freeMiB: plan.device?.freeMiB,
        requiredMiB: plan.requiredMiB,
        budgetMiB: HYMOTION_GPU_LOAD_MIB,
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
          log.warn('motion.hymotion.load.rejected', { httpStatus: response.status });
          return response.status >= 500
            ? {
                status: 503,
                body: {
                  code: 'load_unknown',
                  message:
                    'HY-Motion may be loading. Check the worker before clearing its queue barrier.',
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `Motion worker rejected loading (HTTP ${response.status}).`,
                },
              };
        }
        log.info('motion.hymotion.load.requested');
        return {
          status: 202,
          body: { code: 'load_requested', message: 'HY-Motion loading requested.', memory: plan },
        };
      } catch (error) {
        log.warn('motion.hymotion.load.unknown', { error, reason: 'load_unknown' });
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              'HY-Motion may be loading. Check the worker before clearing its queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createHyMotionPreparation({ startEngine, loadModel, autoStart = true }) {
  return async ({ health, reachable, claimLoad, retryModel = false }) => {
    if (!reachable) {
      if (!resolveAutoStart(autoStart)) {
        log.info('motion.hymotion.start.skipped', { reason: 'autostart_disabled' });
        return { status: 'waiting_engine', stage: 'Waiting for the configured motion worker.' };
      }
      log.info('motion.hymotion.start.started');
      const result = await startEngine('motion-hy');
      if (result.status === 'recovery_unresolved') {
        log.warn('motion.hymotion.start.unresolved', { reason: 'recovery_unresolved' });
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
        log.warn('motion.hymotion.start.rejected', {
          reason: 'start_failed',
          status: result.status,
        });
        return {
          status: 'needs_attention',
          stage: 'Motion worker could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      log.info('motion.hymotion.start.completed', { status: result.status });
      return { status: 'waiting_engine', stage: 'Starting the motion worker.' };
    }
    if (['preparing', 'generating'].includes(health.phase)) {
      return { status: 'waiting_engine', stage: 'Waiting for the current motion render.' };
    }
    if (health.phase === 'loading') {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading HY-Motion.', loadBarrier: true };
    }
    if (!health.model_downloaded) {
      return {
        status: 'needs_attention',
        stage: 'HY-Motion checkpoint is missing.',
        error: 'Install the HY-Motion checkpoint, then retry.',
      };
    }
    if (health.phase === 'error' && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'HY-Motion could not load.',
        error: health.error || 'Check the worker logs in Diagnostics, then retry.',
      };
    }
    if (!claimLoad()) {
      return null;
    }
    log.info('motion.hymotion.barrier.persisted');
    const result = await loadModel();
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'Motion model load needs review.',
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
        stage: 'HY-Motion could not load.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for HY-Motion.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}

export function createHyMotionRenderPreparation({ hardware, services, freeMemory = os.freemem }) {
  return async ({ duration }) => {
    const hostGiB = duration <= 5 ? 4 : 6,
      budget = duration <= 5 ? HYMOTION_GPU_RENDER_MIB : 16 * 1024;
    const free = freeMemory();
    if (hostMemoryShort(free, hostGiB * 1024 ** 3)) {
      return {
        status: 'waiting_memory',
        stage: 'Waiting for system memory.',
        details: hostMemoryConflict(free, hostGiB * 1024 ** 3, await services(), ['motion-hy']),
      };
    }
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], budget);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = {
        ...planModelLoad(
          snapshot,
          (await services()).filter((service) => service.id !== 'motion-hy'),
          budget,
        ),
        estimate: 'Uncalibrated additional working-memory estimate for HY-Motion.',
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
