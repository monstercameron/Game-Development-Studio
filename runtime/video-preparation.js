import { planModelLoad } from './model-load.js';
import { videoGpuBudget } from './video-options.js';

// The admission threshold is the GPU memory budget H3 is given with --max-vram (6 GiB unless the
// request chose one or has reference clips; see videoGpuBudget). It is a threshold, not a
// reservation against other GPU applications.
export function createVideoPreparation({ hardware, services }) {
  return async function prepareVideo(request = {}) {
    const budgetMiB = videoGpuBudget(request).gib * 1024;
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], budgetMiB);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = planModelLoad(snapshot, await services(), budgetMiB);
    }
    if (plan.code === 'insufficient_gpu_memory') {
      return { status: 'waiting_memory', stage: 'Waiting for GPU memory for H3.', details: plan };
    }
    if (plan.code === 'gpu_memory_unavailable') {
      return {
        status: 'needs_attention',
        stage: 'GPU memory is unavailable.',
        error: plan.message,
      };
    }
    return null;
  };
}
