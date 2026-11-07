// Start a configured worker without loading its model. Engines that require
// credentials or lack a safe load API remain waiting for explicit setup.
export function createServicePreparation({ startEngine, autoStart }) {
  return async function prepareService({ type, reachable, health }) {
    const name =
      { images: 'Qwen Image', sfx: 'Stable Audio', video: 'H3 Studio', world: 'World generation' }[
        type
      ] || 'Engine';
    if (type === 'images' && reachable && health?.model_downloaded === false) {
      return {
        status: 'needs_attention',
        stage: 'Qwen Image model files are missing.',
        error: 'Download the model in Qwen Image Studio, then retry.',
      };
    }
    if (type === 'images' && reachable && health?.status === 'error' && !health.busy) {
      return {
        status: 'needs_attention',
        stage: 'Qwen Image reported an error.',
        error: String(health.error || 'Check Diagnostics, then retry.').slice(0, 2000),
      };
    }
    if (reachable) {
      return {
        status: 'waiting_engine',
        stage:
          type === 'video'
            ? 'Waiting for H3 model files or an active video render.'
            : `Waiting for ${name} to load its model.`,
      };
    }
    if (!autoStart(type)) {
      return { status: 'waiting_engine', stage: `Waiting for the configured ${name} worker.` };
    }
    const result = await startEngine(type);
    if (['missing', 'failed', 'port_in_use', 'recovery_unresolved'].includes(result.status)) {
      return {
        status: 'needs_attention',
        stage: `${name} could not start.`,
        error: result.message || `Worker status: ${result.status}.`,
      };
    }
    return { status: 'waiting_engine', stage: `Starting the ${name} worker.` };
  };
}
