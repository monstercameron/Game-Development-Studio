import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readReferences } from './references.js';
import { stagedClipPath } from './clips.js';
import { VIDEO_ASPECTS, TURBO_ADAPTER, videoDimensions } from './video-options.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Prepared reference clips and frames are handed to H3 through this folder only. The H3 engine
// is started with the same path (runtime/engines.js) and refuses files anywhere else.
export const H3_INPUT_ROOT =
  process.env.FORGE_H3_INPUT_ROOT || path.join(root, '.forge-runtime', 'h3-inputs');
const python =
  process.env.FORGE_TRANSCODE_PYTHON ||
  path.join(path.dirname(root), 'Snapdargon-DJ', '.runtime', 'python.exe');
const script = path.join(root, 'runtime', 'h3_inputs.py');
// H3 Studio only accepts these; other values travel in the `forge` extension instead.
const H3_FRAMES = [56, 124, 175, 243];
const H3_STEPS = [8, 12, 20, 30];
const H3_SIZES = { landscape: [608, 352], portrait: [352, 608], square: [448, 448] };
// H3 refuses a request with no image. Text-only and clip-only requests send this 1x1 picture
// and the guarded launcher drops it before sd-cli starts.
const PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const REFERENCE_CLIP_FRAMES = 73;
export const REFERENCE_AUDIO_SECONDS = 15;
const STALE_MS = 7 * 24 * 3600 * 1000;

export function runPython(tasks, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (error, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error('Preparing the reference media took too long.'));
    }, timeout);
    child.on('error', (error) =>
      finish(
        Error(
          error.code === 'ENOENT'
            ? 'The media runtime is missing. Check the conversion setup in the README.'
            : error.message,
        ),
      ),
    );
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(Error(stderr.trim().split(/\r?\n/).pop() || 'Preparing media failed.'));
      }
      try {
        finish(null, JSON.parse(stdout).results);
      } catch {
        finish(Error('The media runtime returned an invalid result.'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ tasks }));
  });
}

async function pruneOldInputs() {
  try {
    for (const entry of await fs.readdir(H3_INPUT_ROOT, { withFileTypes: true })) {
      const folder = path.join(H3_INPUT_ROOT, entry.name);
      if (entry.isDirectory() && Date.now() - (await fs.stat(folder)).mtimeMs > STALE_MS) {
        await fs.rm(folder, { recursive: true, force: true });
      }
    }
  } catch {
    // Nothing to prune yet, or another job is cleaning up; neither blocks a render.
  }
}
export const jobInputFolder = (jobId) => path.join(H3_INPUT_ROOT, jobId);
export const removeJobInputs = (jobId) =>
  fs.rm(jobInputFolder(jobId), { recursive: true, force: true }).catch(() => {});

// True when the request uses anything H3 Studio's own form cannot express.
export function needsExtensions(request) {
  const [baseWidth, baseHeight] = H3_SIZES[VIDEO_ASPECTS[request.aspect]?.base] || [];
  const [width, height] = videoDimensions(request.aspect, request.resolution || 'standard') || [];
  return Boolean(
    (request.source || 'references') !== 'references' ||
    request.first_frame ||
    request.last_frame ||
    request.reference_videos?.length ||
    request.reference_audios?.length ||
    !H3_FRAMES.includes(request.frames) ||
    !H3_STEPS.includes(request.steps) ||
    request.turbo ||
    request.cfg_scale > 1 ||
    request.sampler ||
    request.scheduler ||
    request.max_vram ||
    request.reference_detail ||
    width !== baseWidth ||
    height !== baseHeight,
  );
}

