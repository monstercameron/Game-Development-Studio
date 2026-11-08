import { DatabaseSync } from 'node:sqlite';
import { randomInt, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordConversion, recordJobOutput } from './asset-metadata.js';
import { planChainUnload } from './chain-unload.js';
import { normalizeImageExtras } from './image-options.js';
import { normalizeDerivedMusic, resolveDerivedMusic } from './music-derived.js';
import { normalizeSoundSource } from './sfx-request.js';
import { SEGMENTATION_OUTPUTS, cleanMatchReport, normalizeSelection } from './sam31-options.js';
import { normalizeVideoRequest } from './video-options.js';
import { stageProjectAsset } from './references.js';
import { quickCheckoutStatus, loadSchemaSync } from './vegetation-runner.js';
import { cleanVegetationResult, normalizeVegetationRequest } from './vegetation-request.js';
import { checkpointForRequest, checkpointLoadedFor, voiceModeFields } from './voice-modes.js';
import { NEXT_RANK_SQL, moveQueuedJob, parseMoveRequest } from './queue-order.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = process.env.FORGE_RUNTIME_DIR || path.join(appRoot, '.forge-runtime');
export const projectsRoot = process.env.FORGE_PROJECTS_DIR || path.join(appRoot, 'projects');

export function findProject(id, root = projectsRoot) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw Error('A valid project ID is required.');
  }
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const folder = path.join(root, entry.name);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(folder, '.forge-project.json'), 'utf8'));
    } catch {
      continue;
    }
    if (meta.id === id) {
      return folder;
    }
  }
  throw Error('Project was not found.');
}
// A render may take one of its references from the finished output of an earlier render
// (request.referenceFrom = { jobId }). Until that render completes, the placeholder below
// stands in for the missing reference so each type's own validation still applies.
export const CHAIN_PLACEHOLDER = '00000000-0000-0000-0000-000000000000.png';
// Renders that can consume another render's image, and renders whose image output can be consumed.
export const CHAIN_CHILD_TYPES = ['3d', 'trellis', 'segmentation', 'images', 'video'];
export const CHAIN_PARENT_TYPES = ['images', 'segmentation'];
const CHAIN_WAITING_STAGE = 'Waiting for the render it depends on.';
export const DEPENDENCY_FAILED_STAGE = 'Dependency failed.';
// A job worker marks a failure it read from the engine itself (a finished, known outcome) with
// this value in the job details. retry() then submits a fresh attempt instead of asking the
// engine about the old job, which a restarted engine may no longer remember. Failures whose
// outcome is unknown stay without the marker and are only ever re-checked.
export const ENGINE_FAILED_OUTCOME = 'engine_failed';
const KNOWN_ENGINE_FAILURE_SQL = `(status='failed' AND remote_id IS NOT NULL AND json_valid(details) AND json_extract(details,'$.outcome')='${ENGINE_FAILED_OUTCOME}')`;
const WAITING_STATUSES = ['queued', 'waiting_engine', 'waiting_memory'];
const OPEN_STATUSES = [
  'queued',
  'waiting_engine',
  'waiting_memory',
  'preparing',
  'needs_attention',
  'submitting',
  'running',
  'finalizing',
  'interrupted',
];
const jobIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// TRELLIS.2 resolutions (upstream names). 512 is the original connected pipeline.
export const TRELLIS_PIPELINES = ['512', '1024', '1024_cascade', '1536_cascade'];

