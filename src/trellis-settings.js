const referencePattern = /^[a-f0-9-]{36}\.(png|webp)$/i;
const estimateReference = '00000000-0000-0000-0000-000000000000.png';
// Mirrors runtime/jobs.js and runtime/trellis_worker.py. Upstream's own default is 1,000,000,
// which is far heavier than a typical game asset, so Forge defaults to 100,000.
export const TRELLIS_DEFAULT_TRIANGLES = 100000;
export const TRELLIS_TRIANGLE_RANGE = [5000, 1000000];
// Resolutions of TRELLIS.2's own pipelines. Mirrors runtime/jobs.js and trellis_manifest.py.
// gpuGiB is the free GPU memory Forge waits for before a render (an uncalibrated guess for
// everything above 512, see runtime/trellis-preparation.js).
export const TRELLIS_DEFAULT_PIPELINE = '512';
export const TRELLIS_PIPELINES = [
  {
    id: '512',
    label: '512 · default',
    gpuGiB: 24,
    summary: 'The pipeline Forge connected first and the fastest of the four.',
  },
  {
    id: '1024',
    label: '1024 · more detail',
    gpuGiB: 40,
    summary: 'Builds the structure directly at 1024 resolution. Slower; more detail than 512.',
  },
  {
    id: '1024_cascade',
    label: '1024 cascade · sharper',
    gpuGiB: 48,
    summary:
      'Builds a 512 structure, then refines it at 1024. Upstream’s default pipeline; slower than 1024.',
  },
  {
    id: '1536_cascade',
    label: '1536 cascade · most detail',
    gpuGiB: 64,
    summary:
      'Refines at 1536 resolution. The slowest and largest; TRELLIS.2 lowers the resolution on its own when the object needs too many tokens.',
  },
];
export const TRELLIS_PIPELINE_IDS = TRELLIS_PIPELINES.map((pipeline) => pipeline.id);
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
  const target_faces = integer(
    draft.trellisTriangles === undefined ? TRELLIS_DEFAULT_TRIANGLES : draft.trellisTriangles,
    'Triangle target',
    ...TRELLIS_TRIANGLE_RANGE,
  );
  const pipeline =
    draft.trellisPipeline === undefined ? TRELLIS_DEFAULT_PIPELINE : draft.trellisPipeline;
  if (!TRELLIS_PIPELINE_IDS.includes(pipeline)) {
    throw Error('Choose a supported TRELLIS.2 pipeline.');
  }
  return {
    model: 'trellis',
    references,
    seed,
    steps,
    texture_size,
    target_faces,
    // The default is left out so requests, history and timing profiles match earlier renders.
    ...(pipeline === TRELLIS_DEFAULT_PIPELINE ? {} : { pipeline }),
  };
}
