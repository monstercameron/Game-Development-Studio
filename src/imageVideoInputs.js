import {
  VIDEO_ASPECTS,
  VIDEO_FRAME_PRESETS,
  normalizeVideoRequest,
  videoDimensions,
  videoSeconds,
} from '../runtime/video-options.js';

// These are the controls accepted by the currently connected Qwen and H3 APIs.
const imageSizes = {
  'Landscape · 16:9': [1024, 576],
  'Square · 1:1': [1024, 1024],
  'Portrait · 9:16': [576, 1024],
};
const imageQualities = { Balanced: 30, Draft: 12, 'High quality': 40 };
const videoAspects = Object.fromEntries(
  Object.entries(VIDEO_ASPECTS).map(([id, { label }]) => [label, id]),
);
const videoFrames = Object.fromEntries(
  Object.entries(VIDEO_FRAME_PRESETS).map(([frames, label]) => [label, Number(frames)]),
);
export const videoAspectId = (label) => videoAspects[label] || 'landscape';
export const videoFramesFor = (label) => videoFrames[label] || 124;
const PLACEHOLDER_IMAGE = '00000000-0000-0000-0000-000000000000.png';
const hasValue = (value) => value !== undefined && value !== null && value !== '';

function integer(value, fallback, label, min, max, divisor = 1) {
  const n = hasValue(value) ? Number(value) : fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max || n % divisor !== 0) {
    throw Error(
      `${label} must be ${min}–${max}${divisor > 1 ? ` and a multiple of ${divisor}` : ''}.`,
    );
  }
  return n;
}

// Qwen Image 2.1's published sizes go up to 2752 px (16:9 at 2752 × 1536).
export const IMAGE_MAX_SIZE = 2752;
export const IMAGE_MAX_VARIATIONS = 4;
// With "match the last reference's shape", the model sizes the render to about this many pixels square.
export const REFERENCE_TARGET = { min: 256, max: 2048, step: 32, fallback: 1024 };
export const LORA_MAX_SCALE = 2;

// "1, 0.8, 0.5" -> [1, 0.8, 0.5]; the same rules the queue applies to a custom sampling schedule.
export function parseSigmaText(text) {
  const numbers = String(text)
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((part) => Number(Number(part).toFixed(4)));
  if (numbers.length < 1 || numbers.length > 50) {
    throw Error('Enter 1 to 50 sigma values.');
  }
  if (numbers.some((sigma) => !Number.isFinite(sigma) || sigma <= 0 || sigma > 1)) {
    throw Error('Each sigma must be above 0 and at most 1.');
  }
  if (numbers.some((sigma, index) => index > 0 && sigma >= numbers[index - 1])) {
    throw Error('Sigmas must fall: each value smaller than the one before.');
  }
  return numbers;
}
export function sigmaScheduleError(text) {
  if (!String(text ?? '').trim()) {
    return '';
  }
  try {
    parseSigmaText(text);
    return '';
  } catch (error) {
    return error.message;
  }
}

export function imageVariationCount(draft) {
  const count = hasValue(draft.imageVariations) ? Number(draft.imageVariations) : 1;
  if (!Number.isInteger(count) || count < 1 || count > IMAGE_MAX_VARIATIONS) {
    throw Error(`Variations must be from 1 to ${IMAGE_MAX_VARIATIONS}.`);
  }
  return count;
}

function randomImageSeed() {
  if (!globalThis.crypto?.getRandomValues) {
    throw Error('Secure random seeds are unavailable in this browser.');
  }
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}

