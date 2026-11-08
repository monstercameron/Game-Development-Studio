const referencePattern = /^[a-f0-9-]{36}\.(png|jpg|webp)$/i;
export const HUNYUAN_ESTIMATE_REFERENCE = '00000000-0000-0000-0000-000000000000.png';

// Values mirror runtime/hunyuan_worker.py and runtime/jobs.js.
export const HUNYUAN_DEFAULT_GUIDANCE = 5;
export const HUNYUAN_TRIANGLE_RANGE = [1000, 1000000];
// Used when painting and no triangle target is chosen; also the painted-mesh default upstream.
export const HUNYUAN_PAINT_DEFAULT_TRIANGLES = 40000;
// Advanced painter settings. The model was trained on 6 views of 512 px; in a test, 8 views at
// 768 px looked no better, took about twice as long and used about 15 GB more GPU memory.
export const HUNYUAN_PAINT_VIEW_COUNTS = [6, 7, 8, 9];
export const HUNYUAN_PAINT_VIEW_SIZES = [512, 768];

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

export function hunyuanGuidance(value) {
  if (value === undefined) {
    return HUNYUAN_DEFAULT_GUIDANCE;
  }
  if (
    !['number', 'string'].includes(typeof value) ||
    (typeof value === 'string' && !value.trim())
  ) {
    throw Error('Guidance must be a number from 1 to 20.');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || number > 20) {
    throw Error('Guidance must be a number from 1 to 20.');
  }
  return number;
}

// '', null and undefined all mean "automatic": the raw mesh, or 40,000 triangles when painting.
export function hunyuanTriangles(value) {
  if (value === undefined || value === '' || value === null) {
    return null;
  }
  return integer(value, 'Triangle target', ...HUNYUAN_TRIANGLE_RANGE);
}

/**
 * Builds the shape request for a Hunyuan job. Queue submissions and estimates both use it so
 * tuning is reflected in both.
 *
 * @param {object} draft Form values; a missing field takes its default.
 * @param {string[]} [referenceIds] Exactly one staged reference file name (a UUID with a
 *   png, jpg or webp extension). Defaults to the placeholder used for estimates.
 * @returns {object} The request body. Default guidance, triangles and view settings are
 *   omitted so unchanged requests keep matching timing history.
 * @throws {Error} When a value is out of range or the reference list is not exactly one file.
 */
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
  // Defaults are left out so shape-only requests stay unchanged and keep matching timing history.
  const guidance = hunyuanGuidance(draft.shapeGuidance);
  if (guidance !== HUNYUAN_DEFAULT_GUIDANCE) {
    request.guidance = guidance;
  }
  const triangles = hunyuanTriangles(draft.shapeTriangles);
  if (triangles !== null) {
    request.target_faces = triangles;
  }
  if (draft.texture !== undefined && typeof draft.texture !== 'boolean') {
    throw Error('Texture must be on or off.');
  }
  if (draft.texture === true) {
    const textureSize = draft.textureSize === undefined ? 2048 : Number(draft.textureSize);
    if (![1024, 2048].includes(textureSize)) {
      throw Error('Choose a 1024 or 2048 pixel texture.');
    }
    request.texture = true;
    request.texture_size = textureSize;
    const views = draft.textureViews === undefined ? 6 : Number(draft.textureViews);
    const viewSize = draft.textureViewSize === undefined ? 512 : Number(draft.textureViewSize);
    if (
      !HUNYUAN_PAINT_VIEW_COUNTS.includes(views) ||
      !HUNYUAN_PAINT_VIEW_SIZES.includes(viewSize)
    ) {
      throw Error('Painted views are 6 to 9 at 512 or 768 pixels.');
    }
    // Defaults are left out so painted requests stay unchanged and keep matching timing history.
    if (views !== 6) {
      request.texture_views = views;
    }
    if (viewSize !== 512) {
      request.texture_view_size = viewSize;
    }
  }
  return request;
}
