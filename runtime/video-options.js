// Everything Forge knows about the options of the MiniMax H3 renderer (sd-cli, vid_gen).
// Shared by the queue (validation), the worker (what to send) and the studio (labels).
//
// Where each limit comes from:
// - 32-pixel sizes: the H3 video VAE downsamples by 16 and the transformer patches by 2, so
//   sd-cli requires multiples of 32; MiniMax's own size table lists 608x352 up to 1344x768.
// - Frame counts: MiniMax's workflow rounds a duration to 17k + 5 frames at 24 fps (5, 22, 39, ...
//   56, 124, 175, 243 ... 362); 362 frames is about 15 seconds, the model's stated maximum.
// - 24 fps is fixed by the engine ("MiniMax-H3 uses 24 fps; overriding requested fps").

export const VIDEO_ASPECTS = {
  landscape: { label: 'Landscape · 16:9', base: 'landscape' },
  square: { label: 'Square · 1:1', base: 'square' },
  portrait: { label: 'Portrait · 9:16', base: 'portrait' },
  photo: { label: 'Photo · 4:3', base: 'landscape' },
  'photo-portrait': { label: 'Photo portrait · 3:4', base: 'portrait' },
  cinema: { label: 'Cinema · 21:9', base: 'landscape' },
};
export const VIDEO_RESOLUTIONS = {
  standard: { label: 'Standard (about 0.2 megapixels)', short: 'Standard' },
  medium: { label: 'Medium (about 0.3 megapixels)', short: 'Medium' },
  large: { label: 'Large (about 0.5 megapixels)', short: 'Large' },
  hd: { label: '768p (about 1 megapixel)', short: '768p' },
};
const sizes = {
  landscape: {
    standard: [608, 352],
    medium: [736, 416],
    large: [960, 544],
    hd: [1344, 768],
  },
  square: {
    standard: [448, 448],
    medium: [544, 544],
    large: [736, 736],
    hd: [1024, 1024],
  },
  photo: {
    standard: [512, 384],
    medium: [640, 480],
    large: [896, 672],
    hd: [1152, 864],
  },
  cinema: {
    standard: [672, 288],
    medium: [896, 384],
    large: [1120, 480],
    hd: [1568, 672],
  },
};
export const STANDARD_PIXELS = 608 * 352;
export const MAX_VIDEO_PIXELS = 1100000;
// Portrait shapes are the landscape sizes turned on their side.
export function videoDimensions(aspect = 'landscape', resolution = 'standard') {
  const portrait = aspect === 'portrait' || aspect === 'photo-portrait';
  const key = aspect === 'portrait' ? 'landscape' : aspect === 'photo-portrait' ? 'photo' : aspect;
  const size = sizes[key]?.[resolution];
  if (!size) {
    return null;
  }
  return portrait ? [size[1], size[0]] : [...size];
}

export const VIDEO_STEPS = [8, 12, 20, 30];
export const TURBO_STEPS = [4, 8];
// Duration presets shown in the studio; any 17k + 5 frame count up to MAX_VIDEO_FRAMES is accepted.
export const VIDEO_FRAME_PRESETS = {
  56: 'About 2 seconds',
  124: 'About 5 seconds',
  175: 'About 7 seconds',
  243: 'About 10 seconds',
  311: 'About 13 seconds',
  362: 'About 15 seconds',
};
export const MAX_VIDEO_FRAMES = 362;
export const LONG_VIDEO_FRAMES = 243;
export const validFrameCount = (frames) =>
  Number.isInteger(frames) && frames >= 22 && frames <= MAX_VIDEO_FRAMES && (frames - 5) % 17 === 0;

export const VIDEO_SOURCES = ['references', 'frames', 'text'];
export const VIDEO_SAMPLERS = ['euler', 'res_multistep'];
export const VIDEO_SCHEDULERS = ['simple', 'beta', 'discrete'];
export const REFERENCE_DETAILS = ['match', 'max'];
export const MAX_REFERENCE_VIDEOS = 3;
export const MAX_REFERENCE_AUDIOS = 3;
export const TURBO_ADAPTER = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16';
export const VIDEO_CLIP_EXTENSIONS = ['webm', 'mp4'];
export const AUDIO_CLIP_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'opus'];
// Staged image, video and audio inputs all use a UUID name with the original extension.
export const imageIdPattern = /^[a-f0-9-]{36}\.(png|jpg|webp)$/i;
export const videoClipPattern = /^[a-f0-9-]{36}\.(webm|mp4)$/i;
export const audioClipPattern = /^[a-f0-9-]{36}\.(wav|mp3|flac|ogg|opus)$/i;

