// Extra renderer options for H3 Studio, applied by runtime/h3_bootstrap.cjs without changing
// H3's files. H3's own form only sends a prompt, images, one of three shapes, four durations and
// four step counts; sd-cli (stable-diffusion.cpp, MiniMax-H3 support) accepts a lot more.
//
// Forge adds a `forge` object to the /api/generate body. Everything in it is validated here
// before H3 creates a job, because an error thrown later would crash H3's request handler.
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const TURBO_ADAPTER = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16';
const MAX_PIXELS = 1100000;
const MAX_FRAMES = 362;
const IMAGE_MODES = ['references', 'frames', 'none'];
const SAMPLERS = ['euler', 'res_multistep'];
const SCHEDULERS = ['simple', 'beta', 'discrete'];
const REFERENCE_DETAILS = ['match', 'max'];
const relativeName = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function insideRoot(root, name) {
  if (!root || typeof name !== 'string' || !relativeName.test(name) || name.includes('..')) {
    return null;
  }
  const resolved = path.resolve(root, ...name.split('/'));
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}
function clipList(value, kind, env, errors) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 3) {
    errors.push(`At most 3 reference ${kind} clips are supported.`);
    return [];
  }
  const resolved = [];
  for (const name of value) {
    const full = insideRoot(env.FORGE_H3_INPUT_ROOT, name);
    let ok;
    try {
      ok =
        full &&
        (kind === 'video'
          ? fs.statSync(full).isDirectory() && fs.readdirSync(full).length >= 5
          : fs.statSync(full).isFile());
    } catch {
      ok = false;
    }
    if (!ok) {
      errors.push(`A prepared reference ${kind} is missing.`);
    } else {
      resolved.push(full);
    }
  }
  return resolved;
}

// Returns an error message, or null after storing the validated plan on the body.
function check(body, env = process.env) {
  const forge = body && body.forge;
  if (forge === undefined) {
    return null;
  }
  if (!forge || typeof forge !== 'object' || Array.isArray(forge) || forge.version !== VERSION) {
    return 'Unsupported Forge render options.';
  }
  const errors = [];
  const { width, height, frames, steps } = forge;
  if (
    !isInt(width, 256, 1568) ||
    !isInt(height, 256, 1568) ||
    width % 32 ||
    height % 32 ||
    width * height > MAX_PIXELS
  ) {
    errors.push('The video size must be a multiple of 32 pixels and at most about 1 megapixel.');
  }
  if (!isInt(frames, 22, MAX_FRAMES) || (frames - 5) % 17) {
    errors.push('The frame count must be 17 x n + 5 and at most 362.');
  }
  if (!isInt(steps, 1, 60)) {
    errors.push('The step count is out of range.');
  }
  if (!IMAGE_MODES.includes(forge.images)) {
    errors.push('Unknown image mode.');
  }
  const plan = { width, height, frames, steps, images: forge.images };
  if (forge.images === 'frames') {
    if (!Array.isArray(body.images) || body.images.length < 1 || body.images.length > 2) {
      errors.push('First and last frame mode takes one or two images.');
    }
    plan.frameCount = Array.isArray(body.images) ? body.images.length : 0;
  }
  plan.videos = clipList(forge.ref_videos, 'video', env, errors);
  plan.videoAudios = clipList(forge.ref_video_audios, 'audio', env, errors);
  plan.audios = clipList(forge.ref_audios, 'audio', env, errors);
  if (plan.videoAudios.length && plan.videoAudios.length !== plan.videos.length) {
    errors.push('Each reference video with sound needs its own sound file.');
  }
  if (forge.images === 'frames' && (plan.videos.length || plan.audios.length)) {
    errors.push('First and last frames cannot be combined with reference clips.');
  }
  if (forge.turbo !== undefined) {
    const file =
      env.FORGE_H3_LORA_DIR && path.join(env.FORGE_H3_LORA_DIR, `${TURBO_ADAPTER}.safetensors`);
    if (forge.turbo !== TURBO_ADAPTER || !file || !fs.existsSync(file)) {
      errors.push('The turbo adapter file is missing.');
    } else {
      plan.turbo = { dir: env.FORGE_H3_LORA_DIR, name: TURBO_ADAPTER };
    }
  }
  if (forge.cfg_scale !== undefined) {
    if (typeof forge.cfg_scale !== 'number' || !(forge.cfg_scale >= 1.1 && forge.cfg_scale <= 6)) {
      errors.push('Guidance must be from 1.1 to 6.');
    }
    plan.cfg = forge.cfg_scale;
  }
  if (forge.negative_prompt !== undefined) {
    if (
      typeof forge.negative_prompt !== 'string' ||
      forge.negative_prompt.length > 4000 ||
      !plan.cfg
    ) {
      errors.push('A negative prompt needs guidance above 1 and at most 4,000 characters.');
    }
    plan.negative = forge.negative_prompt;
  }
  for (const [key, allowed] of [
    ['sampler', SAMPLERS],
    ['scheduler', SCHEDULERS],
    ['reference_detail', REFERENCE_DETAILS],
  ]) {
    if (forge[key] !== undefined && !allowed.includes(forge[key])) {
      errors.push(`Unsupported ${key.replace('_', ' ')}.`);
    }
    plan[key] = forge[key];
  }
  if (forge.max_vram !== undefined && !isInt(forge.max_vram, 4, 24)) {
    errors.push('The GPU memory budget must be 4 to 24 GiB.');
  }
  plan.max_vram = forge.max_vram;
  if (
    forge.images === 'frames' ||
    (forge.images === 'none' && !plan.videos.length && !plan.audios.length)
  ) {
    plan.diffusionModel = findFl2va(env.FORGE_H3_MODEL_ROOT);
  }
  if (errors.length) {
    return errors[0];
  }
  Object.defineProperty(body, '__forgePlan', { value: plan, enumerable: false });
  return null;
}

