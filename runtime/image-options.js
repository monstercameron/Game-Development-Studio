// Optional Qwen Image controls beyond size, steps, seed and negative prompt. Everything here is
// stored only when it differs from the engine's own default, so earlier requests keep their shape.
import { assertKnownLora, MAX_LORA_SCALE } from './image-loras.js';

export const IMAGE_MAX_VARIATIONS = 4;
export const REFERENCE_SIZE_TARGET = { min: 256, max: 2048, step: 32, fallback: 1024 };
export const MAX_SIGMAS = 50;
const groupPattern = /^[a-f0-9-]{36}$/i;

// "1, 0.8, 0.5" -> [1, 0.8, 0.5]. Qwen takes the sigmas to try, without the terminal sigma; their
// count becomes the number of denoising steps. They must start at or below 1 and fall.
export function parseSigmaSchedule(value) {
  if (typeof value !== 'string') {
    throw Error('Sampling schedule must be a comma-separated list of numbers.');
  }
  const numbers = value
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => Number(Number(part).toFixed(4)));
  if (numbers.length < 1 || numbers.length > MAX_SIGMAS) {
    throw Error(`Sampling schedule needs 1 to ${MAX_SIGMAS} sigma values.`);
  }
  if (numbers.some((sigma) => !Number.isFinite(sigma) || sigma <= 0 || sigma > 1)) {
    throw Error('Each sigma must be above 0 and at most 1.');
  }
  if (numbers.some((sigma, index) => index > 0 && sigma >= numbers[index - 1])) {
    throw Error('Sigmas must fall: each value must be smaller than the one before it.');
  }
  return numbers;
}

export function normalizeImageExtras(request, { sizeFromReference, steps }) {
  const {
    output_resolution: outputResolution = null,
    use_kv_cache: useKvCache = true,
    sigma_schedule: sigmaSchedule = '',
    lora = null,
    lora_scale: loraScale = null,
    variation_group: group = null,
    variation_index: index = null,
    variation_count: count = null,
  } = request;
  const out = {};
  if (outputResolution !== null) {
    const { min, max, step, fallback } = REFERENCE_SIZE_TARGET;
    if (!sizeFromReference) {
      throw Error('A reference size target applies only when the size follows the last reference.');
    }
    if (
      !Number.isInteger(outputResolution) ||
      outputResolution < min ||
      outputResolution > max ||
      outputResolution % step !== 0
    ) {
      throw Error(`Reference size target must be ${min}–${max} px in multiples of ${step}.`);
    }
    if (outputResolution !== fallback) {
      out.output_resolution = outputResolution;
    }
  }
  if (typeof useKvCache !== 'boolean') {
    throw Error('KV cache must be true or false.');
  }
  if (!useKvCache) {
    out.use_kv_cache = false;
  }
  if (sigmaSchedule !== '') {
    const sigmas = parseSigmaSchedule(sigmaSchedule);
    if (sigmas.length !== steps) {
      throw Error('Sampling steps must equal the number of sigma values in the sampling schedule.');
    }
    out.sigma_schedule = sigmas.join(', ');
  }
  if (lora !== null) {
    assertKnownLora(lora);
    const scale = loraScale ?? 1;
    if (!Number.isFinite(scale) || scale < 0 || scale > MAX_LORA_SCALE) {
      throw Error(`LoRA strength must be from 0 to ${MAX_LORA_SCALE}.`);
    }
    out.lora = lora;
    out.lora_scale = scale;
  } else if (loraScale !== null) {
    throw Error('LoRA strength needs a LoRA.');
  }
  const variation = [group, index, count];
  if (variation.some((item) => item !== null)) {
    if (
      typeof group !== 'string' ||
      !groupPattern.test(group) ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > IMAGE_MAX_VARIATIONS ||
      !Number.isInteger(index) ||
      index < 1 ||
      index > count
    ) {
      throw Error(
        `Variation needs a group ID, a position from 1 and a count from 2 to ${IMAGE_MAX_VARIATIONS}.`,
      );
    }
    out.variation_group = group;
    out.variation_index = index;
    out.variation_count = count;
  }
  return out;
}

// N sibling requests that share every setting and differ only in seed and variation position.
// A given seed is used for the first and counted up from there; otherwise each seed is random.
export function variationRequests(request, count, { randomSeed, makeGroup }) {
  if (!Number.isInteger(count) || count < 1 || count > IMAGE_MAX_VARIATIONS) {
    throw Error(`Variations must be from 1 to ${IMAGE_MAX_VARIATIONS}.`);
  }
  if (count === 1) {
    return [request];
  }
  const group = makeGroup();
  const seeds = new Set();
  return Array.from({ length: count }, (_, position) => {
    let seed;
    if (Number.isSafeInteger(request.seed)) {
      seed = request.seed + position;
    } else {
      do {
        seed = randomSeed();
      } while (seeds.has(seed));
    }
    seeds.add(seed);
    return {
      ...request,
      seed,
      variation_group: group,
      variation_index: position + 1,
      variation_count: count,
    };
  });
}