// sd-cli's --max-vram (GiB of GPU memory for weights). H3 Studio's own form always uses 6.
export const DEFAULT_VIDEO_MAX_VRAM_GIB = 6;
// Budget used when a request has reference videos and no explicit budget. Measured on this PC
// (2026-11-08, "use the sound of the reference videos"): at 6 GiB the model manager reported
// "cannot make enough memory ... need 9518 MB device / 9006 MB budget ... failed to encode
// MiniMax-H3 reference video 1" twice; the same request completed at 12 GiB. Encoding a
// reference clip needs the video encoder and its activations resident next to the diffusion
// model. Only reference clips are known to need this, so every other request keeps 6.
export const REFERENCE_CLIP_MAX_VRAM_GIB = 12;

// The budget Forge sends to the engine, or null to leave the engine's own default (6 GiB).
export function videoMaxVramGiB(request = {}) {
  if (Number.isInteger(request.max_vram) && request.max_vram > 0) {
    return request.max_vram;
  }
  return request.reference_videos?.length ? REFERENCE_CLIP_MAX_VRAM_GIB : null;
}

// What a request will actually be given, and whether the user chose it. Used for memory
// admission, the estimate shown on the page and the generation details.
export function videoGpuBudget(request = {}) {
  const sent = videoMaxVramGiB(request);
  const explicit = Number.isInteger(request.max_vram) && request.max_vram > 0;
  return {
    gib: sent ?? DEFAULT_VIDEO_MAX_VRAM_GIB,
    explicit,
    reason: explicit ? 'chosen' : sent === null ? 'default' : 'reference clips',
  };
}

export const videoSeconds = (frames) => Math.round(((frames - 1) / 24) * 10) / 10;

// Short, plain-language cautions for settings that cost more memory or time than the default.
export function videoWarnings(request = {}) {
  const warnings = [];
  const dims = videoDimensions(request.aspect, request.resolution || 'standard');
  const pixels = dims ? dims[0] * dims[1] : STANDARD_PIXELS;
  if (pixels > STANDARD_PIXELS * 4) {
    warnings.push(
      'Around one megapixel the picture has about five times as many tokens as Standard. Expect a render that is many times slower and needs much more memory; it has not been tested on this PC.',
    );
  } else if (pixels > STANDARD_PIXELS) {
    warnings.push(
      'Larger pictures take proportionally longer and use more memory than Standard. Close other models first.',
    );
  }
  if (request.frames > LONG_VIDEO_FRAMES) {
    warnings.push(
      'Clips longer than 10 seconds are slower and use more memory; free host memory fell below 1 GB on a 5-second render, so keep other programs closed.',
    );
  }
  if (request.cfg_scale > 1) {
    warnings.push(
      'Guidance above 1 runs the model twice per step, so renders take about twice as long. MiniMax runs this model unguided; results can look worse.',
    );
  }
  if (request.reference_detail === 'max') {
    warnings.push(
      'Full-detail references keep up to a 2048 pixel short edge and ride along every step: slower and heavier.',
    );
  }
  if (request.reference_videos?.length) {
    warnings.push(
      'Reference clips add many tokens per step (every frame is a reference); use short clips.',
    );
    if (!Number.isInteger(request.max_vram)) {
      warnings.push(
        `Encoding a reference clip did not fit in the default ${DEFAULT_VIDEO_MAX_VRAM_GIB} GiB GPU memory budget in testing, so Forge uses ${REFERENCE_CLIP_MAX_VRAM_GIB} GiB for this video unless you choose a budget.`,
      );
    }
  }
  return warnings;
}

