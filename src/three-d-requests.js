// Pure request builders for the 3D page's two image-first recipes. No network or React here,
// so they can be tested directly. The queue (runtime/jobs.js) validates the result again.
import { hunyuanShapeRequest } from './hunyuan-settings.js';
import { trellisRequest } from './trellis-settings.js';
import { imageRequest } from './imageVideoInputs.js';
import {
  REMOVE_BACKGROUND_DEFAULT_PROMPT,
  TEXT_TO_3D_IMAGE_SIZE,
  TEXT_TO_3D_IMAGE_STEPS,
  removeBackgroundChain,
  textTo3dChain,
} from '../runtime/three-d-chain.js';

export {
  REMOVE_BACKGROUND_DEFAULT_PROMPT,
  TEXT_TO_3D_IMAGE_SIZE,
  TEXT_TO_3D_IMAGE_STEPS,
} from '../runtime/three-d-chain.js';

// Stands in for the reference that does not exist yet; the chain replaces it with the output of
// the earlier render. It is only ever used to run the existing per-model validation.
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000.png';
export const TEXT_PROMPT_LIMIT = 4000;
export const REMOVE_PROMPT_LIMIT = 1000;

export const isTrellis = (draft, fallbackModel) => (draft.model || fallbackModel) === 'TRELLIS.2';

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}

// The model's own request (validated like a normal queue submission) without any reference.
export function threeDRequest(draft, fallbackModel) {
  const trellis = isTrellis(draft, fallbackModel);
  const seed = draft.seed !== '' && draft.seed !== undefined ? draft.seed : randomSeed();
  const full = trellis
    ? trellisRequest({ ...draft, seed }, [PLACEHOLDER])
    : hunyuanShapeRequest({ ...draft, seed }, [PLACEHOLDER]);
  const request = { ...full };
  delete request.references;
  return { model: trellis ? 'trellis' : 'hunyuan', request };
}

export function removeBackgroundPrompt(draft) {
  const prompt = (draft.removeBackgroundPrompt ?? '').trim() || REMOVE_BACKGROUND_DEFAULT_PROMPT;
  if (prompt.length > REMOVE_PROMPT_LIMIT) {
    throw Error(`Describe what to isolate in at most ${REMOVE_PROMPT_LIMIT} characters.`);
  }
  return prompt;
}

// SAM 3.1 cutout of a staged picture, then the 3D render chained to it.
export function removeBackgroundSteps({ projectId, draft, fallbackModel, referenceId }) {
  const { model, request } = threeDRequest(draft, fallbackModel);
  return removeBackgroundChain({
    projectId,
    referenceId,
    model,
    request,
    prompt: removeBackgroundPrompt(draft),
  });
}

// The Qwen image request used by text-to-3D: square, transparent, with a user-editable step
// count and seed. It reuses the Images page builder so both pages validate identically.
export function textImageRequest(draft) {
  const prompt = (draft.prompt ?? '').trim();
  if (!prompt) {
    throw Error('Describe the object you want to create.');
  }
  if (prompt.length > TEXT_PROMPT_LIMIT) {
    throw Error(`The description must be at most ${TEXT_PROMPT_LIMIT} characters.`);
  }
  return imageRequest({
    prompt,
    imageWidth: TEXT_TO_3D_IMAGE_SIZE,
    imageHeight: TEXT_TO_3D_IMAGE_SIZE,
    imageSteps: draft.textImageSteps === undefined ? TEXT_TO_3D_IMAGE_STEPS : draft.textImageSteps,
    seed: draft.textImageSeed,
    imageTransparent: true,
    referenceIds: [],
  });
}

export function textTo3dSteps({ projectId, draft, fallbackModel }) {
  const image = textImageRequest(draft);
  const { model, request } = threeDRequest(draft, fallbackModel);
  return textTo3dChain({ projectId, model, image, request });
}
