import { estimateChatMemory } from './chat-memory.js';
import { planModelLoad } from './model-load.js';

// The all-GPU GGUF engine uses mapped model files. Available Windows RAM is
// not an estimate of how much GPU memory is available and must not be used
// as a second copy of the model's GPU budget. Actual allocations can still
// fail, in which case the engine reports the failure in its logs.
/**
 * Plans a chat model load against the GPU budget estimated for the context size.
 *
 * `hardware()` and `services()` are async probes. `services()` is only called
 * when the first plan, which assumes no other engine is resident, reports
 * `insufficient_gpu_memory`, so the resident engines can be counted. Probe
 * rejections are not caught here and propagate to the caller.
 *
 * @param {object} options
 * @param {() => Promise<object>} options.hardware Returns GPU hardware figures for planModelLoad.
 * @param {() => Promise<Array>} options.services Returns the currently running engine services.
 * @param {number} options.contextSize Chat context length in tokens.
 * @param {number} [options.projectorMiB=0] Vision projector size in MiB, or 0 when absent.
 * @returns {Promise<object>} The model-load plan. Its `code` is set by planModelLoad, and
 *   the fallback plan also carries a human-readable `estimate` description.
 */
export async function planChatLoad({ hardware, services, contextSize, projectorMiB = 0 }) {
  const estimate = estimateChatMemory(contextSize, { projectorMiB });
  const gpu = await hardware();
  let plan = planModelLoad(gpu, [], estimate.gpuBudgetMiB);
  if (plan.code === 'insufficient_gpu_memory') {
    plan = {
      ...planModelLoad(gpu, await services(), estimate.gpuBudgetMiB),
      estimate: `Estimated GPU budget for ${contextSize.toLocaleString()} context tokens${
        projectorMiB ? ' and the vision projector' : ''
      }, plus the 2 GiB reserve.`,
    };
  }
  return plan;
}