// Every field a queued video request may carry. Anything else is rejected rather than dropped,
// so an unsupported setting never silently produces a different render than the one requested.
// Older jobs only stored prompt, references, aspect, frames and steps; all of those stay valid.
// `referenceFrom` and the variation fields are handled (and removed) before this check runs.
export const VIDEO_REQUEST_FIELDS = new Set([
  'prompt',
  'references',
  'aspect',
  'frames',
  'steps',
  'seed',
  'source',
  'first_frame',
  'last_frame',
  'reference_videos',
  'reference_audios',
  'use_clip_audio',
  'resolution',
  'turbo',
  'negative_prompt',
  'cfg_scale',
  'sampler',
  'scheduler',
  'max_vram',
  'reference_detail',
  'also_mp4',
]);

// Names people commonly try, with the reason they are not settings. Shown in the 400 message.
const UNSUPPORTED_VIDEO_FIELD_HELP = {
  fps: 'The video engine is fixed at 24 fps; choose the length with frames (17 × n + 5) instead.',
  width: 'Choose the picture shape with aspect and size with resolution instead.',
  height: 'Choose the picture shape with aspect and size with resolution instead.',
  duration: 'Choose the length with frames (17 × n + 5, 24 frames per second) instead.',
};

// Throws for the first field a video request may not carry.
export function rejectUnknownVideoFields(request) {
  for (const key of Object.keys(request)) {
    if (!VIDEO_REQUEST_FIELDS.has(key)) {
      const name = key.slice(0, 40);
      const help = UNSUPPORTED_VIDEO_FIELD_HELP[key] || 'Remove it and queue the video again.';
      throw Error(`Unknown video setting "${name}". ${help}`);
    }
  }
}

const hasOwn = (object, key) => Object.hasOwn(object, key);
const idList = (value, pattern, max, label) => {
  if (value === undefined || value === null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((id) => typeof id !== 'string' || !pattern.test(id))
  ) {
    throw Error(`Provide at most ${max} staged ${label} IDs.`);
  }
  return value;
};
const optionalId = (value, label) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !imageIdPattern.test(value)) {
    throw Error(`Provide a staged image ID for the ${label}.`);
  }
  return value;
};

