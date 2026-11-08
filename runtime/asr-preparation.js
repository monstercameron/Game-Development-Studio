import { access } from 'node:fs/promises';
import { createLogger } from './app-log.js';
import { localAsrUrl } from './asr-client.js';
import { interpretStatus } from './catalog.js';
import { planModelLoad } from './model-load.js';

const log = createLogger('asr');

// The GGUF and its CUDA workspace have not yet been calibrated under load.
export const ASR_BUDGET_MIB = 4 * 1024;

export async function probeAsr(baseUrl, fetcher = fetch) {
  try {
    const response = await fetcher(new URL('/v1/models', localAsrUrl(baseUrl)), {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) {
      log.debug('asr.probe.failed', { httpStatus: response.status });
      return false;
    }
    return !!interpretStatus('nemotron-asr', await response.json());
  } catch (error) {
    // Not running is the normal state before a start request, so this stays at debug.
    log.debug('asr.probe.failed', { errorClass: error?.name });
    return false;
  }
}

// `begin` must persist the queue barrier *before* requesting process creation.
// Any ambiguous response retains that barrier until readiness or manual review.
export function createAsrStarter({
  hardware,
  services,
  startEngine,
  modelFile,
  baseUrl,
  fetcher = fetch,
  checkFile = access,
}) {
  return async function startAsr(begin) {
    log.info('asr.start.started');
    if (await probeAsr(baseUrl, fetcher)) {
      log.info('asr.start.skipped', { reason: 'already_loaded' });
      return {
        status: 200,
        body: { code: 'already_loaded', message: 'Nemotron ASR is ready.' },
        keepBarrier: false,
      };
    }
    try {
      await checkFile(modelFile);
    } catch (error) {
      log.warn('asr.start.rejected', { reason: 'model_missing', errorClass: error?.name });
      return {
        status: 409,
        body: { code: 'model_missing', message: 'Nemotron ASR model file is missing.' },
        keepBarrier: false,
      };
    }
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], ASR_BUDGET_MIB);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = {
        ...planModelLoad(snapshot, await services(), ASR_BUDGET_MIB),
        estimate: 'Conservative, uncalibrated estimate for Nemotron ASR and its working memory.',
      };
    }
    log.info('asr.memory.checked', {
      freeMiB: plan.device?.freeMiB,
      requiredMiB: plan.requiredMiB,
      budgetMiB: ASR_BUDGET_MIB,
    });
    if (plan.code !== 'ready') {
      log.warn('asr.start.rejected', { reason: plan.code });
      return { status: 409, body: plan, keepBarrier: false };
    }
    if (!begin()) {
      log.error('asr.barrier.failed');
      throw Error('Could not persist the speech model-load barrier.');
    }
    log.info('asr.barrier.persisted');
    const stopEngineStart = log.time('asr.engine.returned');
    try {
      const result = await startEngine('asr');
      stopEngineStart({ status: result.status });
      if (result.status === 'recovery_unresolved') {
        log.warn('asr.start.unresolved', { reason: 'recovery_unresolved' });
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              result.message ||
              'Speech startup may still be in progress. Check its worker before clearing the queue barrier.',
          },
          keepBarrier: true,
        };
      }
      if (['missing', 'failed', 'port_in_use', 'deleting'].includes(result.status)) {
        log.warn('asr.start.rejected', { reason: 'start_failed', status: result.status });
        return {
          status: 409,
          body: {
            code: 'start_failed',
            message: result.message || `Speech service: ${result.status}.`,
          },
          keepBarrier: false,
        };
      }
      log.info('asr.start.completed', { pid: result.pid });
      return {
        status: 202,
        body: {
          code: 'load_requested',
          message: 'Nemotron ASR is starting and loading its model.',
          pid: result.pid ?? null,
          memory: plan,
        },
        keepBarrier: true,
      };
    } catch (error) {
      log.error('asr.start.failed', { reason: 'load_unknown', errorClass: error?.name });
      return {
        status: 503,
        body: {
          code: 'load_unknown',
          message:
            'Speech startup may have begun. Check the service before clearing its queue barrier.',
        },
        keepBarrier: true,
      };
    }
  };
}
