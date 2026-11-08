// Restart only Forge's own output-recoverable workers, without loading models.
// Explicit custom endpoints remain the external owner's responsibility unless
// auto-start was explicitly enabled for that endpoint.
const definitions = {
  world: {
    id: 'world',
    url: 'FORGE_WORLD_URL',
    auto: 'FORGE_AUTO_START_WORLD',
    setting: 'engines.autoStart.world',
  },
  '3d': {
    id: '3d-hunyuan',
    url: 'FORGE_HUNYUAN_URL',
    auto: 'FORGE_AUTO_START_HUNYUAN',
    setting: 'engines.autoStart.hunyuan',
  },
  trellis: {
    id: '3d-trellis',
    url: 'FORGE_TRELLIS_URL',
    auto: 'FORGE_AUTO_START_TRELLIS',
    setting: 'engines.autoStart.trellis',
  },
  segmentation: {
    id: 'segmentation',
    url: 'FORGE_SAM31_URL',
    auto: 'FORGE_AUTO_START_SAM31',
    setting: 'engines.autoStart.sam31',
  },
  motion: {
    id: 'motion-hy',
    url: 'FORGE_HYMOTION_URL',
    auto: 'FORGE_AUTO_START_HYMOTION',
    setting: 'engines.autoStart.hymotion',
  },
  'motion-bricks': {
    id: 'motion-bricks',
    url: 'FORGE_MOTIONBRICKS_URL',
    auto: 'FORGE_AUTO_START_MOTIONBRICKS',
    setting: 'engines.autoStart.motionbricks',
  },
  voices: {
    id: 'tts',
    url: 'FORGE_TTS_URL',
    auto: 'FORGE_AUTO_START_TTS',
    setting: 'engines.autoStart.tts',
  },
};

// With `readSetting` (the worker passes getSetting) the engines.autoStart.<engine> setting decides,
// so turning automatic starts off also stops this restart. It applies the same environment rule.
/**
 * Builds the handler that restarts one of Forge's own engines after an interrupted render.
 *
 * @param {object} options
 * @param {(engineId: string) => Promise<{ status: string, message?: string }>} options.startEngine
 *   Errors thrown here propagate to the caller; they are not converted to a result.
 * @param {Record<string, string | undefined>} [options.env] Used only when `readSetting` is null.
 * @param {((key: string) => unknown) | null} [options.readSetting] Reads engines.autoStart.<engine>.
 * @returns {(type: string) => Promise<null | { status: string, stage: string, error: string }>}
 *   Null when the type is unknown, the restart is not permitted, or the engine started. Returns
 *   a needs_attention result only when the engine could not be reconnected.
 */
export function createRecoverService({ startEngine, env = process.env, readSetting = null }) {
  return async (type) => {
    const definition = definitions[type];
    if (!definition) {
      return null;
    }
    const mayStart = readSetting
      ? readSetting(definition.setting) !== false
      : !(env[definition.url] && env[definition.auto] !== '1');
    if (!mayStart) {
      return null;
    }
    const result = await startEngine(definition.id);
    if (['missing', 'failed', 'port_in_use', 'recovery_unresolved'].includes(result.status)) {
      return {
        status: 'needs_attention',
        stage: 'Could not reconnect the engine for a previous render.',
        error: result.message || `Engine status: ${result.status}.`,
      };
    }
    return null;
  };
}
