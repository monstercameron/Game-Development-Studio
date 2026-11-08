const referencePattern = /^[a-f0-9-]{36}\.(png|jpg|webp)$/i;
export const HUNYUAN_ESTIMATE_REFERENCE = '00000000-0000-0000-0000-000000000000.png';

function integer(value, name, min, max) {
  if (
    !['number', 'string'].includes(typeof value) ||
    (typeof value === 'string' && !value.trim())
  ) {
    throw Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

export function hunyuanSteps(value) {
  return integer(value === undefined ? 30 : value, 'Steps', 1, 100);
}

// Used for both queue submissions and estimates so tuning is reflected in both.
export function hunyuanShapeRequest(
  draft,
  referenceIds = draft.referenceIds || [HUNYUAN_ESTIMATE_REFERENCE],
) {
  if (
    !Array.isArray(referenceIds) ||
    referenceIds.length !== 1 ||
    typeof referenceIds[0] !== 'string' ||
    !referencePattern.test(referenceIds[0])
  ) {
    throw Error('Choose one staged reference image.');
  }
  const resolution = integer(
    draft.resolution === undefined ? 128 : draft.resolution,
    'Mesh resolution',
    128,
    384,
  );
  if (![128, 256, 384].includes(resolution)) {
    throw Error('Choose a supported mesh resolution.');
  }
  const seed =
    draft.seed === '' || draft.seed === undefined
      ? 123
      : integer(draft.seed, 'Seed', 0, 2147483647);
  const request = {
    model: 'hunyuan',
    references: referenceIds,
    seed,
    steps: hunyuanSteps(draft.shapeSteps),
    resolution,
  };
  if (draft.texture !== undefined && typeof draft.texture !== 'boolean') {
    throw Error('Texture must be on or off.');
  }
  if (draft.texture === true) {
    const textureSize = draft.textureSize === undefined ? 2048 : Number(draft.textureSize);
    if (![1024, 2048].includes(textureSize)) {
      throw Error('Choose a 1024 or 2048 pixel texture.');
    }
    // Shape-only requests stay unchanged so their timing history keeps matching.
    request.texture = true;
    request.texture_size = textureSize;
  }
  return request;
}
