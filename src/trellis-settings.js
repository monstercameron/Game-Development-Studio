const referencePattern = /^[a-f0-9-]{36}\.(png|webp)$/i;
const estimateReference = '00000000-0000-0000-0000-000000000000.png';
function integer(value, name, min, max) {
  if (
    !['string', 'number'].includes(typeof value) ||
    (typeof value === 'string' && !value.trim())
  ) {
    throw Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}
export function trellisRequest(draft, references = draft.referenceIds || [estimateReference]) {
  if (
    !Array.isArray(references) ||
    references.length !== 1 ||
    !referencePattern.test(references[0] || '')
  ) {
    throw Error('Choose one transparent PNG or WebP reference.');
  }
  const seed =
    draft.seed === '' || draft.seed === undefined ? 42 : integer(draft.seed, 'Seed', 0, 2147483647);
  const steps = integer(draft.trellisSteps === undefined ? 12 : draft.trellisSteps, 'Steps', 1, 50);
  const texture_size = integer(
    draft.trellisTexture === undefined ? 1024 : draft.trellisTexture,
    'Texture size',
    512,
    2048,
  );
  if (![512, 1024, 2048].includes(texture_size)) {
    throw Error('Choose a supported texture size.');
  }
  return { model: 'trellis', references, seed, steps, texture_size };
}
