import { planModelLoad } from './model-load.js';
import { resolveAutoStart } from './service-preparation.js';
import { TTS_CHECKPOINTS, loadedCheckpoint } from './voice-modes.js';
import { createLogger } from './app-log.js';

const log = createLogger('voices');

export const TTS_BUDGET_MIB = TTS_CHECKPOINTS.custom_voice.budgetMiB;

// Whether the worker has this checkpoint's files. Workers from before the variant change only report
// model_downloaded for the preset checkpoint.
export function checkpointInstalled(health, checkpoint) {
  if (health?.variants) {
    return health.variants[checkpoint] === true;
  }
  return checkpoint === 'custom_voice' && health?.model_downloaded === true;
}

// variant selects the checkpoint to load (custom_voice, base or voice_design). Without one, the
// call only confirms that some checkpoint is loaded and never swaps the resident model.
export function createTtsLoader({ hardware, services, baseUrl, fetcher = fetch }) {
  let inFlight = null;
  return function loadTts(variant = null) {
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
          status.engine !== 'forge-qwen3-tts-v1' ||
          typeof status.loaded !== 'boolean'
        ) {
          throw Error('Unexpected response');
        }
      } catch (error) {
        // Not running is the normal state before a start request, so this stays at debug.
        log.debug('voices.status.failed', {
          errorClass: error?.name,
          reason: 'engine_unavailable',
        });
        return {
          status: 503,
          body: {
            code: 'engine_unavailable',
            message: 'Start Qwen3-TTS before loading its model.',
          },
        };
      }
      const resident = loadedCheckpoint(status);
      if (status.loaded && (variant === null || resident === variant)) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'Qwen3-TTS is already loaded.' },
        };
      }
      if (status.phase === 'loading') {
        return { status: 202, body: { code: 'loading', message: 'Qwen3-TTS is already loading.' } };
      }
      const target = variant ?? 'custom_voice';
      const checkpoint = TTS_CHECKPOINTS[target];
      if (!checkpoint) {
        return {
          status: 400,
          body: { code: 'unknown_checkpoint', message: 'Unknown speech checkpoint.' },
        };
      }
      if (target !== 'custom_voice' && !status.variants) {
        return {
          status: 409,
          body: {
            code: 'worker_restart_required',
            message: `Restart Qwen3-TTS so it can load the ${checkpoint.label} checkpoint.`,
          },
        };
      }
      if (!checkpointInstalled(status, target)) {
        return {
          status: 409,
          body: {
            code: 'model_missing',
            message: `${checkpoint.label} files are missing. Install the ${checkpoint.folder} checkpoint, then retry.`,
          },
        };
      }
      const snapshot = await hardware();
      // The resident checkpoint is still counted: the worker unloads it only after this admission.
      let plan = planModelLoad(snapshot, [], checkpoint.budgetMiB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), checkpoint.budgetMiB),
          estimate: `Conservative uncalibrated estimate for ${checkpoint.label} and working memory.`,
        };
      }
      log.info('voices.memory.checked', {
        requiredMiB: plan.requiredMiB,
        freeMiB: plan.device?.freeMiB,
        budgetMiB: checkpoint.budgetMiB,
      });
      if (plan.code !== 'ready') {
        log.warn('voices.start.rejected', { reason: plan.code });
        return { status: 409, body: plan };
      }
      try {
        const response = await fetcher(`${baseUrl}/api/model/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ variant: target }),
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        if (!response.ok) {
          log.warn('voices.load.rejected', { httpStatus: response.status });
          return response.status >= 500
            ? {
                status: 503,
                body: {
                  code: 'load_unknown',
                  message:
                    'The speech model load may have started. Check the worker before clearing its queue barrier.',
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `Speech worker rejected loading (HTTP ${response.status}).`,
                },
              };
        }
        log.info('voices.load.requested', { httpStatus: response.status });
        return {
          status: 202,
          body: {
            code: 'load_requested',
            message: `${checkpoint.label} loading requested.`,
            variant: target,
            memory: plan,
          },
        };
      } catch (error) {
        log.warn('voices.load.unknown', {
          errorClass: error?.name,
          reason: 'load_unknown',
        });
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              'The speech model load may have started. Check the worker before clearing its queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createTtsPreparation({ startEngine, loadModel, autoStart = true }) {
  return async function prepareTts({
    health,
    reachable,
    claimLoad,
    retryModel = false,
    variant = 'custom_voice',
  }) {
    if (!reachable) {
      if (!resolveAutoStart(autoStart)) {
        log.info('voices.start.skipped', { reason: 'autostart_disabled' });
        return { status: 'waiting_engine', stage: 'Waiting for the configured speech worker.' };
      }
      log.info('voices.start.started');
      const result = await startEngine('tts');
      if (result.status === 'recovery_unresolved') {
        log.warn('voices.start.unresolved', { reason: 'recovery_unresolved' });
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
        log.warn('voices.start.rejected', { reason: 'start_failed', status: result.status });
        return {
          status: 'needs_attention',
          stage: 'Speech worker could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      log.info('voices.start.completed');
      return { status: 'waiting_engine', stage: 'Starting the speech worker.' };
    }
    if (health.phase === 'generating') {
      return {
        status: 'waiting_engine',
        stage: 'Waiting for the speech worker to finish its current render.',
      };
    }
    if (health.phase === 'loading') {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading Qwen3-TTS.', loadBarrier: true };
    }
    if (!checkpointInstalled(health, variant)) {
      const checkpoint = TTS_CHECKPOINTS[variant];
      return {
        status: 'needs_attention',
        stage: 'Speech model files are missing.',
        error: `Install the ${checkpoint.folder} checkpoint (${checkpoint.label}), then retry.`,
      };
    }
    if (health.phase === 'error' && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'Speech model could not load.',
        error: 'Check the speech worker logs in Diagnostics, then retry.',
      };
    }
    if (!claimLoad()) {
      return null;
    }
    log.info('voices.barrier.persisted');
    const result = await loadModel(variant);
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'Speech model load request needs review.',
        error: result.body.message,
        loadBarrier: true,
      };
    }
    if (result.body?.code === 'insufficient_gpu_memory') {
      return { status: 'waiting_memory', stage: 'Waiting for GPU memory.', details: result.body };
    }
    if (result.body?.code === 'gpu_memory_unavailable') {
      return {
        status: 'needs_attention',
        stage: 'GPU memory is unavailable.',
        error: result.body.message,
      };
    }
    if (result.status >= 400 && result.body?.code !== 'engine_unavailable') {
      return {
        status: 'needs_attention',
        stage: 'Speech model load failed.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for Qwen3-TTS to load.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}
