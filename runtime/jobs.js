import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function validate(input, root = projectsRoot) {
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
    ].includes(input.type) ||
    typeof input.projectId !== 'string' ||
    !input.request ||
    typeof input.request !== 'object'
  ) {
    throw Error('Expected a supported render job with projectId and request.');
  }
  if (input.type === 'world') {
    const {
      model,
      mode,
      prompt = '',
      output = 'splat',
      resolution,
      references = [],
      seed = 42,
      steps = 50,
    } = input.request;
    if (
      !['worldgen', 'hy-world'].includes(model) ||
      !['text', 'image', 'panorama'].includes(mode) ||
      typeof prompt !== 'string' ||
      prompt.length > 4000 ||
      !['mesh', 'splat'].includes(output)
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
      !Number.isInteger(seed) ||
      seed < 0 ||
      seed > 2147483647 ||
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
      (mode !== 'image' ||
        references.length < 1 ||
        output !== 'splat' ||
        ![336, 518, 700].includes(resolution))
    ) {
      throw Error('HY-World requires 1–8 reference images and a supported resolution.');
    }
    findProject(input.projectId, root);
    return {
      type: 'world',
      projectId: input.projectId,
      request: { model, mode, prompt: prompt.trim(), output, resolution, references, seed, steps },
    };
  }
  if (input.type === 'trellis') {
    const { references, seed = 42, steps = 12, texture_size = 1024 } = input.request;
    if (
      !Array.isArray(references) ||
      references.length !== 1 ||
      typeof references[0] !== 'string' ||
      !/^[a-f0-9-]{36}\.(png|webp)$/i.test(references[0])
    ) {
      throw Error('Provide one staged transparent PNG or WebP image.');
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
    findProject(input.projectId, root);
    return {
      type: 'trellis',
      projectId: input.projectId,
      request: { model: 'trellis', references, seed, steps, texture_size },
    };
  }
  if (input.type === 'motion-bricks') {
    const { pose, context_frame, target_frame, min_tokens = 8, max_tokens = 14 } = input.request;
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
    findProject(input.projectId, root);
    return {
      type: 'motion-bricks',
      projectId: input.projectId,
      request: { pose, context_frame, target_frame, min_tokens, max_tokens },
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
    const { prompt, references, output = 'transparent', confidence = 0.5 } = input.request;
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
      !['transparent', 'mask'].includes(output) ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw Error('Invalid segmentation output or confidence.');
    }
    findProject(input.projectId, root);
    return {
      type: 'segmentation',
      projectId: input.projectId,
      request: { prompt: prompt.trim(), references, output, confidence },
    };
  }
  if (input.type === '3d') {
    const {
      model = 'hunyuan',
      references,
      seed = 123,
      steps = 30,
      resolution = 128,
      texture = false,
      texture_size = 2048,
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
    if (typeof texture !== 'boolean' || ![1024, 2048].includes(texture_size)) {
      throw Error('Invalid 3D texture option or texture size.');
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
        ...(texture ? { texture: true, texture_size } : {}),
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
      max_new_tokens > 2048
    ) {
      throw Error('Invalid voice, language, or generation limit.');
    }
    findProject(input.projectId, root);
    return {
      type: 'voices',
      projectId: input.projectId,
      request: { text, speaker, language, instruct, max_new_tokens },
    };
  }
  if (input.type === 'video') {
    const { prompt, references, aspect = 'landscape', frames = 124, steps = 12 } = input.request;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
      throw Error('Video description must contain 1–4000 characters.');
    }
    if (
      !Array.isArray(references) ||
      references.length < 1 ||
      references.length > 9 ||
      references.some(
        (id) => typeof id !== 'string' || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/i.test(id),
      )
    ) {
      throw Error('Provide 1 to 9 staged reference image IDs.');
    }
    if (
      !['landscape', 'square', 'portrait'].includes(aspect) ||
      ![56, 124, 175, 243].includes(frames) ||
      ![8, 12, 20, 30].includes(steps)
    ) {
      throw Error('Invalid video aspect, frame count, or steps.');
    }
    findProject(input.projectId, root);
    return {
      type: 'video',
      projectId: input.projectId,
      request: { prompt, references, aspect, frames, steps },
    };
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
    } = input.request;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
      throw Error('Image description must contain 1–4000 characters.');
    }
    if (
      ![width, height].every((n) => Number.isInteger(n) && n >= 32 && n <= 2048 && n % 32 === 0) ||
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
    findProject(input.projectId, root);
    return {
      type: 'images',
      projectId: input.projectId,
      request: {
        prompt,
        width,
        height,
        num_inference_steps,
        references,
        ...(seed === null ? {} : { seed }),
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
    findProject(input.projectId, root);
    return { type: 'sfx', projectId: input.projectId, request: { prompt, duration, steps, seed } };
  }
  const {
    style,
    lyrics,
    duration_seconds = 15,
    seed = 831001,
    cot = 'full',
    title = '',
    ode_steps = 32,
    negative = '',
    cfg_scale = null,
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
  findProject(input.projectId, root);
  return {
    type: 'music',
    projectId: input.projectId,
    request: { style, lyrics, duration_seconds, seed, cot, title, ode_steps, negative, cfg_scale },
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
  };
}
function profile(type, request) {
  const keys = {
    images: ['width', 'height', 'num_inference_steps'],
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
  }[type];
  const values = keys.map((key) => request[key]);
  if (['images', 'video', 'world'].includes(type)) {
    values.push(Array.isArray(request.references) ? request.references.length : 0);
  }
  if (type === 'world' && request.model === 'worldgen' && request.mode !== 'panorama') {
    values.push(request.steps ?? 50);
  }
  if (type === 'images') {
    values.push((request.true_cfg_scale || 1) > 1);
  }
  if (type === 'music') {
    values.push(
      request.cfg_scale === null || request.cfg_scale === undefined
        ? request.cot === 'off'
        : request.cfg_scale !== 1,
    );
  }
  if (type === 'motion') {
    values.push(request.guidance !== 1);
  }
  if (type === 'voices') {
    values.push(Math.ceil((request.text?.length || 0) / 50));
  }
  if (type === '3d') {
    // Painted renders take far longer, so they never share timing history with shape-only ones.
    values.push(request.texture === true ? request.texture_size : false);
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
    onModelLoadBarrier = null,
    onQueueLog = null,
  } = {}) {
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
    for (const column of ['started_at', 'finished_at', 'details']) {
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
      'CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status,created_at); CREATE INDEX IF NOT EXISTS jobs_history_lookup ON jobs(type,status,updated_at);',
    );
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
        `SELECT * FROM jobs ORDER BY CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN 0 ELSE 1 END, CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN created_at END ASC, CASE WHEN status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') THEN rowid END ASC, created_at DESC, rowid DESC LIMIT 200`,
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
  enqueue(input) {
    const value = validate(input, this.projects),
      id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO jobs(id,type,project_id,request,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(id, value.type, value.projectId, JSON.stringify(value.request), 'queued', now, now);
    this.logLifecycle('enqueued', { id, type: value.type, status: 'queued' });
    if (this.autoStart) {
      setImmediate(() => this.tick());
    }
    return this.get(id);
  }
  cancel(id) {
    const result = this.db
      .prepare(
        "UPDATE jobs SET status='cancelled',updated_at=? WHERE id=? AND status IN ('queued','waiting_engine','waiting_memory','needs_attention') AND remote_id IS NULL",
      )
      .run(new Date().toISOString(), id);
    if (!result.changes) {
      throw Error('Only queued jobs can be cancelled here.');
    }
    this.memoryRetryAt.delete(id);
    this.logLifecycle('cancelled', this.get(id));
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
        "UPDATE jobs SET status=CASE WHEN remote_id IS NULL THEN 'queued' ELSE 'running' END,stage=CASE WHEN remote_id IS NULL THEN 'Queued for retry.' ELSE 'Rechecking the existing engine job.' END,error=NULL,details=NULL,finished_at=NULL,started_at=CASE WHEN remote_id IS NULL THEN NULL ELSE started_at END,updated_at=? WHERE id=? AND status IN ('failed','needs_attention','waiting_memory')",
      )
      .run(now, id);
    if (!result.changes) {
      throw Error('Only failed or waiting jobs can be retried.');
    }
    this.memoryRetryAt.delete(id);
    const retried = this.get(id);
    this.logLifecycle(retried.remoteId ? 'retry_recheck' : 'retry_queued', retried);
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
                "SELECT * FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','submitting','running','finalizing','interrupted') ORDER BY created_at,rowid LIMIT 1",
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
          "SELECT id,status FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','running','finalizing','interrupted') ORDER BY created_at,rowid LIMIT 1",
        )
        .get()?.id === job.id &&
      this.get(job.id)?.status === 'waiting_memory';
    const upcoming = this.db
      .prepare(
        "SELECT type FROM jobs WHERE id!=? AND status IN ('queued','waiting_engine','waiting_memory') ORDER BY created_at,rowid",
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
      const job = publicJob(
        this.db
          .prepare(
            "SELECT * FROM jobs WHERE status IN ('queued','waiting_engine','waiting_memory','preparing','needs_attention','running','finalizing','interrupted') ORDER BY created_at, rowid LIMIT 1",
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
            ? this.prepareVideo
            : job.type === 'images' && health.status !== 'ready'
              ? this.prepareImage
              : job.type === '3d' && this.prepareHunyuanRender
                ? () => this.prepareHunyuanRender(job.request)
                : job.type === 'trellis'
                  ? this.prepareTrellisRender
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
          stage: 'Completed.',
          error: null,
        },
        failed: { status: 'failed', error: message.error, stage: 'Failed.' },
        interrupted: { status: 'interrupted', error: message.error, stage: 'Needs attention.' },
      }[message.type];
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
    }[type] || 'engine'
  );
}