// MiniMax trains first/last-frame and text-only video into a separate FL2VA checkpoint; the
// installed Ref2VA weights are only documented for reference input. When an FL2VA file has been
// added to the model folder (GGUF preferred) those modes use it; otherwise they try Ref2VA.
function findFl2va(root) {
  try {
    const files = fs.readdirSync(root).filter((name) => /fl2va/i.test(name));
    const pick =
      files.find((name) => name.toLowerCase().endsWith('.gguf')) ||
      files.find((name) => name.toLowerCase().endsWith('.safetensors'));
    return pick ? path.join(root, pick) : null;
  } catch {
    return null;
  }
}

function setValue(args, flag, value) {
  const at = args.indexOf(flag);
  if (at >= 0 && at + 1 < args.length) {
    args[at + 1] = String(value);
  } else {
    args.push(flag, String(value));
  }
}
function dropFlag(args, flag) {
  for (let at = args.indexOf(flag); at >= 0; at = args.indexOf(flag)) {
    args.splice(at, 2);
  }
}

// Rewrites H3's sd-cli arguments in place. `context.refs` are the reference files H3 just wrote.
// Returns an error message, or null. Runs before H3 starts the renderer.
function extend(args, body, context = {}) {
  const plan = body && body.__forgePlan;
  if (!plan) {
    return null;
  }
  try {
    setValue(args, '-W', plan.width);
    setValue(args, '-H', plan.height);
    setValue(args, '--video-frames', plan.frames);
    setValue(args, '--steps', plan.steps);
    if (plan.diffusionModel) {
      setValue(args, '--diffusion-model', plan.diffusionModel);
    }
    if (plan.images !== 'references') {
      dropFlag(args, '--ref-image');
    }
    if (plan.images === 'frames') {
      args.push('--init-img', context.refs[0]);
      if (plan.frameCount > 1) {
        args.push('--end-img', context.refs[1]);
      }
    }
    for (const video of plan.videos) {
      args.push('--ref-video', video);
    }
    for (const sound of plan.videoAudios) {
      args.push('--ref-video-audio', sound);
    }
    for (const sound of plan.audios) {
      args.push('--ref-audio', sound);
    }
    if (plan.cfg) {
      setValue(args, '--cfg-scale', plan.cfg);
      // Run the two guidance passes one after the other: less memory at the cost of speed.
      args.push('--batched-cfg', 'off');
      if (plan.negative) {
        args.push('-n', plan.negative);
      }
    }
    if (plan.turbo) {
      const at = args.indexOf('-p');
      args[at + 1] = `${args[at + 1]} <lora:${plan.turbo.name}:1>`;
      args.push('--lora-model-dir', plan.turbo.dir);
    }
    if (plan.sampler) {
      args.push('--sampling-method', plan.sampler);
    }
    if (plan.scheduler) {
      args.push('--scheduler', plan.scheduler);
    }
    if (plan.max_vram) {
      setValue(args, '--max-vram', plan.max_vram);
    }
    if (plan.reference_detail) {
      args.push('--ref-image-args', `ref_image_size=${plan.reference_detail}`);
    }
    return null;
  } catch {
    return 'Forge could not apply the render options.';
  }
}

const capabilities = {
  forgeExtensions: VERSION,
  features: [
    'frames',
    'text',
    'reference-video',
    'reference-audio',
    'resolution',
    'long-clips',
    'guidance',
    'turbo',
    'sampler',
    'max-vram',
    'reference-detail',
    'fl2va-checkpoint-optional',
  ],
};
// Wraps H3's request listener so Forge can tell this launcher from one started before the update.
function withCapabilities(listener) {
  return (req, res) => {
    if (req.method === 'GET' && String(req.url).split('?')[0] === '/api/forge-capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(capabilities));
    }
    return listener(req, res);
  };
}

module.exports = { check, extend, withCapabilities, capabilities, TURBO_ADAPTER };
