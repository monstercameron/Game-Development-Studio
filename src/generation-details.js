// Pure helpers for showing a file's generation details and for reusing them.
// The metadata record is produced by runtime/asset-metadata.js.
import { VIDEO_ASPECTS, VIDEO_FRAME_PRESETS, VIDEO_RESOLUTIONS } from '../runtime/video-options.js';
import {
  SEGMENTATION_EXPORTS,
  SEGMENTATION_MATCH_CHOICES,
  matchChoice,
  segmentationExportLabel,
} from './segmentation-settings.js';

const settingLabels = {
  seed: 'Seed',
  steps: 'Steps',
  num_inference_steps: 'Steps',
  ode_steps: 'Steps',
  width: 'Width',
  height: 'Height',
  resolution: 'Resolution',
  duration: 'Duration (s)',
  duration_seconds: 'Duration (s)',
  frames: 'Frames',
  aspect: 'Aspect',
  guidance: 'Guidance',
  true_cfg_scale: 'Negative guidance',
  transparent: 'Transparent background',
  size_from_reference: 'Size from last reference',
  cfg_scale: 'Guidance',
  cot: 'Planning',
  abc: 'Melody score',
  temperature: 'Temperature',
  top_p: 'Top-p',
  top_k: 'Top-k',
  repetition_penalty: 'Repetition penalty',
  texture: 'Texture',
  texture_size: 'Texture size',
  texture_views: 'Painted views',
  texture_view_size: 'Painted view size (px)',
  target_faces: 'Triangle target',
  pipeline: 'Pipeline',
  chained_from_job: 'Made from render',
  chained_from_asset: 'Made from file',
  mode: 'Mode',
  output: 'Output',
  save_panorama: 'Panorama image saved',
  splat_limit: 'Splat limit',
  remove_sky: 'Sky removed',
  confidence_percentile: 'Least-confident points dropped (%)',
  confidence: 'Confidence',
  select: 'Which matches',
  max_instances: 'Most matches kept',
  matches_found: 'Matches found',
  matches_used: 'Matches used',
  match_scores: 'Scores of kept matches',
  speaker: 'Voice',
  language: 'Language',
  max_new_tokens: 'Token limit',
  context_frame: 'Context frame',
  target_frame: 'Target frame',
  min_tokens: 'Min tokens',
  max_tokens: 'Max tokens',
  num_target_poses: 'Target poses used',
  model: 'Engine option',
  conversion_format: 'Converted to',
  turbo: 'Turbo adapter',
  sampler: 'Sampler',
  scheduler: 'Scheduler',
  max_vram: 'GPU memory budget (GiB)',
  max_vram_automatic: 'GPU budget set by Forge for reference clips',
  reference_detail: 'Reference detail',
  use_clip_audio: 'Sound of reference videos used',
  also_mp4: 'MP4 copy saved',
  operation: 'Operation',
  source: 'Source track',
  add_seconds: 'Seconds added',
  lyrics_addition: 'Added lyrics',
  lora: 'LoRA',
  lora_scale: 'LoRA strength',
  use_kv_cache: 'KV cache',
  output_resolution: 'Reference size target',
  sigma_schedule: 'Sampling schedule',
  variation_index: 'Variation',
  edit_mode: 'Source sound use',
  init_noise_level: 'Change amount',
  inpaint_start: 'Replaced from (s)',
  inpaint_end: 'Replaced to (s)',
  do_sample: 'Sampling',
  subtalker_dosample: 'Fine-detail sampling',
  subtalker_temperature: 'Fine-detail temperature',
  subtalker_top_p: 'Fine-detail top-p',
  subtalker_top_k: 'Fine-detail top-k',
  reference_text: 'Reference transcript',
  clone_voice_only: 'Voice only (no transcript)',
  species: 'Species',
  budget: 'Triangle budget',
  lod: 'Level of detail',
  triangles: 'Triangles',
  vertices: 'Vertices',
  height_m: 'Plant height (m)',
  width_m: 'Plant width (m)',
  depth_m: 'Plant depth (m)',
  glb_bytes: 'File size',
  grow_ms: 'Growing time',
  export_ms: 'Export time',
  peak_rss_mib: 'Peak memory of the generator',
  seedthree_version: 'SeedThree version',
  seedthree_commit: 'SeedThree commit',
};
// A vegetation render records each control as p_<id> (dots written as double underscores).
function vegetationControlLabel(key) {
  const words = key
    .slice(2)
    .split('__')
    .filter((part) => part !== 'paramOverrides')
    .map((part) =>
      /^\d+$/.test(part) ? `L${part}` : part.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
    )
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
// Bookkeeping that is stored with a render but means nothing to read: grouping IDs, the engine's
// own job ID, and the staged copy of a source sound (the "Source sound use" row says it was used).
const videoSources = {
  references: 'Reference images',
  frames: 'First and last frame',
  text: 'Text only',
};
const hiddenSettings = new Set([
  'variation_group',
  'variation_count',
  'source_job',
  'source_remote',
  'source_audio',
  'reference_audio',
]);
const operationNames = { extend: 'Extended a finished track', resynth: 'Re-synthesized' };
const soundUseNames = {
  variation: 'Variation of a source sound',
  replace: 'Replaced a part of a source sound',
  continue: 'Continued a source sound',
};
const settingOrder = Object.keys(settingLabels);

export function modelLabel(meta) {
  const model = meta?.model;
  if (!model) {
    return null;
  }
  return model.name || model.id || null;
}
export function secondaryLabel(meta) {
  const type = meta?.type || meta?.asset?.kind;
  if (type === 'music') {
    return 'Lyrics';
  }
  if (type === 'voices') {
    return meta?.settings?.mode === 'design' ? 'Voice description' : 'Voice direction';
  }
  if (type === 'chat') {
    return 'System prompt';
  }
  return 'Notes';
}
export function negativeLabel(meta) {
  return meta?.type === 'music' ? 'Style to avoid' : 'Negative prompt';
}
const pipelineNames = {
  512: '512',
  1024: '1024',
  '1024_cascade': '1024 cascade',
  '1536_cascade': '1536 cascade',
};
const planningNames = { full: 'Full arrangement', melody: 'Melody', off: 'Off' };
// World renders record plain ids for their starting point and output type.
const worldValueNames = {
  text: 'Text description',
  image: 'Reference image',
  panorama: '360° panorama',
  splat: 'Gaussian splat (PLY)',
  mesh: 'Mesh (PLY)',
  glb: 'Mesh (GLB)',
};
// SAM 3.1 segmentation records plain ids for the saved picture and which matches were kept.
const segmentationOutputNames = Object.fromEntries(
  SEGMENTATION_EXPORTS.map(([label, id]) => [id, label]),
);
const matchSelectionNames = Object.fromEntries(
  SEGMENTATION_MATCH_CHOICES.map(([label, id]) => [id, label]),
);
function formatValue(key, value) {
  if (key === 'aspect' && VIDEO_ASPECTS[value]) {
    return VIDEO_ASPECTS[value].label;
  }
  if (key === 'resolution' && typeof value === 'string' && VIDEO_RESOLUTIONS[value]) {
    return VIDEO_RESOLUTIONS[value].label;
  }
  if (key === 'source' && videoSources[value]) {
    return videoSources[value];
  }
  if (key === 'cot' && planningNames[value]) {
    return planningNames[value];
  }
  if (key === 'abc' && typeof value === 'string') {
    return `Custom ABC score (${value.length} characters)`;
  }
  if (['do_sample', 'subtalker_dosample'].includes(key) && typeof value === 'boolean') {
    return value ? 'Sampling' : 'Greedy';
  }
  if (key === 'operation' && operationNames[value]) {
    return operationNames[value];
  }
  if (key === 'edit_mode' && soundUseNames[value]) {
    return soundUseNames[value];
  }
  if (typeof value === 'boolean') {
    return value ? 'On' : 'Off';
  }
  if (key === 'target_faces' && Number.isFinite(Number(value))) {
    return Number(value).toLocaleString('en-US');
  }
  if (key === 'pipeline') {
    return pipelineNames[value] || String(value);
  }
  if (key === 'seed' && value === -1) {
    return 'Random';
  }
  if (key === 'mode' && worldValueNames[value]) {
    return worldValueNames[value];
  }
  if (key === 'output' && worldValueNames[value]) {
    return worldValueNames[value];
  }
  if (key === 'output' && segmentationOutputNames[value]) {
    return segmentationOutputNames[value];
  }
  if (key === 'select' && matchSelectionNames[value]) {
    return matchSelectionNames[value];
  }
  if (key === 'species' && typeof value === 'string') {
    const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (key === 'budget' && typeof value === 'string') {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  if (['triangles', 'vertices'].includes(key) && Number.isFinite(Number(value))) {
    return Number(value).toLocaleString('en-US');
  }
  if (key === 'glb_bytes' && Number.isFinite(Number(value))) {
    return `${(Number(value) / 1048576).toFixed(2)} MiB`;
  }
  if (['grow_ms', 'export_ms'].includes(key) && Number.isFinite(Number(value))) {
    return `${Number(value).toLocaleString('en-US')} ms`;
  }
  if (key === 'peak_rss_mib' && Number.isFinite(Number(value))) {
    return `${Number(value).toLocaleString('en-US')} MiB`;
  }
  if (key === 'seedthree_commit' && typeof value === 'string') {
    return value.slice(0, 10);
  }
  return String(value);
}
// Settings as [{ key, label, value }] in a stable, readable order. The seed
// column is shown once even when it is also present in the settings object.
export function describeSettings(meta) {
  const settings = { ...(meta?.settings || {}) };
  if (meta?.seed !== null && meta?.seed !== undefined && settings.seed === undefined) {
    settings.seed = meta.seed;
  }
  // The 3D engine is already named in the model row; its internal id is not a setting.
  const redundant = ['3d', 'trellis', 'world'].includes(meta?.type) ? ['model'] : [];
  // An extension stores only the added seconds as its duration; "Seconds added" already says so,
  // and the length of the whole new track is not a recorded setting.
  const derivedMusic = meta?.type === 'music' && Boolean(settings.operation);
  const keys = Object.keys(settings).filter(
    (key) =>
      settings[key] !== null &&
      !redundant.includes(key) &&
      !hiddenSettings.has(key) &&
      !(derivedMusic && key === 'duration_seconds'),
  );
  keys.sort((a, b) => {
    const left = settingOrder.indexOf(a),
      right = settingOrder.indexOf(b);
    return (left < 0 ? 999 : left) - (right < 0 ? 999 : right) || a.localeCompare(b);
  });
  return keys.map((key) => ({
    key,
    label:
      key === 'source' && videoSources[settings[key]]
        ? 'Starts from'
        : meta?.type === 'vegetation' && key.startsWith('p_')
          ? vegetationControlLabel(key)
          : settingLabels[key] || key.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()),
    // A variation reads "2 of 4"; its group ID and count are not shown on their own.
    value:
      key === 'variation_index' && settings.variation_count
        ? `${settings[key]} of ${settings.variation_count}`
        : formatValue(key, settings[key]),
  }));
}
export function describeSource(meta) {
  if (!meta) {
    return '';
  }
  if (meta.source === 'conversion') {
    return meta.parent?.path ? `Converted from ${meta.parent.path}` : 'Converted copy';
  }
  if (meta.source === 'saved-text') {
    return 'Saved from the studio';
  }
  if (meta.source === 'job') {
    return meta.backfilled ? 'Generated (recovered from render history)' : 'Generated';
  }
  // Megascans imports record the seller; other imports have no source details.
  if (meta.source === 'import' && meta.settings?.seller) {
    return `Imported from Fab / ${meta.settings.seller}`;
  }
  return meta.source === 'import' ? 'Imported' : 'Unknown';
}
export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

// ------------------------------------------------------------------ reuse
const imageSizes = {
  '1024x576': 'Landscape · 16:9',
  '1024x1024': 'Square · 1:1',
  '576x1024': 'Portrait · 9:16',
};
const imageQualities = { 30: 'Balanced', 12: 'Draft', 40: 'High quality' };
const videoAspects = Object.fromEntries(
  Object.entries(VIDEO_ASPECTS).map(([id, { label }]) => [id, label]),
);
// A frame count outside the presets (the queue accepts any 17 n + 5) reuses the nearest preset.
const videoFrames = (frames) => {
  const presets = Object.keys(VIDEO_FRAME_PRESETS).map(Number);
  const nearest = presets.reduce((best, item) =>
    Math.abs(item - frames) < Math.abs(best - frames) ? item : best,
  );
  return Number.isFinite(Number(frames)) ? VIDEO_FRAME_PRESETS[nearest] : 'About 5 seconds';
};
const text = (value) => (typeof value === 'string' ? value : '');
const str = (value) => (value === null || value === undefined ? '' : String(value));
const sampleChoice = (value) => (value === true ? 'on' : value === false ? 'off' : '');

// Returns the page and draft that recreate the settings of an asset, or null
// when its type has no creation page. References are never carried over.
export function reusePlan(meta) {
  const type = meta?.job?.type;
  const s = meta?.settings || {};
  const prompt = text(meta?.prompt?.text);
  const seed = meta?.seed ?? (Number.isSafeInteger(s.seed) && s.seed >= 0 ? s.seed : null);
  const common = { seed: str(seed) };
  if (type === 'images') {
    const size = `${s.width}x${s.height}`;
    const fromReference = s.size_from_reference === true;
    return {
      section: 'images',
      draft: {
        ...common,
        prompt,
        options: [
          imageSizes[size] || 'Landscape · 16:9',
          imageQualities[s.num_inference_steps] || 'Balanced',
        ],
        imageWidth: fromReference ? '' : str(s.width),
        imageHeight: fromReference ? '' : str(s.height),
        imageMatchReference: fromReference,
        imageTransparent: s.transparent === true,
        imageSteps: str(s.num_inference_steps),
        imageNegativePrompt: text(meta.prompt.negative),
        imageGuidance: s.true_cfg_scale > 1 ? str(s.true_cfg_scale) : '',
        imageTargetSize: str(s.output_resolution),
        imageKvCache: s.use_kv_cache !== false,
        imageSigmas: text(s.sigma_schedule),
        imageLora: text(s.lora),
        imageLoraScale: s.lora ? str(s.lora_scale) : '',
      },
    };
  }
  if (type === 'video') {
    return {
      section: 'video',
      draft: {
        ...common,
        prompt,
        options: [videoAspects[s.aspect] || 'Landscape · 16:9', videoFrames(s.frames)],
        videoSteps: str(s.steps),
        // Reference files are never attached, so a frames render opens ready for new pictures.
        videoSource: ['frames', 'text'].includes(s.source) ? s.source : 'references',
        videoResolution: VIDEO_RESOLUTIONS[s.resolution] ? s.resolution : 'standard',
        videoTurbo: s.turbo === true,
        videoNegative: text(meta.prompt.negative),
        videoCfg: s.cfg_scale > 1 ? str(s.cfg_scale) : '',
        videoSampler: str(s.sampler),
        videoScheduler: str(s.scheduler),
        videoMaxVram: str(s.max_vram),
        videoRefDetail: str(s.reference_detail),
        videoClipAudio: false,
        videoAlsoMp4: s.also_mp4 === true,
      },
    };
  }
  if (type === 'music') {
    // An extended or re-synthesized track stores no length of its own, and its title carries a
    // suffix that the new render adds again. A new render from it starts from the preset length.
    const derived = Boolean(s.operation);
    const duration = derived ? Number.NaN : Number(s.duration_seconds);
    return {
      section: 'music',
      draft: {
        ...common,
        prompt,
        second: text(meta.prompt.secondary),
        options: [
          [15, 30, 60].includes(duration) ? `${duration} seconds` : '15 seconds',
          planningNames[s.cot] || 'Full arrangement',
        ],
        musicDuration: derived ? '' : str(s.duration_seconds),
        musicSteps: str(s.ode_steps),
        musicTitle: derived
          ? text(meta.prompt.title).replace(/(?:\s*\((?:extended|re-synthesized)\))+$/i, '')
          : text(meta.prompt.title),
        musicNegative: text(meta.prompt.negative),
        musicGuidance: str(s.cfg_scale),
        musicScore: text(s.abc),
        musicTemperature: str(s.temperature),
        musicTopP: str(s.top_p),
        musicTopK: str(s.top_k),
        musicRepetition: str(s.repetition_penalty),
      },
    };
  }
  if (type === 'sfx') {
    return {
      section: 'sfx',
      draft: {
        prompt,
        seed: seed === null ? '' : str(seed),
        // A source sound is a staged copy that is not carried over, like a reference image.
        soundDuration: str(s.duration),
        soundSteps: str(s.steps),
        // Reuse merges into the saved draft, so clear a source left from earlier. The mode, change
        // amount and region come back, so choosing the source again recreates the same edit.
        soundSourceId: '',
        soundSourceName: '',
        soundEditMode: ['variation', 'replace', 'continue'].includes(s.edit_mode)
          ? s.edit_mode
          : 'variation',
        soundInitLevel: s.edit_mode === 'variation' ? str(s.init_noise_level) : '',
        soundRegionStart: s.edit_mode === 'replace' ? str(s.inpaint_start) : '',
        soundRegionEnd: s.edit_mode === 'replace' ? str(s.inpaint_end) : '',
      },
    };
  }
  if (type === 'voices') {
    const voiceMode = s.mode === 'design' || s.mode === 'clone' ? s.mode : 'preset';
    return {
      section: 'voices',
      draft: {
        ...common,
        prompt,
        // The staged reference clip is not carried over; the user chooses it again.
        voiceMode,
        second: voiceMode === 'preset' ? text(meta.prompt.secondary) : '',
        voiceDescription: voiceMode === 'design' ? text(meta.prompt.secondary) : '',
        voiceReferenceText: voiceMode === 'clone' ? str(s.reference_text) : '',
        voiceConsent: false,
        voiceCloneVoiceOnly: voiceMode === 'clone' && s.clone_voice_only === true,
        // Reuse merges into the saved draft, so clear a clip left from earlier: it would not match
        // the restored transcript. The restored transcript is unbound, so the first clip chosen
        // after reuse keeps it.
        voiceReferenceId: '',
        voiceReferenceName: '',
        voiceReferenceSourceKey: '',
        voiceReferenceTextKey: '',
        options: [str(s.speaker) || 'Ryan', str(s.language) || 'English'],
        voiceMaxTokens: str(s.max_new_tokens),
        voiceTemperature: str(s.temperature),
        voiceTopP: str(s.top_p),
        voiceTopK: str(s.top_k),
        voiceRepetition: str(s.repetition_penalty),
        voiceDoSample: sampleChoice(s.do_sample),
        voiceSubDoSample: sampleChoice(s.subtalker_dosample),
        voiceSubTemperature: str(s.subtalker_temperature),
        voiceSubTopP: str(s.subtalker_top_p),
        voiceSubTopK: str(s.subtalker_top_k),
      },
    };
  }
  if (type === '3d') {
    return {
      section: '3d',
      model: 'Hunyuan3D 2.1',
      draft: {
        ...common,
        prompt,
        shapeSteps: str(s.steps),
        resolution: str(s.resolution),
        shapeGuidance: str(s.guidance ?? 5),
        shapeTriangles: str(s.target_faces),
        texture: s.texture === true,
        ...(s.texture === true
          ? {
              textureSize: str(s.texture_size),
              textureViews: str(s.texture_views ?? 6),
              textureViewSize: str(s.texture_view_size ?? 512),
            }
          : {}),
      },
    };
  }
  if (type === 'trellis') {
    return {
      section: '3d',
      model: 'TRELLIS.2',
      draft: {
        ...common,
        prompt,
        trellisSteps: str(s.steps),
        trellisTexture: str(s.texture_size),
        // Renders made before the triangle target existed exported up to a million triangles.
        trellisTriangles: str(s.target_faces ?? 1000000),
        trellisPipeline: str(s.pipeline ?? '512'),
      },
    };
  }
  if (type === 'motion') {
    return {
      section: 'motion',
      model: 'HY-Motion 1.0',
      draft: {
        ...common,
        prompt,
        motionDuration: str(s.duration),
        motionSteps: str(s.steps),
        motionGuidance: str(s.guidance),
      },
    };
  }
  if (type === 'motion-bricks') {
    return {
      section: 'motion',
      model: 'NVIDIA MotionBricks',
      draft: {
        ...common,
        prompt,
        contextFrame: str(s.context_frame),
        targetFrame: str(s.target_frame),
        minTokens: str(s.min_tokens),
        maxTokens: str(s.max_tokens),
        // Renders made before this setting existed used all four target poses.
        targetPoses: str(s.num_target_poses ?? 4),
      },
    };
  }
  if (type === 'segmentation') {
    return {
      section: 'segmentation',
      draft: {
        prompt,
        confidence: str(s.confidence),
        options: ['Text prompt', segmentationExportLabel(s.output)],
        matches: matchChoice(s.select),
        maxInstances: s.select === 'top' ? str(s.max_instances) : '',
      },
    };
  }
  if (type === 'vegetation') {
    return {
      section: 'vegetation',
      draft: {},
      // The Vegetation page validates this against SeedThree's schema before using it.
      // Control values were stored as p_<id> with dots written as double underscores.
      vegetation: {
        species: s.species,
        seed,
        budget: s.budget,
        params: Object.fromEntries(
          Object.entries(s)
            .filter(([key]) => key.startsWith('p_'))
            .map(([key, value]) => [key.slice(2).replaceAll('__', '.'), value]),
        ),
      },
    };
  }
  if (type === 'world') {
    const model = s.model === 'hy-world' ? 'hy-world' : 'worldgen';
    return {
      section: 'world',
      model,
      draft: {},
      // Everything the World page needs to refill its form; reference files are never attached.
      world: {
        model,
        mode: ['image', 'panorama'].includes(s.mode) ? s.mode : 'text',
        prompt,
        output: ['mesh', 'glb'].includes(s.output) ? s.output : 'splat',
        resolution: s.resolution,
        seed: Number.isSafeInteger(seed) && seed >= 0 ? seed : null,
        steps: s.steps,
        guidance: s.guidance,
        save_panorama: s.save_panorama === true,
        splat_limit: s.splat_limit,
        remove_sky: s.remove_sky === true,
        confidence_percentile: s.confidence_percentile,
      },
    };
  }
  return null;
}
// The object the studio's openDraft() expects for the plan's page.
export function draftJob(plan, projectId) {
  const { draft } = plan;
  return {
    kind: plan.section,
    projectId,
    draftSnapshot: draft,
    prompt: draft.prompt || '',
    second: draft.second || '',
    options: draft.options,
    refs: [],
    model: ['3d', 'motion'].includes(plan.section) ? plan.model : undefined,
    seed: draft.seed ?? '',
    motionRig: 'SOMA human',
  };
}