// N sibling requests that share every setting and differ only in seed and variation position.
// A given seed is used for the first and counted up from there; otherwise each seed is random.
export function variationRequests(request, count, { randomSeed, makeGroup } = {}) {
  if (count === 1) {
    return [request];
  }
  const group = (makeGroup || (() => globalThis.crypto.randomUUID()))();
  const seeds = new Set();
  return Array.from({ length: count }, (_, position) => {
    let seed;
    if (Number.isSafeInteger(request.seed)) {
      seed = request.seed + position;
    } else {
      do {
        seed = (randomSeed || randomImageSeed)();
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

export function imageRequest(draft) {
  const [defaultWidth, defaultHeight] = imageSizes[draft.options?.[0]] || [1024, 576];
  const matchReference = draft.imageMatchReference === true;
  if (matchReference && !(draft.referenceIds || []).length) {
    throw Error('Add a reference image, or turn off “Match the last reference’s shape”.');
  }
  const width = integer(draft.imageWidth, defaultWidth, 'Width', 32, IMAGE_MAX_SIZE, 32);
  const height = integer(draft.imageHeight, defaultHeight, 'Height', 32, IMAGE_MAX_SIZE, 32);
  // A custom sampling schedule fixes the step count: one step per sigma.
  const sigmaText = String(draft.imageSigmas ?? '').trim();
  const sigmas = sigmaText ? parseSigmaText(sigmaText) : null;
  const num_inference_steps = sigmas
    ? sigmas.length
    : integer(draft.imageSteps, imageQualities[draft.options?.[1]] || 30, 'Image steps', 1, 100);
  imageVariationCount(draft);
  const target =
    matchReference && hasValue(draft.imageTargetSize)
      ? integer(
          draft.imageTargetSize,
          REFERENCE_TARGET.fallback,
          'Reference size target',
          REFERENCE_TARGET.min,
          REFERENCE_TARGET.max,
          REFERENCE_TARGET.step,
        )
      : REFERENCE_TARGET.fallback;
  const lora = String(draft.imageLora ?? '').trim();
  const loraScale = hasValue(draft.imageLoraScale) ? Number(draft.imageLoraScale) : 1;
  if (lora && (!Number.isFinite(loraScale) || loraScale < 0 || loraScale > LORA_MAX_SCALE)) {
    throw Error(`LoRA strength must be from 0 to ${LORA_MAX_SCALE}.`);
  }
  const negative = (draft.imageNegativePrompt || '').trim();
  if (negative.length > 4000) {
    throw Error('The negative prompt must be at most 4,000 characters.');
  }
  const guidance = hasValue(draft.imageGuidance) ? Number(draft.imageGuidance) : 2;
  if (negative && (!Number.isFinite(guidance) || guidance <= 1 || guidance > 10)) {
    throw Error('Negative prompt guidance must be greater than 1 and no more than 10.');
  }
  const seed = hasValue(draft.seed)
    ? integer(draft.seed, 0, 'Seed', 0, Number.MAX_SAFE_INTEGER)
    : undefined;
  return {
    prompt: draft.prompt,
    // A matched size lets the model derive width and height from the last reference.
    ...(matchReference ? { size_from_reference: true } : { width, height }),
    num_inference_steps,
    references: draft.referenceIds || [],
    ...(draft.imageTransparent === true ? { transparent: true } : {}),
    ...(matchReference && target !== REFERENCE_TARGET.fallback
      ? { output_resolution: target }
      : {}),
    ...(draft.imageKvCache === false ? { use_kv_cache: false } : {}),
    ...(sigmas ? { sigma_schedule: sigmas.join(', ') } : {}),
    ...(lora ? { lora, lora_scale: loraScale } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(negative ? { negative_prompt: negative, true_cfg_scale: guidance } : {}),
  };
}

// A blank field keeps H3's own behaviour. The staged ids only exist once the files have been
// saved; before that a placeholder stands in for each picked file so the form can be validated.
export function videoRequest(draft) {
  const source = ['frames', 'text'].includes(draft.videoSource) ? draft.videoSource : 'references';
  const turbo = draft.videoTurbo === true;
  const steps = integer(draft.videoSteps, turbo ? 4 : 12, 'Video steps', 4, 30);
  if (!(turbo ? [4, 8] : [8, 12, 20, 30]).includes(steps)) {
    throw Error(
      turbo
        ? 'The turbo adapter renders in 4 or 8 steps.'
        : 'Choose one of the supported video quality settings.',
    );
  }
  // H3's seed range is 0 to 2147483647; a blank seed is chosen and recorded when the job is queued.
  const seed = hasValue(draft.seed) ? integer(draft.seed, 0, 'Seed', 0, 2147483647) : undefined;
  // The turbo adapter is made for unguided rendering, so guidance is ignored with it.
  const negative = turbo ? '' : (draft.videoNegative || '').trim();
  const guidance = turbo ? 1 : hasValue(draft.videoCfg) ? Number(draft.videoCfg) : negative ? 2 : 1;
  if (
    !Number.isFinite(guidance) ||
    guidance < 1 ||
    guidance > 6 ||
    (guidance > 1 && guidance < 1.1)
  ) {
    throw Error('Guidance must be 1 (off) or from 1.1 to 6.');
  }
  const maxVram = hasValue(draft.videoMaxVram)
    ? integer(draft.videoMaxVram, 6, 'GPU memory budget', 4, 24)
    : undefined;
  const fromReferences = source === 'references';
  const first =
    source === 'frames'
      ? (draft.firstFrameId ?? (draft.videoFirstFrame ? PLACEHOLDER_IMAGE : undefined))
      : undefined;
  const last =
    source === 'frames'
      ? (draft.lastFrameId ?? (draft.videoLastFrame ? PLACEHOLDER_IMAGE : undefined))
      : undefined;
  const clips = (list, ids, extension) =>
    fromReferences && (ids ?? list?.length)
      ? (ids ?? list.map(() => `00000000-0000-0000-0000-000000000000.${extension}`))
      : [];
  const videos = clips(draft.videoClips, draft.clipIds, 'webm');
  const audios = clips(draft.videoAudios, draft.audioIds, 'wav');
  const request = {
    prompt: draft.prompt,
    references: fromReferences ? (draft.referenceIds ?? [PLACEHOLDER_IMAGE]) : [],
    aspect: videoAspects[draft.options?.[0]] || 'landscape',
    frames: videoFrames[draft.options?.[1]] || 124,
    steps,
    ...(seed === undefined ? {} : { seed }),
    ...(fromReferences ? {} : { source }),
    ...(first ? { first_frame: first } : {}),
    ...(last ? { last_frame: last } : {}),
    ...(videos.length ? { reference_videos: videos } : {}),
    ...(audios.length ? { reference_audios: audios } : {}),
    ...(videos.length && draft.videoClipAudio === true ? { use_clip_audio: true } : {}),
    ...(draft.videoResolution && draft.videoResolution !== 'standard'
      ? { resolution: draft.videoResolution }
      : {}),
    ...(turbo ? { turbo: true } : {}),
    ...(guidance > 1 ? { cfg_scale: guidance } : {}),
    ...(negative && guidance > 1 ? { negative_prompt: negative } : {}),
    ...(draft.videoSampler ? { sampler: draft.videoSampler } : {}),
    ...(draft.videoScheduler ? { scheduler: draft.videoScheduler } : {}),
    ...(maxVram === undefined ? {} : { max_vram: maxVram }),
    ...(draft.videoRefDetail ? { reference_detail: draft.videoRefDetail } : {}),
    ...(draft.videoAlsoMp4 === true ? { also_mp4: true } : {}),
  };
  // The queue applies the same rules; checking here gives the message before anything is uploaded.
  // Real ids are checked when the queue receives them; here they only need to be well formed.
  const idLike = (ids, extension) =>
    ids?.map(() => `00000000-0000-0000-0000-000000000000.${extension}`);
  normalizeVideoRequest(
    {
      ...request,
      references: idLike(request.references, 'png'),
      ...(first ? { first_frame: PLACEHOLDER_IMAGE } : {}),
      ...(last ? { last_frame: PLACEHOLDER_IMAGE } : {}),
      ...(videos.length ? { reference_videos: idLike(videos, 'webm') } : {}),
      ...(audios.length ? { reference_audios: idLike(audios, 'wav') } : {}),
    },
    () => 0,
  );
  return request;
}

// One line saying what the selected aspect, size and duration will produce, for the video page.
export function videoFormatSummary(options, draft = {}) {
  const aspect = videoAspects[options?.[0]] || 'landscape';
  const frames = videoFrames[options?.[1]] || 124;
  const [width, height] = videoDimensions(aspect, draft.videoResolution || 'standard');
  return `${width} × ${height} pixels · ${frames} frames at 24 fps (${videoSeconds(frames).toFixed(1)} s) · stereo sound included`;
}

// Labels for the "changed: ..." hint shown while the panel is closed.
export function videoChangedLabels(draft) {
  return [
    [draft.videoResolution && draft.videoResolution !== 'standard', 'size'],
    [draft.videoTurbo === true, 'turbo adapter'],
    [!draft.videoTurbo && Number(draft.videoSteps || 12) !== 12, 'steps'],
    [hasValue(draft.seed), 'seed'],
    [draft.videoNegative?.trim() || hasValue(draft.videoCfg), 'guidance'],
    [draft.videoSampler || draft.videoScheduler, 'sampler'],
    [hasValue(draft.videoMaxVram), 'GPU memory'],
    [draft.videoRefDetail, 'reference detail'],
    [draft.videoAlsoMp4 === true, 'MP4 copy'],
  ]
    .filter(([on]) => on)
    .map(([, label]) => label);
}
