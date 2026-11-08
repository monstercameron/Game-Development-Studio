// Queues the 3D page's image-first recipes. Each recipe is one request to the queue's chain
// endpoint, so either every render is queued or none is.
import { enqueueHunyuan, enqueueTrellis, post, stageReferences } from './RuntimeQueue';
import { isTrellis, removeBackgroundSteps, textTo3dSteps } from './three-d-requests.js';

const tenMiB = 10 * 1024 * 1024;

/**
 * Queues one 3D recipe. Resolves to { jobs, chained }: a single job when the picture is
 * queued directly, or the chain jobs when background removal runs first.
 * Throws Error when background removal is requested for a missing, oversized or
 * unsupported picture; this check runs before anything is staged or queued.
 */
export async function enqueueThreeD(projectId, draft, file, { fallbackModel, alphaStatus } = {}) {
  const trellis = isTrellis(draft, fallbackModel);
  // A picture that already has a transparent background has nothing to remove.
  const removeBackground = draft.removeBackground === true && alphaStatus !== 'transparent';
  if (!removeBackground) {
    const queue = trellis ? enqueueTrellis : enqueueHunyuan;
    const result = await queue(projectId, draft, file);
    return { jobs: [result.job], chained: false };
  }
  if (!file || file.size > tenMiB) {
    throw Error('Use a PNG, JPEG or WebP image of at most 10 MiB.');
  }
  if (!/\.(png|jpe?g|webp)$/i.test(file.name)) {
    throw Error('Choose a PNG, JPEG or WebP image.');
  }
  // Validate before saving anything: build the steps with a stand-in reference first.
  removeBackgroundSteps({ projectId, draft, fallbackModel, referenceId: 'validate.png' });
  const [referenceId] = await stageReferences(projectId, [file]);
  const steps = removeBackgroundSteps({ projectId, draft, fallbackModel, referenceId });
  const result = await post('/api/runtime/jobs/chain', { steps });
  return { jobs: result.jobs, chained: true };
}

export async function enqueueTextTo3d(projectId, draft, { fallbackModel } = {}) {
  const steps = textTo3dSteps({ projectId, draft, fallbackModel });
  const result = await post('/api/runtime/jobs/chain', { steps });
  return { jobs: result.jobs, chained: true };
}
