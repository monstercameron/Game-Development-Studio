import { planModelLoad } from './model-load.js';

// The cached fp16 model is approximately 10 GiB. This working-memory budget
// is conservative and uncalibrated; generation duration can change usage.
export const SOUND_BUDGET_MIB = 20 * 1024;
export function createSoundLoader({
  hardware,
  services,
  baseUrl,
  fetcher = fetch,
  getToken = async () => '',
}) {
  let inFlight = null;
  return function loadSound(token = '') {
    if (typeof token !== 'string' || token.length > 1000 || /[\r\n]/.test(token)) {
      throw Error('Invalid model access token.');
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      let health;
      try {
        const response = await fetcher(`${baseUrl}/api/status`, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        health = await response.json();
        if (
          !response.ok ||
          typeof health.phase !== 'string' ||
          typeof health.loaded !== 'boolean'
        ) {
          throw Error('Unexpected response');
        }
      } catch {
        return {
          status: 503,
          body: {
            code: 'engine_unavailable',
            message: 'Start Stable Audio before loading its model.',
          },
        };
      }
      if (health.loaded) {
        return {
          status: 200,
          body: { code: 'already_loaded', message: 'Stable Audio is already loaded.' },
        };
      }
      if (health.phase === 'loading') {
        return {
          status: 202,
          body: { code: 'loading', message: 'Stable Audio is already loading.' },
        };
      }
      if (health.phase === 'generating') {
        return { status: 409, body: { code: 'engine_busy', message: 'Stable Audio is busy.' } };
      }
      const snapshot = await hardware();
      let plan = planModelLoad(snapshot, [], SOUND_BUDGET_MIB);
      if (plan.code === 'insufficient_gpu_memory') {
        plan = {
          ...planModelLoad(snapshot, await services(), SOUND_BUDGET_MIB),
          estimate: 'Conservative uncalibrated estimate for the sound model and working memory.',
        };
      }
      if (plan.code !== 'ready') {
        return { status: 409, body: plan };
      }
      let session;
      try {
        const response = await fetcher(`${baseUrl}/api/session`, {
          signal: AbortSignal.timeout(3000),
          redirect: 'error',
        });
        const data = await response.json();
        if (!response.ok || typeof data.session !== 'string' || data.session.length > 512) {
          throw Error('Invalid session');
        }
        session = data.session;
      } catch {
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Could not obtain a Stable Audio session.' },
        };
      }
      let credential;
      try {
        credential = token || (await getToken());
      } catch {
        return {
          status: 503,
          body: { code: 'engine_unavailable', message: 'Could not check model access.' },
        };
      }
      try {
        const response = await fetcher(`${baseUrl}/api/load`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lab-Session': session },
          body: JSON.stringify({ token: credential }),
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
                    'The sound model load may have started. Check the worker before clearing its queue barrier.',
                },
              }
            : {
                status: 502,
                body: {
                  code: 'load_rejected',
                  message: `Stable Audio rejected the load request (HTTP ${response.status}).`,
                },
              };
        }
        return {
          status: 202,
          body: {
            code: 'load_requested',
            message: 'Stable Audio model loading requested.',
            memory: plan,
          },
        };
      } catch {
        return {
          status: 503,
          body: {
            code: 'load_unknown',
            message:
              'The sound model load may have started. Check the worker before clearing its queue barrier.',
          },
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export function createSoundPreparation({ startEngine, loadModel, autoStart = true }) {
  return async function prepareSound({ health, reachable, claimLoad, retryModel = false }) {
    if (!reachable) {
      if (!autoStart) {
        return {
          status: 'waiting_engine',
          stage: 'Waiting for the configured Stable Audio worker.',
        };
      }
      const result = await startEngine('sfx');
      if (['missing', 'failed', 'port_in_use'].includes(result.status)) {
        return {
          status: 'needs_attention',
          stage: 'Stable Audio could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      return { status: 'waiting_engine', stage: 'Starting the Stable Audio worker.' };
    }
    if (health.phase === 'generating') {
      return {
        status: 'waiting_engine',
        stage: 'Waiting for Stable Audio to finish its current render.',
      };
    }
    if (health.phase === 'loading') {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading Stable Audio model.', loadBarrier: true };
    }
    if (health.phase === 'error' && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'Stable Audio could not load.',
        error: 'Check model access in Models & services and the Stable Audio logs, then retry.',
      };
    }
    if (!claimLoad()) {
      return null;
    }
    const result = await loadModel();
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'Stable Audio load request needs review.',
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
        stage: 'Stable Audio model load failed.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for Stable Audio to load.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}
