import { planModelLoad } from './model-load.js';

export const TTS_BUDGET_MIB = 12 * 1024;
export function createTtsLoader({ hardware, services, baseUrl, fetcher = fetch }) {
  let inFlight = null;
  return function loadTts() {
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
      } catch {
        return {
          status: 503,
          body: {
            code: 'engine_unavailable',
            message: 'Start Qwen3-TTS before loading its model.',
          },
        };
      }
      if (status.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'Qwen3-TTS is already loaded.' },
        };
      }
      if (status.phase === 'loading') {
        return { status: 202, body: { code: 'loading', message: 'Qwen3-TTS is already loading.' } };
      }
      if (status.model_downloaded !== true) {
        return {
          status: 409,
          body: { code: 'model_missing', message: 'Qwen3-TTS model files are missing.' },
        };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, [], TTS_BUDGET_MIB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), TTS_BUDGET_MIB),
          estimate: 'Conservative uncalibrated estimate for the speech model and working memory.',
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
        return {
          status: 202,
          body: {
            code: 'load_requested',
            message: 'Qwen3-TTS model loading requested.',
            memory: plan,
          },
        };
      } catch {
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
  return async function prepareTts({ health, reachable, claimLoad, retryModel = false }) {
    if (!reachable) {
      if (!autoStart) {
        return { status: 'waiting_engine', stage: 'Waiting for the configured speech worker.' };
      }
      const result = await startEngine('tts');
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
          stage: 'Speech worker could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
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
    if (!health.model_downloaded) {
      return {
        status: 'needs_attention',
        stage: 'Speech model files are missing.',
        error: 'Install the Qwen3-TTS model, then retry.',
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
    const result = await loadModel();
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
