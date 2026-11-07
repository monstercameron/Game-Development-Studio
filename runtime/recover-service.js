// Restart only Forge's own output-recoverable workers, without loading models.
// Explicit custom endpoints remain the external owner's responsibility unless
// auto-start was explicitly enabled for that endpoint.
const definitions = {
  world: {id:'world', url:'FORGE_WORLD_URL', auto:'FORGE_AUTO_START_WORLD'},
  '3d': {id:'3d-hunyuan', url:'FORGE_HUNYUAN_URL', auto:'FORGE_AUTO_START_HUNYUAN'},
  trellis: {id:'3d-trellis', url:'FORGE_TRELLIS_URL', auto:'FORGE_AUTO_START_TRELLIS'},
  segmentation: {id:'segmentation', url:'FORGE_SAM31_URL', auto:'FORGE_AUTO_START_SAM31'},
  motion: {id:'motion-hy', url:'FORGE_HYMOTION_URL', auto:'FORGE_AUTO_START_HYMOTION'},
  'motion-bricks': {id:'motion-bricks', url:'FORGE_MOTIONBRICKS_URL', auto:'FORGE_AUTO_START_MOTIONBRICKS'},
  voices: {id:'tts', url:'FORGE_TTS_URL', auto:'FORGE_AUTO_START_TTS'},
};

export function createRecoverService({startEngine,env=process.env}){
  return async type=>{
    const definition=definitions[type];
    if(!definition || (env[definition.url] && env[definition.auto]!=='1'))return null;
    const result=await startEngine(definition.id);
    if(['missing','failed','port_in_use','recovery_unresolved'].includes(result.status))return {
      status:'needs_attention',stage:'Could not reconnect the engine for a previous render.',
      error:result.message||`Engine status: ${result.status}.`,
    };
    return null;
  };
}
