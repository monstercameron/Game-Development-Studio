import { planModelLoad } from './model-load.js';

// H3's existing sd-cli invocation has --max-vram 6 (GiB). This is an
// admission threshold, not a reservation against other GPU applications.
export function createVideoPreparation({ hardware, services }) {
  return async function prepareVideo() {
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], 6 * 1024);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = planModelLoad(snapshot, await services(), 6 * 1024);
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
