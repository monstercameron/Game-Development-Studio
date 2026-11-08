import { resolveAutoStart } from './service-preparation.js';

/**
 * Start the worker and load YuE2 only when a queued job actually needs it.
 *
 * The returned `prepareMusic` resolves to a status object, or to `null` when another
 * caller already holds the model-load claim (`claimLoad()` returned false). A
 * `loadBarrier: true` result means the load request may still be running, so the
 * caller must keep the barrier until the engine reports it is no longer loading.
 */
export function createMusicPreparation({ startEngine, loadModel, autoStart = true }) {
  return async function prepareMusic({ health, reachable, claimLoad, retryModel = false }) {
    if (!reachable) {
      if (!resolveAutoStart(autoStart)) {
        return { status: 'waiting_engine', stage: 'Waiting for the configured YuE2 worker.' };
      }
      const result = await startEngine('music');
      if (['missing', 'failed', 'port_in_use'].includes(result.status)) {
        return {
          status: 'needs_attention',
          stage: 'YuE2 could not start.',
          error: result.message || `Worker status: ${result.status}.`,
        };
      }
      return { status: 'waiting_engine', stage: 'Starting the YuE2 worker.' };
    }
    if (health.model?.loading) {
      if (!claimLoad()) {
        return null;
      }
      return { status: 'waiting_engine', stage: 'Loading YuE2 model.', loadBarrier: true };
    }
    if (health.model?.error && !retryModel) {
      return {
        status: 'needs_attention',
        stage: 'YuE2 could not load its model.',
        error: 'Check the YuE2 engine log in Diagnostics, then retry.',
      };
    }
    if (!claimLoad()) {
      return null;
    }
    const result = await loadModel();
    if (result.body?.code === 'load_unknown') {
      return {
        status: 'needs_attention',
        stage: 'YuE2 load request needs review.',
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
        stage: 'YuE2 model load failed.',
        error: result.body?.message || 'Check Diagnostics.',
      };
    }
    return {
      status: 'waiting_engine',
      stage: result.body?.message || 'Waiting for YuE2 to load.',
      loadBarrier: ['load_requested', 'loading'].includes(result.body?.code),
    };
  };
}
