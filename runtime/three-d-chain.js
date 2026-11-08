// Builders for the two 3D recipes that need an image first. They are pure so the studio page,
// the MCP server and the tests build identical requests; the queue (JobQueue.enqueueChain)
// validates and persists them.
//
//   remove background:  segmentation (transparent cutout) -> 3D model
//   text to 3D:         Qwen image (transparent background) -> 3D model
//
// A later step takes its reference from an earlier one with request.referenceFrom = { step }.

export const REMOVE_BACKGROUND_DEFAULT_PROMPT = 'the main object';
export const TEXT_TO_3D_IMAGE_SIZE = 1024;
export const TEXT_TO_3D_IMAGE_STEPS = 25;
export const TEXT_TO_3D_MODELS = ['hunyuan', 'trellis'];

const THREE_D_TYPES = { hunyuan: '3d', trellis: 'trellis' };

function dependent(type, projectId, request) {
  // The staged reference arrives from the earlier step, so none is supplied here.
  return {
    type,
    projectId,
    request: { ...request, references: [], referenceFrom: { step: 0 } },
  };
}

/**
 * @param {object} input
 * @param {string} input.projectId
 * @param {string} input.referenceId staged id of the original (opaque) picture
 * @param {'hunyuan'|'trellis'} input.model
 * @param {object} input.request the 3D request without references
 * @param {string} [input.prompt] what SAM 3.1 should isolate
 * @param {number} [input.confidence] SAM 3.1 detection confidence, 0 to 1
 */
export function removeBackgroundChain({
  projectId,
  referenceId,
  model,
  request,
  prompt = REMOVE_BACKGROUND_DEFAULT_PROMPT,
  confidence = 0.5,
}) {
  const type = THREE_D_TYPES[model];
  if (!type) {
    throw Error('Choose Hunyuan3D or TRELLIS.2.');
  }
  const what = typeof prompt === 'string' ? prompt.trim() : '';
  if (!what || what.length > 1000) {
    throw Error('Describe what to isolate in 1 to 1000 characters.');
  }
  return [
    {
      type: 'segmentation',
      projectId,
      request: { prompt: what, references: [referenceId], output: 'transparent', confidence },
    },
    dependent(type, projectId, request),
  ];
}

/**
 * @param {object} input
 * @param {string} input.projectId
 * @param {'hunyuan'|'trellis'} input.model
 * @param {object} input.image the Qwen image request (see imageRequest in imageVideoInputs.js)
 * @param {object} input.request the 3D request without references
 */
export function textTo3dChain({ projectId, model, image, request }) {
  const type = THREE_D_TYPES[model];
  if (!type) {
    throw Error('Choose Hunyuan3D or TRELLIS.2.');
  }
  if (typeof image?.prompt !== 'string' || !image.prompt.trim()) {
    throw Error('Describe the object to create.');
  }
  return [
    // A transparent background is what both 3D models need as input.
    { type: 'images', projectId, request: { ...image, references: [], transparent: true } },
    dependent(type, projectId, request),
  ];
}