// Validates a queued video request and returns the stored form. Defaults are left out so
// earlier requests, history and timing profiles keep matching. `seedFor` picks a random seed.
export function normalizeVideoRequest(request, seedFor) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw Error('Video settings must be an object.');
  }
  rejectUnknownVideoFields(request);
  const {
    prompt,
    references = [],
    aspect = 'landscape',
    frames = 124,
    seed = null,
    source = 'references',
    resolution = 'standard',
    turbo = false,
    negative_prompt: negativeInput = '',
    cfg_scale: cfg = 1,
    sampler = null,
    scheduler = null,
    max_vram = null,
    reference_detail = null,
    use_clip_audio = false,
    also_mp4 = false,
  } = request;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
    throw Error('Video description must contain 1–4000 characters.');
  }
  if (!VIDEO_SOURCES.includes(source)) {
    throw Error('Choose reference images, first and last frames, or text only.');
  }
  const images = Array.isArray(references) ? references : null;
  if (
    !images ||
    images.length > 9 ||
    images.some((id) => typeof id !== 'string' || !imageIdPattern.test(id))
  ) {
    throw Error('Provide 1 to 9 staged reference image IDs.');
  }
  const first = optionalId(request.first_frame, 'first frame');
  const last = optionalId(request.last_frame, 'last frame');
  const videos = idList(
    request.reference_videos,
    videoClipPattern,
    MAX_REFERENCE_VIDEOS,
    'reference video',
  );
  const audios = idList(
    request.reference_audios,
    audioClipPattern,
    MAX_REFERENCE_AUDIOS,
    'reference audio',
  );
  if (source === 'references') {
    if (first || last) {
      throw Error(
        'First and last frames cannot be combined with reference images: choose one or the other.',
      );
    }
    if (!images.length && !videos.length && !audios.length) {
      throw Error('Provide 1 to 9 staged reference image IDs.');
    }
  } else {
    if (images.length || videos.length || audios.length) {
      throw Error(
        source === 'frames'
          ? 'First and last frames cannot be combined with reference images, videos or audio.'
          : 'Text-only video takes no references.',
      );
    }
    if (source === 'frames' && !first) {
      throw Error('Add a first frame; the last frame is optional.');
    }
    if (source === 'text' && (first || last)) {
      throw Error('Text-only video takes no first or last frame.');
    }
  }
  if (typeof use_clip_audio !== 'boolean' || (use_clip_audio && !videos.length)) {
    throw Error('Using the sound of reference videos needs at least one reference video.');
  }
  if (!hasOwn(VIDEO_ASPECTS, aspect) || !hasOwn(VIDEO_RESOLUTIONS, resolution)) {
    throw Error('Invalid video aspect or resolution.');
  }
  if (!validFrameCount(frames)) {
    throw Error(
      `Invalid frame count: use 17 × n + 5 frames (for example 56, 124, 175, 243, 311) up to ${MAX_VIDEO_FRAMES}.`,
    );
  }
  if (typeof turbo !== 'boolean') {
    throw Error('Turbo must be true or false.');
  }
  const allowedSteps = turbo ? TURBO_STEPS : VIDEO_STEPS;
  const steps = request.steps === undefined ? (turbo ? 4 : 12) : request.steps;
  if (!allowedSteps.includes(steps)) {
    throw Error(
      turbo
        ? 'The turbo adapter renders in 4 or 8 steps.'
        : 'Invalid video steps: use 8, 12, 20 or 30.',
    );
  }
  if (!(seed === null || (Number.isSafeInteger(seed) && seed >= 0 && seed <= 2147483647))) {
    throw Error('Use a video seed from 0 to 2147483647.');
  }
  const negative = typeof negativeInput === 'string' ? negativeInput.trim() : null;
  if (
    negative === null ||
    negative.length > 4000 ||
    typeof cfg !== 'number' ||
    !Number.isFinite(cfg) ||
    cfg < 1 ||
    cfg > 6 ||
    (negative && cfg <= 1) ||
    (cfg > 1 && cfg < 1.1)
  ) {
    throw Error('A negative prompt needs guidance greater than 1; guidance can be 1.1 to 6.');
  }
  if (turbo && cfg > 1) {
    throw Error('The turbo adapter is made for unguided rendering; leave guidance at 1.');
  }
  if (!(sampler === null || VIDEO_SAMPLERS.includes(sampler))) {
    throw Error(`Choose a sampler from ${VIDEO_SAMPLERS.join(', ')}, or leave it at the default.`);
  }
  if (!(scheduler === null || VIDEO_SCHEDULERS.includes(scheduler))) {
    throw Error(
      `Choose a scheduler from ${VIDEO_SCHEDULERS.join(', ')}, or leave it at the default.`,
    );
  }
  if (!(reference_detail === null || REFERENCE_DETAILS.includes(reference_detail))) {
    throw Error('Reference detail must be match or max, or left at the default.');
  }
  if (!(max_vram === null || (Number.isInteger(max_vram) && max_vram >= 4 && max_vram <= 24))) {
    throw Error('The GPU memory budget must be a whole number of GiB from 4 to 24.');
  }
  if (typeof also_mp4 !== 'boolean') {
    throw Error('The MP4 option must be true or false.');
  }
  return {
    prompt,
    references: images,
    aspect,
    frames,
    steps,
    seed: seed === null ? seedFor() : seed,
    ...(source === 'references' ? {} : { source }),
    ...(first ? { first_frame: first } : {}),
    ...(last ? { last_frame: last } : {}),
    ...(videos.length ? { reference_videos: videos } : {}),
    ...(audios.length ? { reference_audios: audios } : {}),
    ...(use_clip_audio ? { use_clip_audio: true } : {}),
    ...(resolution === 'standard' ? {} : { resolution }),
    ...(turbo ? { turbo: true } : {}),
    ...(cfg > 1 ? { cfg_scale: cfg, ...(negative ? { negative_prompt: negative } : {}) } : {}),
    ...(sampler ? { sampler } : {}),
    ...(scheduler ? { scheduler } : {}),
    ...(max_vram ? { max_vram } : {}),
    ...(reference_detail ? { reference_detail } : {}),
    ...(also_mp4 ? { also_mp4: true } : {}),
  };
}
