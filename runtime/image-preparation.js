import { GPU_RESERVE_MIB, planModelLoad } from './model-load.js';

// The installed BF16 model occupies about 31 GiB on disk. Allow room for
// activations and loader overhead; this conservative estimate is uncalibrated.
export const IMAGE_BUDGET_MIB = 48 * 1024;
// Measured peaks with the model loaded: about 39 GiB at 0.26 MP and 73 GiB at 4.2 MP
// (2752x1536), roughly 37 GiB plus 8.6 GiB per megapixel. A size-aware estimate keeps a
// large render from starting when the GPU cannot hold it, whether or not the model is
// already resident.
const ASSUMED_MEGAPIXELS = 1.2;
const MODEL_RESIDENT_MIB = 31 * 1024;
/**
 * Estimates the GPU memory an image render needs, in MiB. This is a conservative budget,
 * not a measurement.
 * @param {{ width?: number, height?: number }} [request] Requested size in pixels. A missing
 *   or non-positive size falls back to ASSUMED_MEGAPIXELS.
 * @param {boolean} [loaded] True when the model is already resident, so only the extra
 *   working memory is counted.
 * @returns {number} Budget in MiB.
 */
export function imageBudgetMiB(request = {}, loaded = false) {
  const width = Number(request.width),
    height = Number(request.height);
  const megapixels =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? (width * height) / 1e6
      : ASSUMED_MEGAPIXELS;
  const working = Math.ceil((4 + 8.6 * megapixels) * 1.1 * 1024);
  // Loaded: only the extra working memory is needed. Not loaded: the model plus working memory.
  return loaded ? working : Math.max(IMAGE_BUDGET_MIB, MODEL_RESIDENT_MIB + working);
}
/**
 * Whether a freshly loaded model plus this render would fit the whole GPU. A resident model and
 * the allocator cache it grew can leave less free memory than the render's working set needs
 * while the card itself is large enough. Releasing the idle model is then the way to make room.
 * Only the total is known here, so this is a necessary condition, not a promise of free memory.
 * @param {{ totalMiB?: number|null }} device The inference GPU of the snapshot.
 * @param {{ width?: number, height?: number }} request The render's requested size.
 * @returns {boolean} True when the total GPU memory covers a fresh load of this render.
 */
function fitsAfterRelease(device, request) {
  return (
    Number.isFinite(device?.totalMiB) &&
    device.totalMiB >= imageBudgetMiB(request, false) + GPU_RESERVE_MIB
  );
}
/**
 * Builds the admission check for image renders. The returned function resolves to null when
 * the GPU can take the render, or to a waiting_memory or needs_attention status object.
 * @param {{ hardware: Function, services: Function }} dependencies Async readers for the
 *   GPU snapshot and the loaded services.
 */
export function createImagePreparation({ hardware, services }) {
  return async function prepareImage(request = {}, loaded = false) {
    const budget = imageBudgetMiB(request, loaded);
    const snapshot = await hardware();
    let plan = planModelLoad(snapshot, [], budget);
    if (plan.code === 'insufficient_gpu_memory') {
      plan = planModelLoad(snapshot, await services(), budget);
    }
    if (plan.code === 'insufficient_gpu_memory') {
      return {
        status: 'waiting_memory',
        stage: 'Waiting for GPU memory for Qwen Image.',
        details: {
          ...plan,
          // A resident model is already counted in the GPU's used memory, so only the render's
          // working memory is required; otherwise the model is loaded first and counted too.
          basis: loaded ? 'working_memory_only' : 'model_plus_working_memory',
          estimate: 'Conservative uncalibrated estimate for the BF16 model and working memory.',
          // The queue may stop this idle engine itself to make room, and restart it to load
          // the model again, only when the resident model is what holds the memory.
          ...(loaded && fitsAfterRelease(plan.device, request)
            ? { releasableLoadedModel: true }
            : {}),
        },
      };
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