function isPendingChain(request) {
  return !!request?.referenceFrom && typeof request.referenceFrom.output !== 'string';
}
function validate(input, root = projectsRoot) {
  const from = input?.request?.referenceFrom;
  if (from === undefined) {
    return validateType(input, root);
  }
  if (
    !from ||
    typeof from !== 'object' ||
    Array.isArray(from) ||
    typeof from.jobId !== 'string' ||
    !jobIdPattern.test(from.jobId) ||
    Object.keys(from).some((key) => !['jobId', 'output'].includes(key)) ||
    (from.output !== undefined &&
      (typeof from.output !== 'string' ||
        !from.output ||
        from.output.length > 300 ||
        from.output.includes('\\')))
  ) {
    throw Error('referenceFrom must be an object with the ID of the earlier render.');
  }
  if (!CHAIN_CHILD_TYPES.includes(input.type)) {
    throw Error('This kind of render cannot take its reference from another render.');
  }
  const rest = { ...input.request };
  delete rest.referenceFrom;
  const own = Array.isArray(rest.references) ? rest.references : [];
  // Once resolved (an estimate of a running chain), the staged reference is already in place.
  if (typeof from.output === 'string') {
    const value = validateType({ ...input, request: rest }, root);
    return {
      ...value,
      request: { ...value.request, referenceFrom: { jobId: from.jobId, output: from.output } },
    };
  }
  if (['3d', 'trellis', 'segmentation'].includes(input.type) && own.length) {
    throw Error('A render that takes its reference from another render cannot also have its own.');
  }
  const value = validateType(
    { ...input, request: { ...rest, references: [...own, CHAIN_PLACEHOLDER] } },
    root,
  );
  return {
    ...value,
    request: { ...value.request, references: own, referenceFrom: { jobId: from.jobId } },
  };
}
function validateType(input, root = projectsRoot) {
  if (
    !input ||
    ![
      'music',
      'sfx',
      'images',
      'video',
      'voices',
      '3d',
      'trellis',
      'segmentation',
      'motion',
      'motion-bricks',
      'world',
      'vegetation',
    ].includes(input.type) ||
    typeof input.projectId !== 'string' ||
    !input.request ||
    typeof input.request !== 'object'
  ) {
    throw Error('Expected a supported render job with projectId and request.');
  }
  if (input.type === 'vegetation') {
    findProject(input.projectId, root);
    // SeedThree's own schema (cached per commit) decides which species and controls exist.
    return {
      type: 'vegetation',
      projectId: input.projectId,
      request: normalizeVegetationRequest(input.request, loadSchemaSync()),
    };
  }
  if (input.type === 'world') {
    const {
      model,
      mode,
      prompt = '',
      output = 'splat',
      resolution,
      references = [],
      seed = null,
      steps = 50,
      guidance = null,
      save_panorama = false,
      splat_limit = 1000000,
      remove_sky = false,
      confidence_percentile = 10,
    } = input.request;
    if (
      !['worldgen', 'hy-world'].includes(model) ||
      !['text', 'image', 'panorama'].includes(mode) ||
      typeof prompt !== 'string' ||
      prompt.length > 4000 ||
      !['mesh', 'splat', 'glb'].includes(output)
    ) {
      throw Error('Invalid world generator settings.');
    }
    if (
      !Array.isArray(references) ||
      references.length > 8 ||
      references.some(
        (id) => typeof id !== 'string' || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(id),
      )
    ) {
      throw Error('Provide up to 8 staged reference images.');
    }
    if (
      !(seed === null || (Number.isInteger(seed) && seed >= 0 && seed <= 2147483647)) ||
      !Number.isInteger(steps) ||
      steps < 10 ||
      steps > 60
    ) {
      throw Error('Use a seed from 0 to 2147483647 and 10–60 steps.');
    }
    if (
      model === 'worldgen' &&
      (![1024, 1600, 2048].includes(resolution) ||
        (mode === 'text' ? !prompt.trim() || references.length !== 0 : references.length !== 1))
    ) {
      throw Error('WorldGen requires a description or one image and a supported resolution.');
    }
    if (
      model === 'hy-world' &&
      (mode === 'text' ||
        references.length < 1 ||
        (mode === 'panorama' && references.length !== 1) ||
        output !== 'splat' ||
        ![336, 518, 700, 952].includes(resolution))
    ) {
      throw Error(
        'HY-World requires 1–8 reference views or one panorama and a supported resolution.',
      );
    }
    // Only WorldGen text and image renders generate a panorama with FLUX.
    const generates = model === 'worldgen' && mode !== 'panorama';
    if (
      guidance !== null &&
      (!generates ||
        typeof guidance !== 'number' ||
        !Number.isFinite(guidance) ||
        guidance < 1 ||
        guidance > 50)
    ) {
      throw Error(
        'Guidance is a number from 1 to 50 and applies to WorldGen text and image renders.',
      );
    }
    if (typeof save_panorama !== 'boolean' || (save_panorama && !generates)) {
      throw Error('Saving the panorama applies to WorldGen text and image renders.');
    }
    if (
      !Number.isInteger(splat_limit) ||
      splat_limit < 100000 ||
      splat_limit > 5000000 ||
      typeof remove_sky !== 'boolean' ||
      typeof confidence_percentile !== 'number' ||
      !Number.isFinite(confidence_percentile) ||
      confidence_percentile < 0 ||
      confidence_percentile > 50 ||
      (model !== 'hy-world' &&
        (splat_limit !== 1000000 || remove_sky || confidence_percentile !== 10))
    ) {
      throw Error(
        'HY-World splat limit is 100,000–5,000,000, sky removal is on or off, and the confidence filter is 0–50 percent.',
      );
    }
    findProject(input.projectId, root);
    return {
      type: 'world',
      projectId: input.projectId,
      request: {
        model,
        mode,
        prompt: prompt.trim(),
        output,
        resolution,
        references,
        // Seed and steps only mean something when FLUX generates the panorama. A random seed is
        // chosen here so the render is reproducible and the seed lands in the asset's details.
        ...(generates ? { seed: seed === null ? randomInt(0, 2147483648) : seed, steps } : {}),
        // Defaults are omitted so earlier requests, history and timing profiles keep matching.
        ...(generates && guidance !== null ? { guidance } : {}),
        ...(generates && save_panorama ? { save_panorama: true } : {}),
        ...(model === 'hy-world' && splat_limit !== 1000000 ? { splat_limit } : {}),
        ...(model === 'hy-world' && remove_sky ? { remove_sky: true } : {}),
        ...(model === 'hy-world' && confidence_percentile !== 10 ? { confidence_percentile } : {}),
      },
    };
  }
  if (input.type === 'trellis') {
    const {
      references,
      seed = 42,
      steps = 12,
      texture_size = 1024,
      target_faces = 100000,
      pipeline = '512',
    } = input.request;
    if (
      !Array.isArray(references) ||
      references.length !== 1 ||
      typeof references[0] !== 'string' ||
      !/^[a-f0-9-]{36}\.(png|webp)$/i.test(references[0])
    ) {
      throw Error('Provide one staged transparent PNG or WebP image.');
    }
    if (!TRELLIS_PIPELINES.includes(pipeline)) {
      throw Error(`TRELLIS.2 pipeline must be one of ${TRELLIS_PIPELINES.join(', ')}.`);
    }
    if (
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 2147483647 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 50 ||
      ![512, 1024, 2048].includes(texture_size)
    ) {
      throw Error('Invalid TRELLIS.2 seed, steps, or texture size.');
    }
    if (!Number.isInteger(target_faces) || target_faces < 5000 || target_faces > 1000000) {
      throw Error('TRELLIS.2 triangle target must be a whole number from 5,000 to 1,000,000.');
    }
    findProject(input.projectId, root);
    return {
      type: 'trellis',
      projectId: input.projectId,
      request: {
        model: 'trellis',
        references,
        seed,
        steps,
        texture_size,
        target_faces,
        // The default 512 pipeline is omitted so earlier requests, history and timing keep matching.
        ...(pipeline !== '512' ? { pipeline } : {}),
      },
    };
  }
  if (input.type === 'motion-bricks') {
    const {
      pose,
      context_frame,
      target_frame,
      min_tokens = 8,
      max_tokens = 14,
      num_target_poses = 4,
    } = input.request;
    if (typeof pose !== 'string' || !/^[a-f0-9-]{36}\.bvh$/i.test(pose)) {
      throw Error('Provide a staged SOMA BVH pose file.');
    }
    if (
      !Number.isSafeInteger(context_frame) ||
      context_frame < 0 ||
      !Number.isSafeInteger(target_frame) ||
      target_frame < 0 ||
      !Number.isInteger(min_tokens) ||
      !Number.isInteger(max_tokens) ||
      min_tokens < 6 ||
      max_tokens > 16 ||
      min_tokens > max_tokens
    ) {
      throw Error('Invalid pose windows or token limits.');
    }
    // Earlier MotionBricks requests had no count, so they keep the four-pose default.
    if (!Number.isInteger(num_target_poses) || num_target_poses < 1 || num_target_poses > 4) {
      throw Error('Target poses to use must be a whole number from 1 to 4.');
    }
    findProject(input.projectId, root);
    return {
      type: 'motion-bricks',
      projectId: input.projectId,
      request: {
        pose,
        context_frame,
        target_frame,
        min_tokens,
        max_tokens,
        // The four-pose default is omitted so earlier requests, history and details keep matching.
        ...(num_target_poses !== 4 ? { num_target_poses } : {}),
      },
    };
  }
  if (input.type === 'motion') {
    const {
      model = 'hy-motion',
      prompt,
      duration = 3,
      seed = 123,
      steps = 50,
      guidance = 5,
    } = input.request;
    if (model !== 'hy-motion') {
      throw Error('Only HY-Motion is connected for motion generation.');
    }
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) {
      throw Error('Motion description must contain 1–1000 characters.');
    }
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > 12 ||
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 2147483647 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 100 ||
      typeof guidance !== 'number' ||
      !Number.isFinite(guidance) ||
      guidance < 0 ||
      guidance > 20
    ) {
      throw Error('Invalid motion duration, seed, steps, or guidance.');
    }
    findProject(input.projectId, root);
    return {
      type: 'motion',
      projectId: input.projectId,
      request: { model: 'hy-motion', prompt: prompt.trim(), duration, seed, steps, guidance },
    };
  }
  if (input.type === 'segmentation') {
    const {
      prompt,
      references,
      output = 'transparent',
      confidence = 0.5,
      select,
      max_instances: maxInstances,
    } = input.request;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) {
      throw Error('Segmentation description must contain 1–1000 characters.');
    }
    if (
      !Array.isArray(references) ||
      references.length !== 1 ||
      typeof references[0] !== 'string' ||
      !/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(references[0])
    ) {
      throw Error('Provide one staged reference image.');
    }
    if (
      !SEGMENTATION_OUTPUTS.includes(output) ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw Error('Invalid segmentation output or confidence.');
    }
    const selection = normalizeSelection({ select, max_instances: maxInstances });
    findProject(input.projectId, root);
    return {
      type: 'segmentation',
      projectId: input.projectId,
      request: { prompt: prompt.trim(), references, output, confidence, ...selection },
    };
  }
  if (input.type === '3d') {
    const {
      model = 'hunyuan',
      references,
      seed = 123,
      steps = 30,
      resolution = 128,
      guidance = 5,
      target_faces = null,
      texture = false,
      texture_size = 2048,
      texture_views = 6,
      texture_view_size = 512,
    } = input.request;
    if (model !== 'hunyuan') {
      throw Error('Only Hunyuan3D shape generation is connected.');
    }
    if (
      !Array.isArray(references) ||
      references.length !== 1 ||
      typeof references[0] !== 'string' ||
      !/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(references[0])
    ) {
      throw Error('Provide one staged reference image.');
    }
    if (
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 2147483647 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 100 ||
      ![128, 256, 384].includes(resolution)
    ) {
      throw Error('Invalid 3D seed, steps, or resolution.');
    }
    if (
      typeof guidance !== 'number' ||
      !Number.isFinite(guidance) ||
      guidance < 1 ||
      guidance > 20
    ) {
      throw Error('Hunyuan guidance must be a number from 1 to 20.');
    }
    if (
      target_faces !== null &&
      (!Number.isInteger(target_faces) || target_faces < 1000 || target_faces > 1000000)
    ) {
      throw Error('Hunyuan triangle target must be a whole number from 1,000 to 1,000,000.');
    }
    if (typeof texture !== 'boolean' || ![1024, 2048].includes(texture_size)) {
      throw Error('Invalid 3D texture option or texture size.');
    }
    // How many views the painter renders, and at what size. The model was trained on 6 views of
    // 512 px; the other values only apply to painting.
    if (
      ![6, 7, 8, 9].includes(texture_views) ||
      ![512, 768].includes(texture_view_size) ||
      (!texture && (texture_views !== 6 || texture_view_size !== 512))
    ) {
      throw Error('Painted views are 6 to 9 at 512 or 768 pixels, and only apply with texture on.');
    }
    findProject(input.projectId, root);
    return {
      type: '3d',
      projectId: input.projectId,
      // Shape-only requests keep their original shape so history and estimates still match.
      request: {
        model: 'hunyuan',
        references,
        seed,
        steps,
        resolution,
        // Defaults are omitted so earlier requests, history and timing profiles keep matching.
        ...(guidance !== 5 ? { guidance } : {}),
        ...(target_faces !== null ? { target_faces } : {}),
        ...(texture ? { texture: true, texture_size } : {}),
        ...(texture && texture_views !== 6 ? { texture_views } : {}),
        ...(texture && texture_view_size !== 512 ? { texture_view_size } : {}),
      },
    };
  }
  if (input.type === 'voices') {
    const {
      text,
      speaker = 'Ryan',
      language = 'English',
      instruct = '',
      max_new_tokens = 1024,
      seed = null,
      temperature = null,
      top_p = null,
      top_k = null,
      repetition_penalty = null,
      do_sample = null,
      subtalker_dosample = null,
      subtalker_temperature = null,
      subtalker_top_p = null,
      subtalker_top_k = null,
      mode,
      reference_audio,
      reference_text,
      reference_consent,
      clone_voice_only,
      voice_description,
    } = input.request;
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 1000 ||
      typeof instruct !== 'string' ||
      instruct.length > 500
    ) {
      throw Error('Voice text must contain 1–1000 characters and direction at most 500.');
    }
    if (
      ![
        'Ryan',
        'Aiden',
        'Vivian',
        'Serena',
        'Uncle_Fu',
        'Dylan',
        'Eric',
        'Ono_Anna',
        'Sohee',
      ].includes(speaker) ||
      ![
        'Auto',
        'English',
        'Chinese',
        'Japanese',
        'Korean',
        'German',
        'French',
        'Russian',
        'Portuguese',
        'Spanish',
        'Italian',
      ].includes(language) ||
      !Number.isInteger(max_new_tokens) ||
      max_new_tokens < 64 ||
      max_new_tokens > 4096
    ) {
      throw Error('Invalid voice, language, or generation limit.');
    }
    // Sampling overrides are optional; null leaves the model's own default in place.
    const inRange = (value, min, max) =>
      value === null || (typeof value === 'number' && value >= min && value <= max);
    if (
      !(seed === null || (Number.isSafeInteger(seed) && seed >= 0 && seed <= 2147483647)) ||
      !inRange(temperature, 0.05, 2) ||
      !inRange(top_p, 0.01, 1) ||
      !(top_k === null || (Number.isInteger(top_k) && top_k >= 1 && top_k <= 1000)) ||
      !inRange(repetition_penalty, 1, 2)
    ) {
      throw Error(
        'Invalid voice seed or sampling: temperature 0.05–2, top-p 0.01–1, top-k 1–1000, repetition penalty 1–2.',
      );
    }
    // Sub-talker settings steer the second-stage model that fills in the fine acoustic detail.
    if (
      ![do_sample, subtalker_dosample].every(
        (flag) => flag === null || typeof flag === 'boolean',
      ) ||
      !inRange(subtalker_temperature, 0.05, 2) ||
      !inRange(subtalker_top_p, 0.01, 1) ||
      !(
        subtalker_top_k === null ||
        (Number.isInteger(subtalker_top_k) && subtalker_top_k >= 1 && subtalker_top_k <= 1000)
      )
    ) {
      throw Error(
        'Invalid sampling switch or sub-talker setting: temperature 0.05–2, top-p 0.01–1, top-k 1–1000.',
      );
    }
    findProject(input.projectId, root);
    return {
      type: 'voices',
      projectId: input.projectId,
      request: {
        text,
        language,
        max_new_tokens,
        ...voiceModeFields({
          mode,
          speaker,
          instruct,
          reference_audio,
          reference_text,
          reference_consent,
          clone_voice_only,
          voice_description,
        }),
        // Pick the random seed here so the render is reproducible and the seed lands in the asset's details.
        seed: seed === null ? randomInt(0, 2147483648) : seed,
        ...(temperature === null ? {} : { temperature }),
        ...(top_p === null ? {} : { top_p }),
        ...(top_k === null ? {} : { top_k }),
        ...(repetition_penalty === null ? {} : { repetition_penalty }),
        ...(do_sample === null ? {} : { do_sample }),
        ...(subtalker_dosample === null ? {} : { subtalker_dosample }),
        ...(subtalker_temperature === null ? {} : { subtalker_temperature }),
        ...(subtalker_top_p === null ? {} : { subtalker_top_p }),
        ...(subtalker_top_k === null ? {} : { subtalker_top_k }),
      },
    };
  }
  if (input.type === 'video') {
    const request = normalizeVideoRequest(input.request, () => randomInt(0, 2147483648));
    findProject(input.projectId, root);
    return { type: 'video', projectId: input.projectId, request };
  }
  if (input.type === 'images') {
    const {
      prompt,
      width = 1024,
      height = 1024,
      num_inference_steps = 40,
      seed = null,
      references = [],
      negative_prompt = '',
      true_cfg_scale = 1,
      transparent = false,
      size_from_reference = false,
    } = input.request;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
      throw Error('Image description must contain 1–4000 characters.');
    }
    if (typeof transparent !== 'boolean' || typeof size_from_reference !== 'boolean') {
      throw Error('Transparent background and match-reference size must be true or false.');
    }
    if (size_from_reference && !(Array.isArray(references) && references.length)) {
      throw Error('Matching the reference size needs at least one reference image.');
    }
    if (
      // Qwen's published sizes reach 2752 px (16:9 at 2752 × 1536). A matched size is chosen by the model.
      (!size_from_reference &&
        ![width, height].every(
          (n) => Number.isInteger(n) && n >= 32 && n <= 2752 && n % 32 === 0,
        )) ||
      !Number.isInteger(num_inference_steps) ||
      num_inference_steps < 1 ||
      num_inference_steps > 100 ||
      !(seed === null || (Number.isSafeInteger(seed) && seed >= 0))
    ) {
      throw Error('Invalid image dimensions, steps, or seed.');
    }
    if (
      typeof negative_prompt !== 'string' ||
      negative_prompt.length > 4000 ||
      typeof true_cfg_scale !== 'number' ||
      !Number.isFinite(true_cfg_scale) ||
      true_cfg_scale < 1 ||
      true_cfg_scale > 10 ||
      true_cfg_scale > 1 !== !!negative_prompt.trim()
    ) {
      throw Error(
        'Negative prompt guidance requires a non-empty negative prompt and a guidance value greater than 1, up to 10.',
      );
    }
    if (
      !Array.isArray(references) ||
      references.length > 10 ||
      references.some(
        (id) => typeof id !== 'string' || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(id),
      )
    ) {
      throw Error('Provide up to 10 staged reference image IDs.');
    }
    const extras = normalizeImageExtras(input.request, {
      sizeFromReference: size_from_reference,
      steps: num_inference_steps,
    });
    findProject(input.projectId, root);
    return {
      type: 'images',
      projectId: input.projectId,
      request: {
        prompt,
        // With a matched size the model derives width and height from the last reference.
        ...(size_from_reference ? { size_from_reference: true } : { width, height }),
        num_inference_steps,
        references,
        ...(transparent ? { transparent: true } : {}),
        ...extras,
        // Pick the random seed here so the render is reproducible and the seed lands in the asset's details.
        seed: seed === null ? randomInt(0, 2147483648) : seed,
        ...(true_cfg_scale > 1 ? { negative_prompt: negative_prompt.trim(), true_cfg_scale } : {}),
      },
    };
  }
  if (input.type === 'sfx') {
    const { prompt, duration = 5, steps = 8, seed = -1 } = input.request;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
      throw Error('Sound description must contain 1–4000 characters.');
    }
    if (
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > 380 ||
      !Number.isInteger(steps) ||
      steps < 1 ||
      steps > 50 ||
      !Number.isInteger(seed) ||
      seed < -1 ||
      seed > 2147483647
    ) {
      throw Error('Invalid sound duration, steps, or seed.');
    }
    const sourceFields = normalizeSoundSource(input.request, duration);
    findProject(input.projectId, root);
    return {
      type: 'sfx',
      projectId: input.projectId,
      // -1 means random; choose the seed here so it is recorded and the render can be repeated.
      request: {
        prompt,
        duration,
        steps,
        seed: seed === -1 ? randomInt(0, 2147483648) : seed,
        ...sourceFields,
      },
    };
  }
  if (input.request.operation !== undefined) {
    // Extend or re-synthesize a finished track; the source is resolved when the job is queued.
    const derived = normalizeDerivedMusic(input.request);
    findProject(input.projectId, root);
    return { type: 'music', projectId: input.projectId, request: derived };
  }
  const {
    style,
    lyrics,
    duration_seconds = 15,
    seed = randomInt(0, 2147483648),
    cot = 'full',
    title = '',
    ode_steps = 32,
    negative = '',
    cfg_scale = null,
    abc = '',
    temperature = null,
    top_p = null,
    top_k = null,
    repetition_penalty = null,
  } = input.request;
  if (typeof style !== 'string' || !style.trim() || style.length > 2000) {
    throw Error('Style must contain 1–2000 characters.');
  }
  if (typeof lyrics !== 'string' || !lyrics.trim() || lyrics.length > 20000) {
    throw Error('Lyrics must contain 1–20000 characters.');
  }
  if (!Number.isFinite(duration_seconds) || duration_seconds < 1 || duration_seconds > 600) {
    throw Error('Duration must be between 1 and 600 seconds.');
  }
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    !Number.isInteger(ode_steps) ||
    ode_steps < 1 ||
    ode_steps > 100 ||
    !['full', 'melody', 'off'].includes(cot)
  ) {
    throw Error('Invalid seed, steps, or planning mode.');
  }
  if (
    typeof title !== 'string' ||
    title.length > 200 ||
    typeof negative !== 'string' ||
    negative.length > 2000 ||
    !(cfg_scale === null || (Number.isFinite(cfg_scale) && cfg_scale >= 0 && cfg_scale <= 20))
  ) {
    throw Error('Invalid title, negative prompt, or CFG scale (0–20).');
  }
  if (typeof abc !== 'string' || abc.length > 20000 || (abc.trim() && cot === 'off')) {
    throw Error('Score must be ABC text of at most 20000 characters and needs Planning on.');
  }
  const sampling = { temperature, top_p, top_k, repetition_penalty };
  const within = (value, min, max, integer = false) =>
    value === null ||
    (Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value)));
  if (
    !within(temperature, 0, 5) ||
    !(top_p === null || (Number.isFinite(top_p) && top_p > 0 && top_p <= 1)) ||
    !within(top_k, 1, 1000, true) ||
    !within(repetition_penalty, 1, 2)
  ) {
    throw Error(
      'Invalid sampling: temperature 0–5, top-p above 0 up to 1, top-k 1–1000, repetition penalty 1–2.',
    );
  }
  findProject(input.projectId, root);
  return {
    type: 'music',
    projectId: input.projectId,
    request: {
      style,
      lyrics,
      duration_seconds,
      seed,
      cot,
      title,
      ode_steps,
      negative,
      cfg_scale,
      // Optional engine controls are saved only when set, so older requests keep their exact shape.
      ...(abc.trim() ? { abc: abc.trim() } : {}),
      ...Object.fromEntries(Object.entries(sampling).filter(([, value]) => value !== null)),
    },
  };
}
function publicJob(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    type: row.type,
    projectId: row.project_id,
    status: row.status,
    request: JSON.parse(row.request),
    remoteId: row.remote_id,
    stage: row.stage,
    error: row.error,
    details: row.details ? JSON.parse(row.details) : null,
    output: row.output,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    // The earlier render this one waits for (see request.referenceFrom); null for older rows.
    dependsOn: row.depends_on || null,
    // Stored place in the waiting line; null for rows from before ranks existed. Compare for
    // equality only (the move request's expectedRank); the list itself is already in order.
    queueRank: row.queue_rank ?? null,
  };
}
function profile(type, request) {
  const keys = {
    images: ['width', 'height', 'num_inference_steps', 'size_from_reference'],
    music: ['duration_seconds', 'cot', 'ode_steps'],
    sfx: ['duration', 'steps'],
    video: ['aspect', 'frames', 'steps'],
    voices: ['speaker', 'language', 'max_new_tokens'],
    '3d': ['model', 'steps', 'resolution'],
    trellis: ['model', 'steps', 'texture_size'],
    segmentation: ['output', 'confidence'],
    motion: ['duration', 'steps'],
    'motion-bricks': ['min_tokens', 'max_tokens'],
    world: ['model', 'mode', 'output', 'resolution'],
    vegetation: ['species', 'budget'],
  }[type];
  const values = keys.map((key) => request[key]);
  if (['images', 'video', 'world'].includes(type)) {
    // A reference still to come from an earlier render counts, so the profile matches the finished one.
    values.push(
      (Array.isArray(request.references) ? request.references.length : 0) +
        (isPendingChain(request) ? 1 : 0),
    );
  }
  if (type === 'world' && request.model === 'worldgen' && request.mode !== 'panorama') {
    values.push(request.steps ?? 50);
  }
  if (type === 'images') {
    values.push((request.true_cfg_scale || 1) > 1);
  }
  if (type === 'video') {
    // Larger pictures, guidance, reference clips and the turbo adapter change the render time a lot.
    values.push(
      request.resolution || 'standard',
      request.source || 'references',
      (request.cfg_scale || 1) > 1,
      request.turbo === true,
      (request.reference_videos?.length || 0) + (request.reference_audios?.length || 0),
    );
  }
  if (type === 'music') {
    values.push(
      request.cfg_scale === null || request.cfg_scale === undefined
        ? request.cot === 'off'
        : request.cfg_scale !== 1,
    );
  }
  if (type === 'music' && request.operation) {
    values.push(request.operation);
  }
  if (type === 'sfx' && request.edit_mode) {
    values.push(request.edit_mode);
  }
  if (type === 'images' && request.use_kv_cache === false) {
    values.push('no-kv-cache');
  }
  if (type === 'motion') {
    values.push(request.guidance !== 1);
  }
  if (type === 'voices') {
    values.push(Math.ceil((request.text?.length || 0) / 50));
    // Cloned and designed voices run on other checkpoints, so they never share preset timing history.
    if (request.mode && request.mode !== 'preset') {
      values.push(request.mode);
    }
  }
  if (type === '3d') {
    // Painted renders take far longer, so they never share timing history with shape-only ones.
    values.push(
      request.texture === true
        ? [request.texture_size, request.texture_views ?? 6, request.texture_view_size ?? 512]
        : false,
    );
  }
  if (type === 'trellis') {
    // Earlier requests had no triangle target and exported up to a million triangles.
    values.push(request.target_faces ?? 1000000);
    // Higher-resolution pipelines take far longer; earlier requests all used the 512 pipeline.
    values.push(request.pipeline ?? '512');
  }
  return JSON.stringify(values);
}
export function estimateFromJobs(jobs, configuration) {
  const key = profile(configuration.type, configuration.request);
  const samples = jobs
    .filter(
      (job) =>
        job.status === 'completed' &&
        job.type === configuration.type &&
        profile(job.type, job.request) === key &&
        job.startedAt &&
        job.finishedAt,
    )
    .map((job) => (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0)
    .sort((a, b) => a - b);
  if (!samples.length) {
    return {
      available: false,
      sampleCount: 0,
      note: 'No completed renders with these settings yet.',
    };
  }
  const at = (fraction) => Math.round(samples[Math.floor((samples.length - 1) * fraction)]);
  return {
    available: true,
    sampleCount: samples.length,
    typicalSeconds: at(0.5),
    lowSeconds: at(0.25),
    highSeconds: at(0.75),
    confidence: samples.length >= 3 ? 'calibrated' : 'limited',
    note: 'Measured from engine acceptance to project save; engine queue time is included. Actual times vary.',
  };
}

export class JobQueue {
  constructor({
    directory = runtimeDir,
    projects = projectsRoot,
    leaseMs = 20000,
    intervalMs = 5000,
    autoStart = true,
    prepareMusic = null,
    prepareSound = null,
    prepareTts = null,
    prepareHunyuan = null,
    prepareHunyuanRender = null,
    prepareTrellis = null,
    prepareTrellisRender = null,
    prepareSam31 = null,
    prepareSam31Render = null,
    prepareHyMotion = null,
    prepareHyMotionRender = null,
    prepareMotionBricks = null,
    prepareMotionBricksRender = null,
    prepareService = null,
    prepareVideo = null,
    prepareImage = null,
    recoverService = null,
    autoMemory = null,
    // true or false overrides FORGE_CHAIN_UNLOAD; null reads it (default on). See chain-unload.js.
    chainUnload = null,
    // Re-reads GPU memory after a chained render freed a model so the next admission sees it.
    refreshHardware = null,
    onModelLoadBarrier = null,
    onQueueLog = null,
    // Finds where a finished output lives now (it may have been renamed); tests can replace it.
    resolveOutputs = null,
  } = {}) {
    this.resolveOutputs = resolveOutputs;
    this.projects = projects;
    this.leaseMs = leaseMs;
    this.autoStart = autoStart;
    this.prepareMusic = prepareMusic;
    this.prepareSound = prepareSound;
    this.prepareTts = prepareTts;
    this.prepareHunyuan = prepareHunyuan;
    this.prepareHunyuanRender = prepareHunyuanRender;
    this.prepareTrellis = prepareTrellis;
    this.prepareTrellisRender = prepareTrellisRender;
    this.prepareSam31 = prepareSam31;
    this.prepareSam31Render = prepareSam31Render;
    this.prepareHyMotion = prepareHyMotion;
    this.prepareHyMotionRender = prepareHyMotionRender;
    this.prepareMotionBricks = prepareMotionBricks;
    this.prepareMotionBricksRender = prepareMotionBricksRender;
    this.prepareService = prepareService;
    this.prepareVideo = prepareVideo;
    this.prepareImage = prepareImage;
    this.recoverService = recoverService;
    this.autoMemory = autoMemory;
    this.chainUnload = chainUnload;
    this.refreshHardware = refreshHardware;
    // Chained renders that already had their one chance to free the earlier model (this process).
    this.chainUnloadAttempted = new Set();
    this.onModelLoadBarrier = onModelLoadBarrier;
    this.onQueueLog = onQueueLog;
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(path.join(directory, 'jobs.sqlite'));
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, stage TEXT, error TEXT, output TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_owner (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL); INSERT OR IGNORE INTO runtime_owner(id,owner,expires) VALUES(1,'',0); CREATE TABLE IF NOT EXISTS model_loads (id TEXT PRIMARY KEY, state TEXT NOT NULL); INSERT OR IGNORE INTO model_loads(id,state) VALUES('music','idle'); INSERT OR IGNORE INTO model_loads(id,state) VALUES('sfx','idle'); INSERT OR IGNORE INTO model_loads(id,state) VALUES('tts','idle'); INSERT OR IGNORE INTO model_loads(id,state) VALUES('asr','idle');`,
    );
    const columns = this.db
      .prepare('PRAGMA table_info(jobs)')
      .all()
      .map((column) => column.name);
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('3d-hunyuan','idle')");
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('3d-trellis','idle')");
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('segmentation','idle')");
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('motion-hy','idle')");
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('motion-bricks','idle')");
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('game','idle')");
    this.db.exec("INSERT OR IGNORE INTO model_loads(id,state) VALUES('chat','idle')");
    // depends_on: the earlier render this one takes its reference from. Older rows leave it empty.
    for (const column of ['started_at', 'finished_at', 'details', 'depends_on']) {
      if (!columns.includes(column)) {
        try {
          this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
        } catch (error) {
          if (
            !this.db
              .prepare('PRAGMA table_info(jobs)')
              .all()
              .some((item) => item.name === column)
          ) {
            throw error;
          }
        }
      }
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status,created_at); CREATE INDEX IF NOT EXISTS jobs_history_lookup ON jobs(type,status,updated_at); CREATE INDEX IF NOT EXISTS jobs_depends_on ON jobs(depends_on);',
    );
    // queue_rank: the explicit place of a job in the line (see queue-order.js). Rows written
    // before this column existed keep NULL and sort by insertion order, as they always did.
    if (!columns.includes('queue_rank')) {
      try {
        this.db.exec('ALTER TABLE jobs ADD COLUMN queue_rank REAL');
      } catch (error) {
        if (
          !this.db
            .prepare('PRAGMA table_info(jobs)')
            .all()
            .some((item) => item.name === 'queue_rank')
        ) {
          throw error;
        }
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_queue_rank ON jobs(queue_rank)');
    const ownerColumns = this.db
      .prepare('PRAGMA table_info(runtime_owner)')
      .all()
      .map((column) => column.name);
    if (!ownerColumns.includes('epoch')) {
      try {
        this.db.exec('ALTER TABLE runtime_owner ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0');
      } catch (error) {
        if (
          !this.db
            .prepare('PRAGMA table_info(runtime_owner)')
            .all()
            .some((item) => item.name === 'epoch')
        ) {
          throw error;
        }
      }
    }
    this.owner = randomUUID();
    this.epoch = null;
    this.hasLease = false;
    this.active = null;
    this.polling = false;
    this.stopped = false;
    this.suspendedEngines = new Set();
    this.memoryRetryAt = new Map();
    this.refreshModelLoad();
    if (autoStart) {
      this.timer = setInterval(() => {
        if (this.polling || this.modelLoadInProgress) {
          try {
            this.lease();
          } catch (error) {
            console.error('Queue lease renewal:', error.message);
          }
        } else {
          this.tick();
        }
      }, intervalMs);
      this.timer.unref();
      setImmediate(() => {
        if (this.modelLoadInProgress) {
          try {
            this.lease();
          } catch (error) {
            console.error('Queue lease recovery:', error.message);
          }
        } else {
          this.tick();
        }
      });
    }
  }
  list() {
    return this.db
      .prepare(
        `SELECT * FROM jobs ORDER BY CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN 0 ELSE 1 END, CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN COALESCE(queue_rank,rowid) END ASC, CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN created_at END ASC, CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN rowid END ASC, created_at DESC, rowid DESC LIMIT 200`,
      )
      .all()
      .map(publicJob);
  }
  get(id) {
    return publicJob(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));
  }
  logLifecycle(event, job, status = job?.status) {
    if (typeof this.onQueueLog !== 'function') {
      return;
    }
    const eventCodes = new Set([
      'enqueued',
      'cancelled',
      'retry_queued',
      'retry_recheck',
      'resolved',
      'accepted',
      'completed',
      'failed',
      'interrupted',
      'uncertain_recovery',
      'remote_recheck',
      'status_transition',
    ]);
    const types = new Set([
      'music',
      'sfx',
      'images',
      'video',
      'voices',
      '3d',
      'trellis',
      'segmentation',
      'motion',
      'motion-bricks',
      'world',
      'vegetation',
    ]);
    const statuses = new Set([
      'queued',
      'waiting_engine',
      'waiting_memory',
      'preparing',
      'needs_attention',
      'submitting',
      'running',
      'finalizing',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ]);
    if (!eventCodes.has(event) || !types.has(job?.type) || !statuses.has(status)) {
      return;
    }
    const record = { event, type: job.type, status };
    if (typeof job.id === 'string' && /^[a-f0-9-]{36}$/i.test(job.id)) {
      record.jobId = job.id;
    }
    try {
      this.onQueueLog(record);
    } catch {
      // Queue logging must never alter durable queue behavior.
    }
  }
  lifecycleEvent(status) {
    return (
      {
        completed: 'completed',
        failed: 'failed',
        interrupted: 'interrupted',
      }[status] || 'status_transition'
    );
  }
  estimate(input) {
    const value = validate(input, this.projects);
    return estimateFromJobs(
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE type=? AND status='completed' ORDER BY updated_at DESC LIMIT 100",
        )
        .all(value.type)
        .map(publicJob),
      value,
    );
  }
  insertJob(value, id, now, dependsOn = null) {
    this.db
      .prepare(
        `INSERT INTO jobs(id,type,project_id,request,status,stage,created_at,updated_at,depends_on,queue_rank) VALUES(?,?,?,?,?,?,?,?,?,${NEXT_RANK_SQL})`,
      )
      .run(
        id,
        value.type,
        value.projectId,
        JSON.stringify(value.request),
        'queued',
        dependsOn ? CHAIN_WAITING_STAGE : null,
        now,
        now,
        dependsOn,
      );
    this.logLifecycle('enqueued', { id, type: value.type, status: 'queued' });
  }
  // Rules for taking a reference from another render. `parent` only needs type, status,
  // projectId and request, so a chain can be checked before any of its rows exist.
  assertChainParent(value, parent) {
    if (!parent) {
      throw Error('The render to take the reference from was not found.');
    }
    if (parent.projectId !== value.projectId) {
      throw Error('A render can only take its reference from a render in the same project.');
    }
    if (!CHAIN_PARENT_TYPES.includes(parent.type)) {
      throw Error('Only an image or a cutout render can supply a reference.');
    }
    if (
      parent.type === 'segmentation' &&
      !['transparent', 'cropped'].includes(parent.request?.output)
    ) {
      throw Error(
        'Only a transparent cutout (or a cropped one) can be used as a reference, not a mask or an outline.',
      );
    }
    if (['failed', 'cancelled'].includes(parent.status)) {
      throw Error(`The render to take the reference from has already ${parent.status}.`);
    }
  }
  // Extend and re-synthesize requests name a project music asset. The completed render that
  // produced it supplies the YuE2 job whose saved song tokens the engine continues from.
  resolveDerived(value) {
    if (value.type !== 'music' || !value.request.operation) {
      return value;
    }
    return resolveDerivedMusic(value, {
      projectFolder: findProject(value.projectId, this.projects),
      lookup: (jobId) => this.get(jobId),
    });
  }
  enqueue(input) {
    // Forge fills in the output when the earlier render finishes; a client cannot pre-set it.
    if (input?.request?.referenceFrom?.output !== undefined) {
      throw Error('referenceFrom.output is set by Forge when the earlier render finishes.');
    }
    const value = this.resolveDerived(validate(input, this.projects)),
      id = randomUUID(),
      now = new Date().toISOString(),
      parentId = value.request.referenceFrom?.jobId || null;
    if (parentId) {
      this.assertChainParent(value, this.get(parentId));
    }
    this.insertJob(value, id, now, parentId);
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return this.get(id);
  }
  // Queues 2 to 4 renders at once, where each later step takes its reference from an earlier one
  // (request.referenceFrom = { step: index }). All steps are validated first and inserted in one
  // transaction, so a rejected step never leaves an earlier one behind.
  enqueueChain(steps) {
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 4) {
      throw Error('A chain needs 2 to 4 renders.');
    }
    const ids = steps.map(() => randomUUID());
    const values = steps.map((step, index) => {
      const from = step?.request?.referenceFrom;
      if (index === 0 && from !== undefined) {
        throw Error('The first render in a chain cannot depend on another render.');
      }
      if (index === 0) {
        return validate(step, this.projects);
      }
      if (
        !from ||
        typeof from !== 'object' ||
        !Number.isInteger(from.step) ||
        from.step < 0 ||
        from.step >= index ||
        Object.keys(from).some((key) => key !== 'step')
      ) {
        throw Error('Each later render in a chain must take its reference from an earlier step.');
      }
      const request = { ...step.request, referenceFrom: { jobId: ids[from.step] } };
      return validate({ ...step, request }, this.projects);
    });
    values.forEach((value, index) => {
      const parentIndex = steps[index]?.request?.referenceFrom?.step;
      if (parentIndex !== undefined) {
        const parent = values[parentIndex];
        this.assertChainParent(value, { ...parent, status: 'queued' });
      }
    });
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      values.forEach((value, index) => {
        this.insertJob(value, ids[index], now, value.request.referenceFrom?.jobId || null);
      });
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Could not roll back chain enqueue:', rollbackError.message);
      }
      throw error;
    }
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return ids.map((id) => this.get(id));
  }
  // Renders still waiting on a reference from `parentId`. Renders that already have their
  // reference (resolved) are independent and are left alone.
  pendingDependents(parentId, statuses) {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE depends_on=? AND remote_id IS NULL AND status IN (${statuses.map(() => '?').join(',')})`,
      )
      .all(parentId, ...statuses)
      .map(publicJob)
      .filter((job) => isPendingChain(job.request));
  }
  // Cancelling (or resolving to cancelled) a render also cancels the renders still waiting for
  // its output, because their input will never exist. Renders that already have it keep going.
  cancelDependents(parentId) {
    const changes = {
      stage: 'Cancelled because the render it depends on was cancelled.',
      at: new Date().toISOString(),
    };
    for (const child of this.pendingDependents(parentId, [
      ...WAITING_STATUSES,
      'needs_attention',
    ])) {
      const result = this.db
        .prepare(
          "UPDATE jobs SET status='cancelled',stage=?,updated_at=? WHERE id=? AND remote_id IS NULL AND status IN ('queued','waiting_engine','waiting_memory','needs_attention')",
        )
        .run(changes.stage, changes.at, child.id);
      if (result.changes) {
        this.memoryRetryAt.delete(child.id);
        this.logLifecycle('cancelled', this.get(child.id));
        this.cancelDependents(child.id);
      }
    }
  }
  // Retrying a failed render also requeues the renders that failed only because it failed.
  requeueDependents(parentId) {
    const now = new Date().toISOString();
    for (const child of this.pendingDependents(parentId, ['failed'])) {
      if (child.stage !== DEPENDENCY_FAILED_STAGE) {
        continue;
      }
      this.db
        .prepare(
          "UPDATE jobs SET status='queued',stage=?,error=NULL,updated_at=? WHERE id=? AND status='failed' AND remote_id IS NULL",
        )
        .run(CHAIN_WAITING_STAGE, now, child.id);
      this.logLifecycle('retry_queued', this.get(child.id));
      this.requeueDependents(child.id);
    }
  }
  cancel(id) {
    if (this.cancelRunningVegetation(id)) {
      return this.get(id);
    }
    const result = this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',stage='Cancelled.',updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory','needs_attention') AND remote_id IS NULL",
      )
      .run(new Date().toISOString(), id);
    if (!result.changes) {
      throw Error('Only queued jobs can be cancelled here.');
    }
    this.memoryRetryAt.delete(id);
    this.logLifecycle('cancelled', this.get(id));
    this.cancelDependents(id);
    return this.get(id);
  }
  clearWaiting(confirmation) {
    if (confirmation !== 'cancel-waiting-renders') {
      throw Error('Confirm cancellation of waiting renders.');
    }
    // One SQL statement fences the selection against a job starting meanwhile.
    // Jobs with a remote ID or an uncertain state are never bulk-cancelled.
    const rows = this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',stage='Cancelled when clearing waiting renders.',updated_at=? WHERE status IN ('queued','waiting_engine','waiting_memory') AND remote_id IS NULL RETURNING id",
      )
      .all(new Date().toISOString());
    for (const row of rows) {
      this.memoryRetryAt.delete(row.id);
      this.logLifecycle('cancelled', this.get(row.id));
    }
    return { cancelled: rows.length };
  }
  retry(id) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        // SQLite evaluates every SET expression against the row as it was before the update, so
        // the known-failure test below sees the old remote_id even though remote_id is cleared.
        `UPDATE jobs SET status=CASE WHEN remote_id IS NULL OR ${KNOWN_ENGINE_FAILURE_SQL} THEN 'queued' ELSE 'running' END,stage=CASE WHEN remote_id IS NULL OR ${KNOWN_ENGINE_FAILURE_SQL} THEN 'Queued for retry.' ELSE 'Rechecking the existing engine job.' END,remote_id=CASE WHEN ${KNOWN_ENGINE_FAILURE_SQL} THEN NULL ELSE remote_id END,error=NULL,details=NULL,finished_at=NULL,started_at=CASE WHEN remote_id IS NULL OR ${KNOWN_ENGINE_FAILURE_SQL} THEN NULL ELSE started_at END,updated_at=? WHERE id=? AND status IN ('failed','needs_attention','waiting_memory')`,
      )
      .run(now, id);
    if (!result.changes) {
      throw Error('Only failed or waiting jobs can be retried.');
    }
    this.memoryRetryAt.delete(id);
    this.chainUnloadAttempted.delete(id);
    const retried = this.get(id);
    this.logLifecycle(retried.remoteId ? 'retry_recheck' : 'retry_queued', retried);
    this.requeueDependents(id);
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return this.get(id);
  }
  resolve(id, confirmed) {
    if (confirmed !== true) {
      throw Error('Confirm that the remote engine job is no longer running.');
    }
    const result = this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',stage=?,updated_at=? WHERE id=? AND status='interrupted'",
      )
      .run('Resolved after checking the remote engine.', new Date().toISOString(), id);
    if (!result.changes) {
      throw Error('Only interrupted jobs can be resolved.');
    }
    this.logLifecycle('resolved', this.get(id));
    this.cancelDependents(id);
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return this.get(id);
  }
  suspend(id, allowQueueCheck = false) {
    if (!this.lease()) {
      throw Error(
        'Another runtime owns the render queue, or a previous runtime lease has not expired yet. Retry shortly.',
      );
    }
    if (this.suspendedEngines.has(id)) {
      throw Error('An operation on this engine is already in progress.');
    }
    if (this.modelLoadInProgress) {
      throw Error('Wait for the current model load before stopping an engine.');
    }
    if (this.polling && !allowQueueCheck) {
      throw Error('Wait for the current queue check before stopping an engine.');
    }
    if (this.active && engineId(this.get(this.active.id)?.type) === id) {
      throw Error('Forge has an active render on this engine.');
    }
    this.suspendedEngines.add(id);
  }
  resume(id) {
    this.suspendedEngines.delete(id);
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
  }
  beginForceStop(id) {
    if (!this.lease()) {
      throw Error('Another runtime owns the queue. Retry shortly.');
    }
    if (this.suspendedEngines.has(id)) {
      throw Error('An operation on this engine is already in progress.');
    }
    this.suspendedEngines.add(id);
    try {
      const current = this.active
        ? this.get(this.active.id)
        : publicJob(
            this.db
              .prepare(
                "SELECT * FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') ORDER BY COALESCE(queue_rank,rowid),created_at,rowid LIMIT 1",
              )
              .get(),
          );
      if (
        current &&
        engineId(current.type) === id &&
        current.status === 'interrupted' &&
        current.stage === 'Engine force-stop requires review.'
      ) {
        return { jobId: current.id };
      }
      if (
        !current ||
        engineId(current.type) !== id ||
        ![
          'queued',
          'waiting_engine',
          'waiting_memory',
          'preparing',
          'submitting',
          'running',
          'finalizing',
        ].includes(current.status)
      ) {
        return { jobId: null };
      }
      const changed = this.db
        .prepare(
          "UPDATE jobs SET status='interrupted',stage=?,error=?,updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory','preparing','submitting','running','finalizing') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
        )
        .run(
          'Engine force-stop requires review.',
          'The engine was force-stopped or its stop result is uncertain. Check for partial output and resolve this job before continuing.',
          new Date().toISOString(),
          current.id,
          this.owner,
          this.epoch,
          Date.now(),
        );
      if (!changed.changes) {
        throw Error('Could not fence the active render.');
      }
      this.logLifecycle('interrupted', this.get(current.id));
      if (this.active?.id === current.id) {
        this.active.forced = true;
        this.active.child.kill();
      }
      return { jobId: current.id };
    } catch (error) {
      this.suspendedEngines.delete(id);
      throw error;
    }
  }
  refreshModelLoad() {
    const active = this.db
      .prepare("SELECT id,state FROM model_loads WHERE state!='idle' ORDER BY id LIMIT 1")
      .get();
    this.modelLoadEngine = active?.id || null;
    this.modelLoadState = active?.state || 'idle';
    this.modelLoadInProgress = !!active;
  }
  suspendForModelLoad(engine = 'music') {
    if (
      ![
        'music',
        'sfx',
        'tts',
        'asr',
        '3d-hunyuan',
        '3d-trellis',
        'segmentation',
        'motion-hy',
        'motion-bricks',
        'game',
        'chat',
      ].includes(engine)
    ) {
      throw Error('Unsupported model load.');
    }
    if (!this.lease()) {
      throw Error(
        'Another runtime owns the render queue, or a previous runtime lease has not expired yet. Retry shortly.',
      );
    }
    if (this.modelLoadInProgress || this.active || this.polling || this.suspendedEngines.size) {
      throw Error('Wait for the active render or queue check before loading another model.');
    }
    const result = this.db
      .prepare(
        "UPDATE model_loads SET state='checking' WHERE id=? AND state='idle' AND NOT EXISTS (SELECT 1 FROM model_loads WHERE state!='idle') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
      )
      .run(engine, this.owner, this.epoch, Date.now());
    if (!result.changes) {
      throw Error('Could not reserve the queue for model loading.');
    }
    this.modelLoadEngine = engine;
    this.modelLoadState = 'checking';
    this.modelLoadInProgress = true;
  }
  claimQueuedModelLoad(id, token, engine = 'music') {
    if (
      ![
        'music',
        'sfx',
        'tts',
        '3d-hunyuan',
        '3d-trellis',
        'segmentation',
        'motion-hy',
        'motion-bricks',
      ].includes(engine)
    ) {
      throw Error('Unsupported model load.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.db
        .prepare(
          "UPDATE jobs SET status='preparing',stage=?,error=NULL,details=NULL,updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?) AND NOT EXISTS (SELECT 1 FROM model_loads WHERE state!='idle') AND EXISTS (SELECT 1 FROM model_loads WHERE id=? AND state='idle')",
        )
        .run(
          `Checking GPU memory and preparing ${engineName(engine)}.`,
          new Date().toISOString(),
          id,
          token.owner,
          token.epoch,
          Date.now(),
          engine,
        );
      if (!job.changes) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare("UPDATE model_loads SET state='checking' WHERE id=? AND state='idle'")
        .run(engine);
      this.db.exec('COMMIT');
      this.modelLoadEngine = engine;
      this.modelLoadState = 'checking';
      this.modelLoadInProgress = true;
      this.logLifecycle('status_transition', this.get(id));
      return true;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Could not roll back model-load transaction:', rollbackError.message);
      }
      throw error;
    }
  }
  markModelLoadRequested(engine = 'music') {
    const result = this.db
      .prepare(
        "UPDATE model_loads SET state='loading' WHERE id=? AND state='checking' AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
      )
      .run(engine, this.owner, this.epoch, Date.now());
    if (!result.changes) {
      return false;
    }
    this.modelLoadState = 'loading';
    return true;
  }
  resumeAfterModelLoad(engine = 'music') {
    if (this.stopped || !this.lease()) {
      return false;
    }
    const result = this.db
      .prepare(
        "UPDATE model_loads SET state='idle' WHERE id=? AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
      )
      .run(engine, this.owner, this.epoch, Date.now());
    if (!result.changes) {
      return false;
    }
    this.refreshModelLoad();
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return true;
  }
  update(
    id,
    values,
    token = { owner: this.owner, epoch: this.epoch },
    event = this.lifecycleEvent(values.status),
  ) {
    const allowed = [
      'status',
      'remote_id',
      'stage',
      'error',
      'details',
      'output',
      'started_at',
      'finished_at',
    ];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    if (!entries.length) {
      return false;
    }
    const previousStatus = values.status
      ? this.db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status
      : null;
    const result = this.db
      .prepare(
        `UPDATE jobs SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)`,
      )
      .run(
        ...entries.map(([, value]) => value),
        new Date().toISOString(),
        id,
        token.owner,
        token.epoch,
        Date.now(),
      );
    if (result.changes && values.status && values.status !== previousStatus) {
      this.logLifecycle(event, this.get(id), values.status);
    }
    return !!result.changes;
  }
  updatePending(id, values, token) {
    const entries = Object.entries(values).filter(([key]) =>
      ['status', 'stage', 'error', 'details'].includes(key),
    );
    if (!entries.length) {
      return false;
    }
    const previousStatus = values.status
      ? this.db.prepare('SELECT status FROM jobs WHERE id=?').get(id)?.status
      : null;
    const result = this.db
      .prepare(
        `UPDATE jobs SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory','preparing') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)`,
      )
      .run(
        ...entries.map(([, value]) => value),
        new Date().toISOString(),
        id,
        token.owner,
        token.epoch,
        Date.now(),
      );
    if (result.changes && values.status && values.status !== previousStatus) {
      this.logLifecycle(this.lifecycleEvent(values.status), this.get(id), values.status);
    }
    return !!result.changes;
  }
  canManageMemory(job, preparation) {
    return (
      !!this.autoMemory &&
      preparation?.status === 'waiting_memory' &&
      preparation.details?.code === 'insufficient_gpu_memory' &&
      (this.memoryRetryAt.get(job.id) || 0) <= Date.now()
    );
  }
  async manageMemory(job, preparation, token) {
    if (!this.canManageMemory(job, preparation)) {
      return;
    }
    const details = preparation.details;
    const isCurrent = () =>
      !this.stopped &&
      !this.active &&
      !this.modelLoadInProgress &&
      !!this.db
        .prepare('SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?')
        .get(token.owner, token.epoch, Date.now()) &&
      this.db
        .prepare(
          "SELECT id,status FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','running','finalizing','interrupted') ORDER BY COALESCE(queue_rank,rowid),created_at,rowid LIMIT 1",
        )
        .get()?.id === job.id &&
      this.get(job.id)?.status === 'waiting_memory';
    const upcoming = this.db
      .prepare(
        "SELECT type FROM jobs WHERE id!=? AND status IN ('queued','waiting_engine','waiting_memory') ORDER BY COALESCE(queue_rank,rowid),created_at,rowid",
      )
      .all(job.id)
      .map((item) => engineId(item.type));
    let result;
    try {
      result = await this.autoMemory({
        target: engineId(job.type),
        upcoming,
        isCurrent,
        reserve: (id) => this.suspend(id, true),
        release: (id) => this.resume(id),
        announce: (service) =>
          this.updatePending(
            job.id,
            {
              stage: `Making room: stopping idle ${service.name}.`,
              details: JSON.stringify({ ...details, autoManaging: true }),
            },
            token,
          ),
      });
    } catch (error) {
      result = { status: 'failed', error: error.message };
    }
    if (!isCurrent()) {
      return;
    }
    if (result.status === 'stopped') {
      this.memoryRetryAt.delete(job.id);
      this.updatePending(
        job.id,
        {
          status: 'waiting_engine',
          stage: `Stopped idle ${result.service.name}; checking memory again.`,
          error: null,
          details: null,
        },
        token,
      );
    } else {
      this.memoryRetryAt.set(job.id, Date.now() + 30000);
      this.updatePending(
        job.id,
        {
          status: 'waiting_memory',
          stage:
            result.status === 'failed'
              ? `Waiting for GPU memory. ${result.error}`
              : preparation.stage,
          error: null,
          details: JSON.stringify(details),
        },
        token,
      );
    }
  }
  // Moves one waiting render within the waiting line (see queue-order.js). Only its rank changes,
  // so a render that is already claimed or running is untouched and the new order applies to the
  // next claim.
  move(id, input) {
    const result = moveQueuedJob(this.db, id, parseMoveRequest(input));
    const job = this.get(id);
    if (result.moved) {
      this.logMove(job, result);
    }
    return { ...result, job };
  }
  logMove(job, result) {
    if (typeof this.onQueueLog !== 'function') {
      return;
    }
    try {
      this.onQueueLog({
        event: 'queue_move',
        type: job.type,
        status: job.status,
        jobId: job.id,
        position: result.to,
        count: result.count,
      });
    } catch {
      // Queue logging must never alter durable queue behavior.
    }
  }
  logChainUnload(job, parent, outcome) {
    if (typeof this.onQueueLog !== 'function') {
      return;
    }
    try {
      this.onQueueLog({
        event: 'chain_unload',
        type: job.type,
        parentType: parent.type,
        outcome,
        jobId: job.id,
      });
    } catch {
      // Queue logging must never alter durable queue behavior.
    }
  }
  // A chained render is about to start: free the model of the render it took its input from
  // (Qwen Image or SAM 3.1) so the two models are not resident together. This goes through the
  // same guarded offload as "make room" (Forge-owned, loaded, idle, reserved while it stops), and
  // only when no other open job needs that engine. It is best effort: a refusal or a failure is
  // reported in the stage and never fails the job. Returns false when the job is no longer the
  // one to start (cancelled, lease lost) so the tick ends. Runs once per job and process.
  async freeChainParent(job, token) {
    if (!this.autoMemory || this.chainUnloadAttempted.has(job.id)) {
      return true;
    }
    const parent = this.get(job.dependsOn);
    if (!parent || parent.status !== 'completed') {
      return true;
    }
    const upcoming = this.db
      .prepare(
        `SELECT type FROM jobs WHERE id!=? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY COALESCE(queue_rank,rowid),created_at,rowid`,
      )
      .all(job.id, ...OPEN_STATUSES)
      .map((item) => engineId(item.type));
    const plan = planChainUnload({
      parentType: parent.type,
      childEngine: engineId(job.type),
      upcomingEngines: upcoming,
      enabled: typeof this.chainUnload === 'boolean' ? this.chainUnload : undefined,
    });
    this.chainUnloadAttempted.add(job.id);
    if (!plan.engine) {
      this.logChainUnload(job, parent, `skipped_${plan.skip}`);
      return true;
    }
    const isCurrent = () =>
      !this.stopped &&
      !this.active &&
      !this.modelLoadInProgress &&
      !!this.db
        .prepare('SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?')
        .get(token.owner, token.epoch, Date.now()) &&
      this.db
        .prepare(
          "SELECT id FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','running','finalizing','interrupted') ORDER BY COALESCE(queue_rank,rowid),created_at,rowid LIMIT 1",
        )
        .get()?.id === job.id &&
      WAITING_STATUSES.includes(this.get(job.id)?.status);
    const name = engineName(parent.type);
    let result;
    try {
      result = await this.autoMemory({
        target: engineId(job.type),
        only: plan.engine,
        upcoming,
        isCurrent,
        reserve: (id) => this.suspend(id, true),
        release: (id) => this.resume(id),
        announce: () =>
          this.updatePending(
            job.id,
            { stage: `Freeing memory from the finished ${name} render...` },
            token,
          ),
      });
    } catch (error) {
      result = { status: 'failed', error: error.message };
    }
    this.logChainUnload(job, parent, result.status);
    if (result.status === 'stopped') {
      try {
        await this.refreshHardware?.();
      } catch (error) {
        console.error('Could not re-read GPU memory after freeing a model:', error.message);
      }
      this.updatePending(
        job.id,
        { stage: `Freed memory from the finished ${name} render.` },
        token,
      );
    } else if (result.status === 'failed') {
      const warning = `Could not free memory from the finished ${name} render; continuing.`;
      this.updatePending(job.id, { stage: `${warning} ${result.error || ''}`.trim() }, token);
    }
    return isCurrent();
  }
  lease() {
    const now = Date.now();
    let claimed, changed;
    let uncertainRows = [];
    let recheckRows = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      claimed = this.db
        .prepare(
          'UPDATE runtime_owner SET owner=?,expires=?,epoch=CASE WHEN owner=? AND expires>? THEN epoch ELSE epoch+1 END WHERE id=1 AND ((owner=? AND expires>?) OR expires<=?) RETURNING epoch',
        )
        .get(this.owner, now + this.leaseMs, this.owner, now, this.owner, now, now);
      changed = !!claimed && (!this.hasLease || claimed.epoch !== this.epoch);
      if (changed) {
        uncertainRows = this.db
          .prepare(
            "UPDATE jobs SET status='interrupted',error=?,updated_at=? WHERE status='submitting' RETURNING id,type",
          )
          .all(
            'Submission may have reached the engine before the runtime stopped. Check the engine before resolving this job.',
            new Date().toISOString(),
          );
        recheckRows = this.db
          .prepare(
            "UPDATE jobs SET status='waiting_engine',stage=?,updated_at=? WHERE status='preparing' RETURNING id,type",
          )
          .all('Rechecking the engine after a runtime restart.', new Date().toISOString());
        this.db.prepare("UPDATE model_loads SET state='loading' WHERE state='checking'").run();
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Could not roll back queue lease transaction:', rollbackError.message);
      }
      throw error;
    }
    for (const row of uncertainRows) {
      this.logLifecycle('uncertain_recovery', { ...row, status: 'interrupted' });
    }
    for (const row of recheckRows) {
      this.logLifecycle('remote_recheck', { ...row, status: 'waiting_engine' });
    }
    if (!claimed) {
      if (this.hasLease) {
        this.active?.child.kill();
      }
      this.hasLease = false;
      this.epoch = null;
      return false;
    }
    if (changed && this.active) {
      this.active.child.kill();
    }
    this.hasLease = true;
    this.epoch = claimed.epoch;
    this.refreshModelLoad();
    if (this.modelLoadState === 'loading' && this.onModelLoadBarrier) {
      const engine = this.modelLoadEngine;
      setImmediate(() => {
        if (!this.stopped && this.modelLoadState === 'loading' && this.modelLoadEngine === engine) {
          this.onModelLoadBarrier(engine);
        }
      });
    }
    return true;
  }
  endChainedJob(job, token, status, stage, error = null) {
    this.update(
      job.id,
      { status, stage, error },
      token,
      status === 'cancelled' ? 'cancelled' : undefined,
    );
    if (status === 'cancelled') {
      this.cancelDependents(job.id);
    }
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return null;
  }
  async currentOutput(parent) {
    try {
      const resolver =
        this.resolveOutputs || (await import('./asset-output.js')).resolveAssetOutputs;
      const [resolved] = await resolver([parent], { root: this.projects });
      return resolved?.output || parent.output;
    } catch {
      // A renamed file is only an optimisation; the original path is the durable record.
      return parent.output;
    }
  }
  // Called for the job at the head of the queue that still waits for its reference. Returns the
  // job with the reference staged when it can run now. Returns null after failing or cancelling
  // it, or while the earlier render is still open (the next tick checks again).
  async resolveChainReference(job, token) {
    const parent = this.get(job.dependsOn);
    const label = parent?.type === 'segmentation' ? 'cutout' : 'image';
    if (!parent) {
      return this.endChainedJob(
        job,
        token,
        'failed',
        DEPENDENCY_FAILED_STAGE,
        'The render this one depends on is no longer in the queue history.',
      );
    }
    if (OPEN_STATUSES.includes(parent.status)) {
      if (job.stage !== CHAIN_WAITING_STAGE) {
        this.updatePending(job.id, { stage: CHAIN_WAITING_STAGE }, token);
      }
      return null;
    }
    if (parent.status === 'cancelled') {
      return this.endChainedJob(
        job,
        token,
        'cancelled',
        'Cancelled because the render it depends on was cancelled.',
      );
    }
    if (parent.status === 'failed') {
      return this.endChainedJob(
        job,
        token,
        'failed',
        DEPENDENCY_FAILED_STAGE,
        `The ${label} this render depends on failed${parent.error ? `: ${parent.error}` : '.'} ` +
          'Retry that render and this one is queued again.',
      );
    }
    const output = parent.status === 'completed' ? await this.currentOutput(parent) : null;
    if (!output) {
      return this.endChainedJob(
        job,
        token,
        'failed',
        DEPENDENCY_FAILED_STAGE,
        `The ${label} this render depends on did not save a file.`,
      );
    }
    let staged;
    try {
      staged = await stageProjectAsset(findProject(job.projectId, this.projects), output);
      if (job.type === 'trellis' && !/\.(png|webp)$/i.test(staged.id)) {
        throw Error('TRELLIS.2 needs a transparent PNG or WebP.');
      }
    } catch (error) {
      return this.endChainedJob(
        job,
        token,
        'failed',
        DEPENDENCY_FAILED_STAGE,
        `Could not use the finished ${label} (${output}) as the reference: ${error.message}`,
      );
    }
    const request = {
      ...job.request,
      references: [...(job.request.references || []), staged.id],
      referenceFrom: { jobId: parent.id, output },
    };
    const changed = this.db
      .prepare(
        "UPDATE jobs SET request=?,stage=?,error=NULL,updated_at=? WHERE id=? AND remote_id IS NULL AND status IN ('queued','waiting_engine','waiting_memory') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
      )
      .run(
        JSON.stringify(request),
        `Using the finished ${label} as the reference.`,
        new Date().toISOString(),
        job.id,
        token.owner,
        token.epoch,
        Date.now(),
      );
    return changed.changes ? this.get(job.id) : null;
  }
  async tick() {
    if (this.stopped || this.polling || this.modelLoadInProgress) {
      return;
    }
    this.polling = true;
    try {
      if (!this.lease() || this.active || this.modelLoadInProgress) {
        return;
      }
      const token = { owner: this.owner, epoch: this.epoch };
      let job = publicJob(
        this.db
          .prepare(
            "SELECT * FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','running','finalizing','interrupted') ORDER BY COALESCE(queue_rank,rowid),created_at,rowid LIMIT 1",
          )
          .get(),
      );
      if (
        !job ||
        ['interrupted', 'needs_attention', 'preparing'].includes(job.status) ||
        this.suspendedEngines.has(engineId(job.type))
      ) {
        return;
      }
      // A render that takes its reference from an earlier render starts only once that render
      // has finished and its output is staged. Parents are older, so they normally run first.
      if (!job.remoteId && job.dependsOn && isPendingChain(job.request)) {
        job = await this.resolveChainReference(job, token);
        if (!job) {
          return;
        }
      }
      // The earlier model is no longer needed once its output is staged; free it before this
      // render's model is admitted and loaded.
      if (!job.remoteId && job.dependsOn && !(await this.freeChainParent(job, token))) {
        return;
      }
      // Vegetation uses no engine, model or GPU memory: SeedThree runs in an isolated child
      // process. It has no remote job, so a row left running by an earlier runtime is grown again.
      if (job.type === 'vegetation') {
        this.startVegetation(job, token);
        return;
      }
      // Resume known remote jobs; new jobs wait for an already-loaded engine.
      if (!job.remoteId) {
        try {
          findProject(job.projectId, this.projects);
        } catch (error) {
          this.updatePending(
            job.id,
            { status: 'failed', stage: 'Project unavailable.', error: error.message },
            token,
          );
          return;
        }
        let ready = false,
          health = null,
          reachable = false;
        try {
          const response = await fetch(
            `${engineUrl(job.type)}${job.type === 'music' ? '/api/v1/health' : '/api/status'}`,
            { signal: AbortSignal.timeout(1500), redirect: 'error' },
          );
          health = await response.json();
          reachable =
            response.ok &&
            (job.type === 'music'
              ? health.api_version === '1' && typeof health.model?.loaded === 'boolean'
              : job.type === 'sfx'
                ? typeof health.phase === 'string' && typeof health.loaded === 'boolean'
                : job.type === 'voices'
                  ? health.engine === 'forge-qwen3-tts-v1' &&
                    typeof health.loaded === 'boolean' &&
                    typeof health.model_downloaded === 'boolean'
                  : job.type === 'trellis'
                    ? health.engine === 'forge-trellis2-512-experimental-v1' &&
                      typeof health.loaded === 'boolean' &&
                      typeof health.model_downloaded === 'boolean'
                    : job.type === '3d'
                      ? health.engine === 'forge-hunyuan-shape-v1' &&
                        typeof health.loaded === 'boolean' &&
                        typeof health.model_downloaded === 'boolean'
                      : job.type === 'segmentation'
                        ? health.engine === 'forge-sam31-image-experimental-v1' &&
                          typeof health.loaded === 'boolean' &&
                          typeof health.model_downloaded === 'boolean'
                        : job.type === 'motion-bricks'
                          ? health.engine === 'forge-motionbricks-cuda-experimental-v1' &&
                            typeof health.loaded === 'boolean' &&
                            typeof health.model_downloaded === 'boolean'
                          : job.type === 'motion'
                            ? health.engine === 'forge-hy-motion-v1' &&
                              typeof health.loaded === 'boolean' &&
                              typeof health.model_downloaded === 'boolean'
                            : job.type === 'video'
                              ? typeof health.ready === 'boolean' && Array.isArray(health.files)
                              : job.type === 'world'
                                ? health.engine === 'forge-world-v1' &&
                                  typeof health.ready === 'boolean' &&
                                  typeof health.busy === 'boolean'
                                : typeof health.status === 'string' &&
                                  typeof health.model_downloaded === 'boolean');
          ready =
            reachable &&
            (job.type === 'music'
              ? health.model.loaded === true
              : [
                    'sfx',
                    'voices',
                    '3d',
                    'trellis',
                    'segmentation',
                    'motion',
                    'motion-bricks',
                  ].includes(job.type)
                ? health.loaded === true &&
                  (job.type !== 'motion-bricks' || health.rig === 'soma') &&
                  (job.type !== 'voices' || checkpointLoadedFor(health, job.request)) &&
                  !['generating', 'loading', 'preparing'].includes(health.phase)
                : job.type === 'video'
                  ? health.ready === true && health.job?.state !== 'running'
                  : job.type === 'world'
                    ? health.ready === true && !health.busy
                    : health.model_downloaded === true &&
                      !health.busy &&
                      (health.status === 'ready' ||
                        (this.prepareImage &&
                          (health.status === 'not loaded' ||
                            (health.status === 'error' &&
                              (job.stage === 'Queued for retry.' ||
                                job.status === 'waiting_memory'))))));
        } catch {
          health = null;
          reachable = false;
        }
        if (this.stopped || this.suspendedEngines.has(engineId(job.type))) {
          return;
        }
        if (!ready) {
          const preparationFunction =
            job.type === 'music'
              ? this.prepareMusic
              : job.type === 'sfx'
                ? this.prepareSound
                : job.type === 'voices'
                  ? this.prepareTts
                  : job.type === '3d'
                    ? this.prepareHunyuan
                    : job.type === 'trellis'
                      ? this.prepareTrellis
                      : job.type === 'segmentation'
                        ? this.prepareSam31
                        : job.type === 'motion'
                          ? this.prepareHyMotion
                          : job.type === 'motion-bricks'
                            ? this.prepareMotionBricks
                            : null;
          if (preparationFunction) {
            let loadClaimed = false;
            try {
              const engine = engineId(job.type);
              const preparation = await preparationFunction({
                health,
                reachable,
                retryModel: job.stage === 'Queued for retry.' || job.status === 'waiting_memory',
                variant: job.type === 'voices' ? checkpointForRequest(job.request) : undefined,
                claimLoad: () => {
                  loadClaimed = this.claimQueuedModelLoad(job.id, token, engine);
                  return loadClaimed;
                },
              });
              if (preparation) {
                this.updatePending(
                  job.id,
                  {
                    status: preparation.status,
                    stage: preparation.stage,
                    error: preparation.error || null,
                    details: preparation.details
                      ? JSON.stringify(
                          this.canManageMemory(job, preparation)
                            ? { ...preparation.details, autoManaging: true }
                            : preparation.details,
                        )
                      : null,
                  },
                  token,
                );
              }
              if (loadClaimed) {
                if (preparation?.loadBarrier) {
                  this.markModelLoadRequested(engine);
                  this.onModelLoadBarrier?.(engine);
                } else {
                  this.resumeAfterModelLoad(engine);
                }
              }
              if (!preparation?.loadBarrier) {
                await this.manageMemory(job, preparation, token);
              }
            } catch (error) {
              this.updatePending(
                job.id,
                {
                  status: 'needs_attention',
                  stage: `Could not prepare ${engineName(job.type)}.`,
                  error: error.message,
                  details: null,
                },
                token,
              );
              if (loadClaimed) {
                const engine = engineId(job.type);
                this.markModelLoadRequested(engine);
                this.onModelLoadBarrier?.(engine);
              }
            }
          } else if (this.prepareService) {
            try {
              const preparation = await this.prepareService({ type: job.type, reachable, health });
              if (preparation) {
                this.updatePending(
                  job.id,
                  {
                    status: preparation.status,
                    stage: preparation.stage,
                    error: preparation.error || null,
                    details: null,
                  },
                  token,
                );
              }
            } catch (error) {
              this.updatePending(
                job.id,
                {
                  status: 'needs_attention',
                  stage: `Could not prepare ${engineName(job.type)}.`,
                  error: error.message,
                  details: null,
                },
                token,
              );
            }
          } else {
            this.updatePending(
              job.id,
              {
                status: 'waiting_engine',
                stage: `Waiting for ${engineName(job.type)} to be running with its model loaded.`,
                error: null,
                details: null,
              },
              token,
            );
          }
          return;
        }
        const gpuPreparation =
          job.type === 'video'
            ? this.prepareVideo && (() => this.prepareVideo(job.request))
            : job.type === 'images' && this.prepareImage
              ? () => this.prepareImage(job.request, health.status === 'ready')
              : job.type === '3d' && this.prepareHunyuanRender
                ? () => this.prepareHunyuanRender(job.request)
                : job.type === 'trellis' && this.prepareTrellisRender
                  ? () => this.prepareTrellisRender(job.request)
                  : job.type === 'segmentation'
                    ? this.prepareSam31Render
                    : job.type === 'motion' && this.prepareHyMotionRender
                      ? () => this.prepareHyMotionRender(job.request)
                      : job.type === 'motion-bricks'
                        ? this.prepareMotionBricksRender
                        : null;
        if (gpuPreparation) {
          const name = engineName(job.type);
          if (
            !this.updatePending(
              job.id,
              {
                status: 'preparing',
                stage: `Checking GPU memory for ${name}.`,
                error: null,
                details: null,
              },
              token,
            )
          ) {
            return;
          }
          try {
            const preparation = await gpuPreparation();
            if (preparation) {
              this.updatePending(
                job.id,
                {
                  status: preparation.status,
                  stage: preparation.stage,
                  error: preparation.error || null,
                  details: preparation.details
                    ? JSON.stringify(
                        this.canManageMemory(job, preparation)
                          ? { ...preparation.details, autoManaging: true }
                          : preparation.details,
                      )
                    : null,
                },
                token,
              );
              await this.manageMemory(job, preparation, token);
              return;
            }
            if (
              !this.updatePending(
                job.id,
                {
                  status: 'waiting_engine',
                  stage: 'GPU memory checked.',
                  error: null,
                  details: null,
                },
                token,
              )
            ) {
              return;
            }
          } catch (error) {
            this.updatePending(
              job.id,
              {
                status: 'needs_attention',
                stage: `Could not check GPU memory for ${name}.`,
                error: error.message,
                details: null,
              },
              token,
            );
            return;
          }
        }
        const claimed = this.db
          .prepare(
            "UPDATE jobs SET status='submitting',stage=?,error=NULL,details=NULL,updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
          )
          .run(
            `Submitting to ${engineName(job.type)}.`,
            new Date().toISOString(),
            job.id,
            token.owner,
            token.epoch,
            Date.now(),
          );
        if (!claimed.changes) {
          return;
        }
        this.logLifecycle('status_transition', this.get(job.id), 'submitting');
      } else if (this.recoverService) {
        try {
          const recovery = await this.recoverService(job.type);
          if (this.stopped || this.suspendedEngines.has(engineId(job.type))) {
            return;
          }
          if (recovery) {
            this.update(
              job.id,
              { status: recovery.status, stage: recovery.stage, error: recovery.error || null },
              token,
            );
            return;
          }
        } catch (error) {
          this.update(
            job.id,
            {
              status: 'needs_attention',
              stage: 'Could not reconnect the engine for a previous render.',
              error: error.message,
            },
            token,
          );
          return;
        }
      }
      if (this.stopped) {
        return;
      }
      if (
        !this.db
          .prepare('SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?')
          .get(token.owner, token.epoch, Date.now())
      ) {
        return;
      }
      try {
        this.launch(job, token);
      } catch (error) {
        this.update(
          job.id,
          {
            status: job.remoteId ? 'running' : 'interrupted',
            error: `Could not start worker: ${error.message}`,
          },
          token,
        );
      }
    } catch (error) {
      console.error('Job scheduler:', error.message);
    } finally {
      this.polling = false;
    }
  }
  // Starts a vegetation job: no engine health check and no memory admission, because the work is
  // CPU only and bounded by the child's own timeout and heap cap (see vegetation-runner.js).
  startVegetation(job, token) {
    try {
      findProject(job.projectId, this.projects);
    } catch (error) {
      this.update(
        job.id,
        { status: 'failed', stage: 'Project unavailable.', error: error.message },
        token,
      );
      return;
    }
    const checkout = quickCheckoutStatus();
    if (!checkout.ready) {
      this.update(
        job.id,
        {
          status: 'failed',
          stage: 'SeedThree is not ready.',
          error: checkout.message,
          finished_at: new Date().toISOString(),
        },
        token,
      );
      return;
    }
    const now = new Date().toISOString();
    const claimed = this.db
      .prepare(
        "UPDATE jobs SET status='running',stage=?,error=NULL,details=NULL,started_at=?,finished_at=NULL,updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory','running') AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
      )
      .run(
        job.status === 'running' ? 'Growing the plant again after a restart.' : 'Starting SeedThree.',
        now,
        now,
        job.id,
        token.owner,
        token.epoch,
        Date.now(),
      );
    if (!claimed.changes) {
      return;
    }
    this.logLifecycle('status_transition', this.get(job.id), 'running');
    try {
      this.launch(job, token);
    } catch (error) {
      this.update(
        job.id,
        {
          status: 'failed',
          stage: 'Failed.',
          error: `Could not start worker: ${error.message}`,
          finished_at: new Date().toISOString(),
        },
        token,
      );
    }
  }
  // Cancels the vegetation job that is growing now. The worker is asked to stop first so it can
  // remove its staged files; it is ended after a short grace period if it does not exit.
  cancelRunningVegetation(id) {
    const job = this.get(id);
    if (job?.type !== 'vegetation' || job.status !== 'running' || this.active?.id !== id) {
      return false;
    }
    const now = new Date().toISOString();
    const changed = this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',stage='Cancelled.',finished_at=?,updated_at=? WHERE id=? AND status='running' AND EXISTS (SELECT 1 FROM runtime_owner WHERE id=1 AND owner=? AND epoch=? AND expires>?)",
      )
      .run(now, now, id, this.owner, this.epoch, Date.now());
    if (!changed.changes) {
      return false;
    }
    const { child } = this.active;
    this.active.forced = true;
    try {
      child.send({ type: 'cancel' });
    } catch {
      // The worker already ended; the kill below is then a no-op.
    }
    setTimeout(() => child.kill(), 3000).unref();
    this.logLifecycle('cancelled', this.get(id));
    return true;
  }
  launch(job, token) {
    const projectFolder = findProject(job.projectId, this.projects);
    const workerFile = {
      music: './music-job.js',
      sfx: './sfx-job.js',
      images: './image-job.js',
      video: './video-job.js',
      voices: './tts-job.js',
      '3d': './hunyuan-job.js',
      trellis: './hunyuan-job.js',
      segmentation: './sam31-job.js',
      motion: './hymotion-job.js',
      'motion-bricks': './motionbricks-job.js',
      world: './world-job.js',
      vegetation: './vegetation-job.js',
    }[job.type];
    const child = fork(new URL(workerFile, import.meta.url), [], {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.active = { id: job.id, child };
    let terminal = false;
    child.stderr.on('data', (data) => process.stderr.write(`[${job.type} job] ${data}`));
    child.stdout.on('data', (data) => process.stdout.write(`[${job.type} job] ${data}`));
    child.on('message', (message) => {
      if (
        this.stopped ||
        !message ||
        message.jobId !== job.id ||
        (this.active?.child === child && this.active.forced)
      ) {
        return;
      }
      const changes = {
        accepted: {
          status: 'running',
          remote_id: message.remoteId,
          started_at: new Date().toISOString(),
          stage: 'Accepted by engine.',
        },
        progress: { status: 'running', stage: message.stage },
        finalizing: { status: 'finalizing', stage: 'Saving asset to project.' },
        complete: {
          status: 'completed',
          output: message.output,
          finished_at: new Date().toISOString(),
          stage: typeof message.stage === 'string' ? message.stage.slice(0, 300) : 'Completed.',
          error: null,
        },
        failed: {
          status: 'failed',
          error: message.error,
          stage: 'Failed.',
          ...(message.engineFailure === true
            ? { details: JSON.stringify({ outcome: ENGINE_FAILED_OUTCOME }) }
            : {}),
        },
        interrupted: { status: 'interrupted', error: message.error, stage: 'Needs attention.' },
      }[message.type];
      const matchReport = message.type === 'complete' ? cleanMatchReport(message.result) : null;
      if (matchReport) {
        changes.details = JSON.stringify({ result: matchReport });
      }
      const vegetationResult =
        message.type === 'complete' && job.type === 'vegetation'
          ? cleanVegetationResult(message.result)
          : null;
      if (vegetationResult) {
        changes.details = JSON.stringify({ result: vegetationResult });
      }
      if (!changes) {
        return;
      }
      const event = {
        accepted: 'accepted',
        complete: 'completed',
        failed: 'failed',
        interrupted: 'interrupted',
      }[message.type];
      if (!this.update(job.id, changes, token, event)) {
        child.kill();
        return;
      }
      if (message.type === 'complete') {
        // Provenance is best effort; recordJobOutput never throws or fails the job.
        recordJobOutput(this.get(job.id) || { ...job, output: message.output }, projectFolder);
        // A video can also be saved as MP4; record that copy as a conversion of the WebM.
        for (const conversion of Array.isArray(message.conversions) ? message.conversions : []) {
          if (typeof conversion?.path === 'string' && typeof conversion.format === 'string') {
            recordConversion(projectFolder, message.output, conversion.path, {
              format: conversion.format,
            });
          }
        }
        // Some renders also keep an intermediate, such as the panorama a world was built from.
        for (const extra of Array.isArray(message.extraOutputs) ? message.extraOutputs : []) {
          if (typeof extra === 'string') {
            recordJobOutput({ ...(this.get(job.id) || job), output: extra }, projectFolder);
          }
        }
      }
      if (['complete', 'failed', 'interrupted'].includes(message.type)) {
        terminal = true;
      }
    });
    child.on('error', (error) => console.error('Music job worker:', error.message));
    child.once('exit', () => {
      if (this.active?.child !== child) {
        return;
      }
      const wasForced = this.active.forced;
      this.active = null;
      if (!terminal && !wasForced && !this.stopped) {
        const current = this.get(job.id);
        if (current?.status === 'submitting') {
          this.update(
            job.id,
            {
              status: 'interrupted',
              error:
                'Submission may have reached the engine. Check its queue before resolving this job.',
            },
            token,
            'uncertain_recovery',
          );
        } else if (job.type === 'vegetation' && current?.status === 'running') {
          // There is no remote job to ask about: the worker died, so say so and let Retry run it.
          this.update(
            job.id,
            {
              status: 'failed',
              stage: 'Failed.',
              error: 'The vegetation worker stopped unexpectedly. Retry to grow the plant again.',
              finished_at: new Date().toISOString(),
            },
            token,
          );
        } else if (current?.remoteId) {
          this.update(
            job.id,
            { status: 'running', stage: 'Worker stopped; resuming known remote job.' },
            token,
            'remote_recheck',
          );
        }
      }
      if (!this.stopped) {
        setImmediate(() => this.tick());
      }
    });
    child.send({ job, projectFolder, baseUrl: engineUrl(job.type) });
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.active?.child.kill();
    if (this.hasLease) {
      this.db
        .prepare('UPDATE runtime_owner SET expires=0 WHERE id=1 AND owner=? AND epoch=?')
        .run(this.owner, this.epoch);
    }
    this.db.close();
  }
}
export function engineUrl(type) {
  const base = new URL(
    type === 'music'
      ? process.env.FORGE_MUSIC_URL || 'http://127.0.0.1:8765'
      : type === 'sfx'
        ? process.env.FORGE_SFX_URL || 'http://127.0.0.1:7863'
        : ['voices', 'tts'].includes(type)
          ? process.env.FORGE_TTS_URL || 'http://127.0.0.1:8281'
          : ['trellis', '3d-trellis'].includes(type)
            ? process.env.FORGE_TRELLIS_URL || 'http://127.0.0.1:8285'
            : ['3d', '3d-hunyuan'].includes(type)
              ? process.env.FORGE_HUNYUAN_URL || 'http://127.0.0.1:8283'
              : type === 'segmentation'
                ? process.env.FORGE_SAM31_URL || 'http://127.0.0.1:8284'
                : type === 'motion-bricks'
                  ? process.env.FORGE_MOTIONBRICKS_URL || 'http://127.0.0.1:8287'
                  : ['motion', 'motion-hy'].includes(type)
                    ? process.env.FORGE_HYMOTION_URL || 'http://127.0.0.1:8286'
                    : type === 'world'
                      ? process.env.FORGE_WORLD_URL || 'http://127.0.0.1:8288'
                      : type === 'video'
                        ? process.env.FORGE_VIDEO_URL || 'http://127.0.0.1:8274'
                        : process.env.FORGE_IMAGE_URL || 'http://127.0.0.1:8189',
  );
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  ) {
    throw Error('Engine URL must be a local HTTP origin.');
  }
  return base.origin;
}
function engineId(type) {
  return type === 'voices'
    ? 'tts'
    : type === '3d'
      ? '3d-hunyuan'
      : type === 'trellis'
        ? '3d-trellis'
        : type === 'motion'
          ? 'motion-hy'
          : type;
}
function engineName(type) {
  return (
    {
      music: 'YuE2',
      sfx: 'Stable Audio',
      images: 'Qwen Image',
      video: 'H3 Studio',
      voices: 'Qwen3-TTS',
      tts: 'Qwen3-TTS',
      '3d': 'Hunyuan3D',
      '3d-hunyuan': 'Hunyuan3D',
      trellis: 'TRELLIS.2',
      '3d-trellis': 'TRELLIS.2',
      segmentation: 'SAM 3.1',
      motion: 'HY-Motion',
      'motion-hy': 'HY-Motion',
      'motion-bricks': 'MotionBricks',
      world: 'World generation',
      vegetation: 'SeedThree',
    }[type] || 'engine'
  );
}
