import os from 'node:os';
import { planModelLoad, hostMemoryConflict, hostMemoryShort } from './model-load.js';
import { createLogger } from './app-log.js';

const log = createLogger('game');
const BYTES_PER_MIB = 1024 ** 2;

// A conservative initial estimate for Q4_K_M plus its CUDA working buffers.
// This is not a reservation; concurrent applications may still consume memory.
export const GAME_GPU_BUDGET_MIB = 24 * 1024;
// Host RAM budget estimate in bytes for the game worker. Like other engines it is a soft check:
// only the shared floor in model-load.js blocks by default.
export const GAME_HOST_REQUIRED_BYTES = 6 * 1024 ** 3;

// The worker reports a load as accepted through one of these flags. Any of them means the
// engine has begun loading, so the barrier must be kept.
function isLoadAcknowledged(body) {
  return body?.accepted === true || body?.loading === true || body?.loaded === true;
}

export function createGameLoader({
  hardware,
  services,
  startEngine,
  activity,
  requestLoad,
  freeMemory = os.freemem,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let inFlight = null;
  return function loadGame(markRequested) {
    if (inFlight) {
      return inFlight;
    }
    // Host RAM and GPU admission. Returns { refusal } with the 409 body, or { plan } to report.
    const admitLoad = async () => {
      const free = freeMemory();
      if (hostMemoryShort(free, GAME_HOST_REQUIRED_BYTES)) {
        log.warn('game.load.rejected', {
          reason: 'host_memory_short',
          freeMiB: Math.floor(free / BYTES_PER_MIB),
          requiredMiB: GAME_HOST_REQUIRED_BYTES / BYTES_PER_MIB,
        });
        return {
          refusal: {
            status: 409,
            body: hostMemoryConflict(free, GAME_HOST_REQUIRED_BYTES, await services(), ['game']),
          },
        };
      }
      const gpu = await hardware();
      let plan = planModelLoad(gpu, [], GAME_GPU_BUDGET_MIB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(gpu, await services(), GAME_GPU_BUDGET_MIB),
          estimate: 'Conservative, uncalibrated Mammoth GPU budget plus system reserve.',
        };
      }
      log.info('game.memory.checked', {
        requiredMiB: plan.requiredMiB,
        freeMiB: plan.device?.freeMiB,
      });
      if (plan.code !== 'ready') {
        log.warn('game.load.rejected', { reason: plan.code });
        return { refusal: { status: 409, body: plan } };
      }
      return { plan };
    };
    inFlight = (async () => {
      let initial = (await services()).find((service) => service.id === 'game');
      if (initial?.ownershipRecovery === 'checking') {
        await startEngine('game');
        initial = (await services()).find((service) => service.id === 'game');
      }
      if (initial?.ownershipRecovery === 'unresolved') {
        if (!markRequested()) {
          log.error('game.load.barrier.failed', { reason: 'reserve_failed' });
          throw Error('Could not reserve the model-load barrier.');
        }
        return {
          status: 503,
          keepBarrier: true,
          body: {
            code: 'load_unknown',
            message: 'Mammoth ownership needs review; its worker may still be starting or loading.',
          },
        };
      }
      if (initial?.status === 'reachable' && !initial.managed) {
        return initial.modelLoaded === true
          ? {
              status: 200,
              body: {
                code: 'already_loaded',
                message: 'The separately managed Mammoth service is already loaded.',
              },
            }
          : {
              status: 409,
              body: {
                code: 'external_service',
                message:
                  'Mammoth is running outside Forge. Load it in its own application or stop it before starting Forge’s managed service.',
              },
            };
      }
      // Admission runs before the worker starts, so a refused load leaves no idle Mammoth
      // process behind. A worker that already reports a loaded model is not re-admitted.
      const admission = initial?.modelLoaded === true ? { plan: null } : await admitLoad();
      if (admission.refusal) {
        return admission.refusal;
      }
      const started = await startEngine('game');
      if (started.status === 'recovery_unresolved') {
        if (!markRequested()) {
          log.error('game.load.barrier.failed', { reason: 'reserve_failed' });
          throw Error('Could not reserve the model-load barrier.');
        }
        return {
          status: 503,
          keepBarrier: true,
          body: {
            code: 'load_unknown',
            message:
              started.message ||
              'Mammoth may still be starting. Check the worker before clearing the queue barrier.',
          },
        };
      }
      if (!['starting', 'already_managed'].includes(started.status)) {
        return {
          status: 409,
          body: {
            code: 'engine_unavailable',
            message: started.message || `Mammoth service status: ${started.status}.`,
          },
        };
      }
      const stopWorkerWait = log.time('game.worker.wait.completed');
      let state = null;
      // Polls up to 30 times, 250 ms apart (about 7.5 s), for the worker to answer status.
      for (let i = 0; i < 30; i++) {
        state = await activity();
        if (state) {
          break;
        }
        await wait(250);
      }
      stopWorkerWait({ outcome: state ? 'ready' : 'timeout' });
      if (!state) {
        log.warn('game.worker.timeout', { reason: 'worker_not_ready' });
        return {
          status: 503,
          body: {
            code: 'engine_unavailable',
            message: 'The managed Mammoth worker did not become ready. Check its logs.',
          },
        };
      }
      if (state.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'Mammoth is already loaded.' },
        };
      }
      if (state.loading) {
        log.info('game.load.barrier.waiting', { reason: 'model_loading' });
        if (!markRequested()) {
          log.error('game.load.barrier.failed', { reason: 'reserve_failed' });
          throw Error('Could not reserve the model-load barrier.');
        }
        return {
          status: 202,
          keepBarrier: true,
          body: { code: 'loading', message: 'Mammoth is loading.' },
        };
      }
      if (state.load_finished) {
        return {
          status: 409,
          body: {
            code: 'previous_load_failed',
            message:
              'The previous Mammoth load finished without a model. Stop its managed worker and retry to start a fresh one.',
          },
        };
      }
      if (!state.model_downloaded) {
        return {
          status: 409,
          body: {
            code: 'model_missing',
            message: 'Verified Mammoth model files were not found in the Studio model folder.',
          },
        };
      }
      if (!markRequested()) {
        log.error('game.load.barrier.failed', { reason: 'reserve_failed' });
        throw Error('Could not reserve the model-load barrier.');
      }
      const stopLoadRequest = log.time('game.load.request.completed');
      try {
        const response = await requestLoad();
        stopLoadRequest({ httpStatus: response.status });
        if (response.status >= 400 && response.status < 500) {
          log.warn('game.load.rejected', { reason: 'load_rejected', httpStatus: response.status });
          return {
            status: 409,
            body: {
              code: 'load_rejected',
              message: response.body?.error || 'Mammoth rejected the load request.',
            },
          };
        }
        const isAcceptedStatus = response.status >= 200 && response.status < 300;
        if (isAcceptedStatus && isLoadAcknowledged(response.body)) {
          return {
            status: 202,
            keepBarrier: true,
            body: {
              code: 'load_requested',
              message: 'Mammoth model loading requested.',
              memory: admission.plan,
            },
          };
        }
      } catch (error) {
        log.warn('game.load.request.failed', {
          reason: 'load_outcome_unknown',
          errorClass: error?.name,
          errorCode: error?.code,
        });
        // A lost reply cannot prove whether loading started; keep the barrier.
      }
      return {
        status: 503,
        keepBarrier: true,
        body: {
          code: 'load_unknown',
          message: 'Mammoth may be loading. Check the worker before clearing its queue barrier.',
        },
      };
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
