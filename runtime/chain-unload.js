// Frees the first model of a chained render before the second one loads.
//
//   text to 3D:        Qwen Image  -> TRELLIS.2 / Hunyuan3D
//   remove background: SAM 3.1     -> TRELLIS.2 / Hunyuan3D
//
// The finished first model would otherwise stay resident next to the second one (Qwen Image
// alone holds about 42 GB of GPU memory). Only the decision lives here; the queue performs the
// unload through the same guarded offload the "make room" flow uses, so ownership, idle checks
// and the engine reservation are unchanged.

export const CHAIN_UNLOAD_ENV = 'FORGE_CHAIN_UNLOAD';

// Parent render type -> id of the engine that holds the model it used.
export const CHAIN_PARENT_ENGINES = Object.freeze({
  images: 'images',
  segmentation: 'segmentation',
});

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);

/**
 * @param {object} [env] environment to read; FORGE_CHAIN_UNLOAD=0 (or false, off, no) disables
 * @returns {boolean} true unless the switch turns the behavior off
 */
export function isChainUnloadEnabled(env = process.env) {
  return !DISABLED_VALUES.has(
    String(env?.[CHAIN_UNLOAD_ENV] ?? '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * Turns the JobQueue `chainUnload` option into the `enabled` input of planChainUnload.
 * A boolean forces the behavior, a function is asked on every call (the worker passes the
 * live `queue.chainUnload` setting), and anything else defers to the environment switch.
 *
 * @param {boolean|(() => boolean)|null|undefined} option
 * @returns {boolean|undefined}
 */
export function resolveChainUnloadOption(option) {
  if (typeof option === 'function') {
    return option() !== false;
  }
  return typeof option === 'boolean' ? option : undefined;
}

/**
 * Decides whether the finished parent's engine should be unloaded before its child loads.
 *
 * @param {object} input
 * @param {string} input.parentType queue type of the finished render the child took its input from
 * @param {string} input.childEngine engine id of the child about to start
 * @param {string[]} input.upcomingEngines engine ids of every other open job in the queue
 * @param {boolean} [input.enabled] overrides the environment switch when it is a boolean
 * @returns {{ engine: string } | { skip: string }} the engine to unload, or why not
 */
export function planChainUnload({ parentType, childEngine, upcomingEngines, enabled }) {
  const isEnabled = typeof enabled === 'boolean' ? enabled : isChainUnloadEnabled();
  if (!isEnabled) {
    return { skip: 'disabled' };
  }
  const engine = CHAIN_PARENT_ENGINES[parentType];
  if (!engine) {
    return { skip: 'not_a_chain_parent' };
  }
  if (engine === childEngine) {
    return { skip: 'same_engine' };
  }
  // Another render of that model is waiting (or running); unloading would only force a reload.
  if ((upcomingEngines || []).includes(engine)) {
    return { skip: 'needed_next' };
  }
  return { engine };
}