const dataUrl = async (file) =>
  `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;

// Builds the JSON body for H3's /api/generate. Without extension options the body is exactly
// what earlier Forge versions sent. Anything extra goes in `forge`, which only the guarded
// launcher (runtime/h3_args.cjs) understands. Throws with a user-facing message on bad input.
export async function buildSubmission(projectFolder, jobId, request) {
  const source = request.source || 'references';
  const aspect = VIDEO_ASPECTS[request.aspect] ? request.aspect : 'landscape';
  const base = VIDEO_ASPECTS[aspect].base;
  const body = {
    prompt: request.prompt,
    aspect: base,
    frames: H3_FRAMES.includes(request.frames) ? request.frames : 124,
    steps: H3_STEPS.includes(request.steps) ? request.steps : 12,
    seed: request.seed,
  };
  if (!needsExtensions(request)) {
    body.images = await readReferences(projectFolder, request.references);
    return { body, extended: false };
  }
  const [width, height] = videoDimensions(aspect, request.resolution || 'standard');
  const forge = { version: 1, width, height, frames: request.frames, steps: request.steps };
  const folder = jobInputFolder(jobId);
  await pruneOldInputs();
  await fs.mkdir(folder, { recursive: true });
  const relative = (name) => `${jobId}/${name}`;
  const tasks = [];
  if (source === 'frames') {
    const ids = [request.first_frame, request.last_frame].filter(Boolean);
    for (const [index, id] of ids.entries()) {
      // Staged images are validated again here, then fitted to the exact render size.
      const staged = path.join(folder, `staged-${index}`);
      const [image] = await readReferences(projectFolder, [id], { max: 1 });
      await fs.writeFile(staged, Buffer.from(image.split(',')[1], 'base64'));
      tasks.push({
        op: 'frame',
        source: staged,
        target: path.join(folder, `frame-${index}.png`),
        width,
        height,
      });
    }
    forge.images = 'frames';
    body.images = [];
  } else if (source === 'text') {
    forge.images = 'none';
    body.images = [PLACEHOLDER];
  } else {
    body.images = request.references.length
      ? await readReferences(projectFolder, request.references)
      : [PLACEHOLDER];
    forge.images = request.references.length ? 'references' : 'none';
  }
  const videos = request.reference_videos || [],
    audios = request.reference_audios || [];
  for (const [index, id] of videos.entries()) {
    const file = await stagedClipPath(projectFolder, id, 'video');
    tasks.push({
      op: 'clip_frames',
      source: file,
      directory: path.join(folder, `video-${index + 1}`),
      width,
      height,
      max_frames: REFERENCE_CLIP_FRAMES,
    });
    if (request.use_clip_audio) {
      tasks.push({
        op: 'clip_audio',
        source: file,
        target: path.join(folder, `video-audio-${index + 1}.wav`),
        max_seconds: REFERENCE_CLIP_FRAMES / 24,
      });
    }
  }
  for (const [index, id] of audios.entries()) {
    tasks.push({
      op: 'clip_audio',
      source: await stagedClipPath(projectFolder, id, 'audio'),
      target: path.join(folder, `audio-${index + 1}.wav`),
      max_seconds: REFERENCE_AUDIO_SECONDS,
    });
  }
  const results = tasks.length ? await runPython(tasks) : [];
  let cursor = 0;
  if (source === 'frames') {
    body.images = [];
    for (const index of [0, ...(request.last_frame ? [1] : [])]) {
      body.images.push(await dataUrl(path.join(folder, `frame-${index}.png`)));
      cursor += 1;
    }
  }
  const videoNames = [],
    videoAudioNames = [];
  for (const [index] of videos.entries()) {
    const found = results[cursor++];
    videoNames.push(relative(`video-${index + 1}`));
    if (request.use_clip_audio) {
      const sound = results[cursor++];
      if (!sound?.has_audio) {
        throw Error(`Reference video ${index + 1} has no sound track to use.`);
      }
      videoAudioNames.push(relative(`video-audio-${index + 1}.wav`));
    }
    if (!found?.frames) {
      throw Error(`Reference video ${index + 1} could not be read.`);
    }
  }
  const audioNames = [];
  for (const [index] of audios.entries()) {
    if (!results[cursor++]?.has_audio) {
      throw Error(`Reference audio ${index + 1} has no audio to use.`);
    }
    audioNames.push(relative(`audio-${index + 1}.wav`));
  }
  if (videoNames.length) {
    forge.ref_videos = videoNames;
  }
  if (videoAudioNames.length) {
    forge.ref_video_audios = videoAudioNames;
  }
  if (audioNames.length) {
    forge.ref_audios = audioNames;
  }
  if (request.turbo) {
    forge.turbo = TURBO_ADAPTER;
  }
  if (request.cfg_scale > 1) {
    forge.cfg_scale = request.cfg_scale;
    if (request.negative_prompt) {
      forge.negative_prompt = request.negative_prompt;
    }
  }
  for (const key of ['sampler', 'scheduler', 'max_vram', 'reference_detail']) {
    if (request[key]) {
      forge[key] = request[key];
    }
  }
  body.forge = forge;
  // H3 limits the whole request to 60 MB; staged images are already capped at 40 MB.
  if (JSON.stringify(body).length > 58 * 1024 * 1024) {
    throw Error('The images for this video are too large together.');
  }
  return { body, extended: true };
}

// The guarded launcher advertises what it understands; an H3 service that was started before
// this version of Forge does not, and would silently ignore the extra options.
export async function h3SupportsExtensions(baseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/forge-capabilities`, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    const data = await response.json();
    return response.ok && Number(data?.forgeExtensions) >= 1;
  } catch {
    return false;
  }
}
