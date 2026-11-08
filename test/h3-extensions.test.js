import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  normalizeVideoRequest,
  videoDimensions,
  videoWarnings,
  validFrameCount,
  VIDEO_ASPECTS,
  VIDEO_RESOLUTIONS,
  MAX_VIDEO_PIXELS,
  TURBO_ADAPTER,
} from '../runtime/video-options.js';

const require = createRequire(import.meta.url);
const h3Args = require('../runtime/h3_args.cjs');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const image = '11111111-1111-4111-8111-111111111111.png';
const image2 = '22222222-2222-4222-8222-222222222222.png';
const clip = '33333333-3333-4333-8333-333333333333.mp4';
const sound = '44444444-4444-4444-8444-444444444444.wav';
const normalize = (request) => normalizeVideoRequest({ prompt: 'a scene', ...request }, () => 77);

test('a plain video request keeps its original shape', () => {
  assert.deepEqual(normalize({ references: [image] }), {
    prompt: 'a scene',
    references: [image],
    aspect: 'landscape',
    frames: 124,
    steps: 12,
    seed: 77,
  });
});

test('every aspect and resolution is a 32-pixel size within the memory ceiling', () => {
  for (const aspect of Object.keys(VIDEO_ASPECTS)) {
    for (const resolution of Object.keys(VIDEO_RESOLUTIONS)) {
      const [width, height] = videoDimensions(aspect, resolution);
      assert.equal(width % 32, 0, `${aspect}/${resolution} width`);
      assert.equal(height % 32, 0, `${aspect}/${resolution} height`);
      assert.ok(width * height <= MAX_VIDEO_PIXELS, `${aspect}/${resolution} too large`);
    }
  }
  assert.deepEqual(videoDimensions('landscape'), [608, 352]);
  assert.deepEqual(videoDimensions('portrait'), [352, 608]);
  assert.deepEqual(videoDimensions('square'), [448, 448]);
  assert.deepEqual(videoDimensions('landscape', 'hd'), [1344, 768]);
  assert.deepEqual(videoDimensions('photo-portrait', 'standard'), [384, 512]);
  assert.equal(videoDimensions('nope'), null);
});

test('frame counts follow MiniMax 17n + 5 up to 15 seconds', () => {
  for (const frames of [56, 124, 175, 243, 260, 311, 362]) {
    assert.equal(validFrameCount(frames), true, String(frames));
  }
  for (const frames of [5, 55, 100, 363, 379, 56.5, '124']) {
    assert.equal(validFrameCount(frames), false, String(frames));
  }
  assert.equal(normalize({ references: [image], frames: 362 }).frames, 362);
  assert.throws(() => normalize({ references: [image], frames: 400 }), /Invalid frame count/);
});

test('first and last frame mode needs a first frame and excludes references', () => {
  assert.deepEqual(normalize({ source: 'frames', first_frame: image, last_frame: image2 }), {
    prompt: 'a scene',
    references: [],
    aspect: 'landscape',
    frames: 124,
    steps: 12,
    seed: 77,
    source: 'frames',
    first_frame: image,
    last_frame: image2,
  });
  assert.equal(normalize({ source: 'frames', first_frame: image }).last_frame, undefined);
  assert.throws(() => normalize({ source: 'frames' }), /first frame/);
  assert.throws(() => normalize({ source: 'frames', last_frame: image }), /first frame/);
  assert.throws(
    () => normalize({ source: 'frames', first_frame: image, references: [image2] }),
    /cannot be combined/,
  );
  assert.throws(
    () => normalize({ references: [image2], first_frame: image }),
    /cannot be combined/,
  );
  assert.throws(() => normalize({ source: 'frames', first_frame: 'x.png' }), /staged image ID/);
});

test('text-only video takes no references and reference clips need a reference mode', () => {
  assert.equal(normalize({ source: 'text' }).source, 'text');
  assert.throws(() => normalize({ source: 'text', references: [image] }), /no references/);
  assert.throws(() => normalize({ source: 'text', first_frame: image }), /no first or last frame/);
  assert.throws(() => normalize({}), /1 to 9 staged reference/);
  assert.throws(() => normalize({ source: 'bogus', references: [image] }), /Choose reference/);
});

test('reference videos and audio are limited, typed and optional alongside images', () => {
  const request = normalize({
    references: [image],
    reference_videos: [clip],
    reference_audios: [sound],
    use_clip_audio: true,
  });
  assert.deepEqual(request.reference_videos, [clip]);
  assert.deepEqual(request.reference_audios, [sound]);
  assert.equal(request.use_clip_audio, true);
  // A clip alone is a valid reference set.
  assert.deepEqual(normalize({ references: [], reference_audios: [sound] }).references, []);
  assert.throws(
    () => normalize({ references: [image], reference_videos: [sound] }),
    /reference video/,
  );
  assert.throws(
    () => normalize({ references: [image], reference_audios: [clip] }),
    /reference audio/,
  );
  assert.throws(
    () => normalize({ references: [image], reference_videos: [clip, clip, clip, clip] }),
    /at most 3/,
  );
  assert.throws(
    () => normalize({ references: [image], use_clip_audio: true }),
    /needs at least one reference video/,
  );
});

test('steps, guidance, turbo and the other options are validated and stay out when default', () => {
  assert.throws(() => normalize({ references: [image], steps: 4 }), /Invalid video steps/);
  const turbo = normalize({ references: [image], turbo: true });
  assert.equal(turbo.steps, 4);
  assert.equal(turbo.turbo, true);
  assert.equal(normalize({ references: [image], turbo: true, steps: 8 }).steps, 8);
  assert.throws(() => normalize({ references: [image], turbo: true, steps: 12 }), /4 or 8/);
  assert.throws(() => normalize({ references: [image], turbo: true, cfg_scale: 2 }), /unguided/);
  const guided = normalize({
    references: [image],
    cfg_scale: 2.5,
    negative_prompt: '  blurry  ',
  });
  assert.equal(guided.cfg_scale, 2.5);
  assert.equal(guided.negative_prompt, 'blurry');
  assert.equal(normalize({ references: [image], cfg_scale: 1 }).cfg_scale, undefined);
  for (const bad of [
    { negative_prompt: 'blurry' },
    { cfg_scale: 7 },
    { cfg_scale: 1.05 },
    { cfg_scale: 'a' },
    { cfg_scale: 2, negative_prompt: 'x'.repeat(4001) },
  ]) {
    assert.throws(
      () => normalize({ references: [image], ...bad }),
      /guidance/i,
      JSON.stringify(bad),
    );
  }
  const options = normalize({
    references: [image],
    sampler: 'res_multistep',
    scheduler: 'beta',
    max_vram: 12,
    reference_detail: 'max',
    resolution: 'large',
    aspect: 'cinema',
    also_mp4: true,
  });
  assert.deepEqual(
    {
      sampler: options.sampler,
      scheduler: options.scheduler,
      max_vram: options.max_vram,
      reference_detail: options.reference_detail,
      resolution: options.resolution,
      aspect: options.aspect,
      also_mp4: options.also_mp4,
    },
    {
      sampler: 'res_multistep',
      scheduler: 'beta',
      max_vram: 12,
      reference_detail: 'max',
      resolution: 'large',
      aspect: 'cinema',
      also_mp4: true,
    },
  );
  for (const bad of [
    { sampler: 'ddim' },
    { scheduler: 'karras' },
    { max_vram: 2 },
    { max_vram: 30 },
    { max_vram: 6.5 },
    { reference_detail: 'huge' },
    { also_mp4: 'yes' },
    { resolution: 'ultra' },
    { aspect: 'tall' },
  ]) {
    assert.throws(() => normalize({ references: [image], ...bad }), undefined, JSON.stringify(bad));
  }
});

test('warnings name the settings that cost more memory', () => {
  assert.deepEqual(videoWarnings({ aspect: 'landscape', frames: 124 }), []);
  assert.match(videoWarnings({ aspect: 'landscape', resolution: 'medium' })[0], /Larger pictures/);
  assert.match(videoWarnings({ aspect: 'landscape', resolution: 'hd' })[0], /five times/);
  assert.match(videoWarnings({ frames: 311 })[0], /longer than 10 seconds/);
  assert.match(videoWarnings({ cfg_scale: 2 })[0], /twice/);
  assert.match(videoWarnings({ reference_videos: [clip] })[0], /Reference clips/);
});

// ----------------------------------------------------------------- launcher arguments
async function inputRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-inputs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'job1', 'video-1'), { recursive: true });
  for (let n = 0; n < 5; n++) {
    await fs.writeFile(path.join(dir, 'job1', 'video-1', `0000${n}.png`), 'x');
  }
  await fs.writeFile(path.join(dir, 'job1', 'audio-1.wav'), 'x');
  await fs.writeFile(path.join(dir, 'job1', 'video-audio-1.wav'), 'x');
  const loras = path.join(dir, 'loras');
  await fs.mkdir(loras);
  await fs.writeFile(path.join(loras, `${TURBO_ADAPTER}.safetensors`), 'x');
  return { dir, env: { FORGE_H3_INPUT_ROOT: dir, FORGE_H3_LORA_DIR: loras } };
}
const baseArgs = () => [
  '-p',
  'a scene',
  '--cfg-scale',
  '1',
  '--steps',
  '12',
  '-W',
  '608',
  '-H',
  '352',
  '--video-frames',
  '124',
  '--rng',
  'cpu',
  '--max-vram',
  '6',
  '-o',
  'out.webm',
  '--ref-image',
  'r1.png',
  '--ref-image',
  'r2.png',
];
const forgeBody = (forge, images = ['data:image/png;base64,AA==']) => ({
  prompt: 'a scene',
  images,
  forge: {
    version: 1,
    width: 608,
    height: 352,
    frames: 124,
    steps: 12,
    images: 'references',
    ...forge,
  },
});

test('a request without Forge options leaves the renderer arguments alone', () => {
  const args = baseArgs();
  const body = { prompt: 'x' };
  assert.equal(h3Args.check(body, {}), null);
  assert.equal(h3Args.extend(args, body, {}, {}), null);
  assert.deepEqual(args, baseArgs());
});

test('first and last frames become --init-img and --end-img and drop the reference images', async (t) => {
  const { env } = await inputRoot(t);
  const body = forgeBody({ images: 'frames', width: 736, height: 416 }, ['a', 'b']);
  assert.equal(h3Args.check(body, env), null);
  const args = baseArgs();
  assert.equal(h3Args.extend(args, body, { refs: ['f0.png', 'f1.png'] }, env), null);
  assert.equal(args.includes('--ref-image'), false);
  assert.deepEqual(args.slice(args.indexOf('--init-img'), args.indexOf('--init-img') + 2), [
    '--init-img',
    'f0.png',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--end-img'), args.indexOf('--end-img') + 2), [
    '--end-img',
    'f1.png',
  ]);
  assert.equal(args[args.indexOf('-W') + 1], '736');
  assert.equal(args[args.indexOf('-H') + 1], '416');
  // With one image only the first frame is set.
  const single = forgeBody({ images: 'frames' }, ['a']);
  assert.equal(h3Args.check(single, env), null);
  const oneArgs = baseArgs();
  h3Args.extend(oneArgs, single, { refs: ['f0.png'] }, env);
  assert.equal(oneArgs.includes('--end-img'), false);
  assert.equal(oneArgs.includes('--init-img'), true);
  // A third image, or clips next to frames, is refused before H3 starts a job.
  assert.match(h3Args.check(forgeBody({ images: 'frames' }, ['a', 'b', 'c']), env), /one or two/);
  assert.match(
    h3Args.check(forgeBody({ images: 'frames', ref_audios: ['job1/audio-1.wav'] }, ['a']), env),
    /cannot be combined/,
  );
});

test('reference clips, sizes, durations and guidance are written as sd-cli arguments', async (t) => {
  const { dir, env } = await inputRoot(t);
  const body = forgeBody({
    images: 'none',
    width: 960,
    height: 544,
    frames: 311,
    steps: 20,
    ref_videos: ['job1/video-1'],
    ref_video_audios: ['job1/video-audio-1.wav'],
    ref_audios: ['job1/audio-1.wav'],
    cfg_scale: 2,
    negative_prompt: 'blurry',
    sampler: 'res_multistep',
    scheduler: 'beta',
    max_vram: 12,
    reference_detail: 'max',
  });
  assert.equal(h3Args.check(body, env), null);
  const args = baseArgs();
  assert.equal(h3Args.extend(args, body, { refs: ['r1.png'] }, env), null);
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(args.includes('--ref-image'), false);
  assert.equal(value('-W'), '960');
  assert.equal(value('--video-frames'), '311');
  assert.equal(value('--steps'), '20');
  assert.equal(value('--ref-video'), path.join(dir, 'job1', 'video-1'));
  assert.equal(value('--ref-video-audio'), path.join(dir, 'job1', 'video-audio-1.wav'));
  assert.equal(value('--ref-audio'), path.join(dir, 'job1', 'audio-1.wav'));
  assert.equal(value('--cfg-scale'), '2');
  assert.equal(value('-n'), 'blurry');
  assert.equal(value('--batched-cfg'), 'off');
  assert.equal(value('--sampling-method'), 'res_multistep');
  assert.equal(value('--scheduler'), 'beta');
  assert.equal(value('--max-vram'), '12');
  assert.equal(value('--ref-image-args'), 'ref_image_size=max');
  assert.equal(args.filter((item) => item === '--cfg-scale').length, 1);
});

test('the turbo adapter adds the LoRA tag to the prompt and its folder', async (t) => {
  const { env } = await inputRoot(t);
  const body = forgeBody({ steps: 4, turbo: TURBO_ADAPTER });
  assert.equal(h3Args.check(body, env), null);
  const args = baseArgs();
  h3Args.extend(args, body, { refs: [] }, env);
  assert.equal(args[1], `a scene <lora:${TURBO_ADAPTER}:1>`);
  assert.equal(args[args.indexOf('--lora-model-dir') + 1], env.FORGE_H3_LORA_DIR);
  assert.equal(args[args.indexOf('--steps') + 1], '4');
  assert.match(
    h3Args.check(forgeBody({ turbo: TURBO_ADAPTER }), {
      FORGE_H3_LORA_DIR: path.join(os.tmpdir(), 'none'),
    }),
    /turbo adapter file is missing/,
  );
  assert.match(h3Args.check(forgeBody({ turbo: 'other' }), env), /turbo adapter/);
});

test('the launcher refuses unsafe or malformed Forge options before H3 creates a job', async (t) => {
  const { env } = await inputRoot(t);
  const bad = [
    [{ width: 600 }, /multiple of 32/],
    [{ width: 1568, height: 1568 }, /multiple of 32/],
    [{ frames: 100 }, /17 x n/],
    [{ frames: 400 }, /17 x n/],
    [{ steps: 0 }, /step count/],
    [{ images: 'many' }, /Unknown image mode/],
    [{ ref_videos: ['../outside'] }, /prepared reference video is missing/],
    [{ ref_videos: ['job1/missing'] }, /prepared reference video is missing/],
    [{ ref_videos: ['job1/video-1', 'job1/video-1', 'job1/video-1', 'job1/video-1'] }, /At most 3/],
    [{ ref_audios: ['C:/Windows/system.ini'] }, /prepared reference audio is missing/],
    [{ ref_audios: ['job1/../../secret.wav'] }, /prepared reference audio is missing/],
    [{ ref_video_audios: ['job1/audio-1.wav'] }, /its own sound file/],
    [{ cfg_scale: 9 }, /Guidance/],
    [{ negative_prompt: 'x' }, /negative prompt needs guidance/],
    [{ sampler: 'ddim' }, /Unsupported sampler/],
    [{ scheduler: 'karras' }, /Unsupported scheduler/],
    [{ max_vram: 2 }, /GPU memory budget/],
    [{ reference_detail: 'huge' }, /Unsupported reference detail/],
    [{ version: 2 }, /Unsupported Forge render options/],
  ];
  for (const [forge, pattern] of bad) {
    assert.match(h3Args.check(forgeBody(forge), env), pattern, JSON.stringify(forge));
  }
  assert.match(h3Args.check({ forge: 'text' }, env), /Unsupported/);
  assert.match(h3Args.check({ forge: [] }, env), /Unsupported/);
});

// ----------------------------------------------------------------- real bootstrap, fake H3
const marker = "for(const f of refs)args.push('--ref-image',f);";
const upstream = (
  withLoop = true,
) => `const http=require('http');const fs=require('fs');const path=require('path');
const ROOT = __dirname, PORT = 8274;
let job=null;
const json=(res,data,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
function body(req){return new Promise((resolve,reject)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}});req.on('error',reject)})}
async function generate(req,res){
 if(job && job.state==='running')return json(res,{error:'A video is already generating.'},409);
 let b;try{b=await body(req)}catch(e){return json(res,{error:e.message},400)}
 const id='test';const dir=path.join(ROOT,'uploads',String(Date.now()));fs.mkdirSync(dir,{recursive:true});
 const refs=(b.images||[]).map((x,i)=>path.join(dir,'reference-'+(i+1)+'.png'));
 const args=['-p',b.prompt||'x','--cfg-scale','1','--steps','12','-W','608','-H','352','--video-frames','124','--rng','cpu','--max-vram','6','-o','y']; ${withLoop ? marker : ''}
 return json(res,{id,args,dirExists:fs.existsSync(dir)});
}
http.createServer((req,res)=>{if(req.method==='POST'&&req.url==='/api/generate')return generate(req,res);if(req.url==='/api/status')return json(res,{ready:true});return json(res,{},404)}).listen(PORT,'127.0.0.1');`;

async function startLauncher(t, source, env = {}) {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-ext-'));
  await fs.writeFile(path.join(dir, 'server.js'), source);
  const child = spawn(process.execPath, [path.join(root, 'runtime', 'h3_bootstrap.cjs'), dir], {
    env: { ...process.env, FORGE_H3_INTERNAL_PORT: String(port), ...env },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    child.kill();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const base = `http://127.0.0.1:${port}`;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) {
        return base;
      }
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Launcher did not start.');
}
const post = (base, body) =>
  fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the launcher answers the capability probe and rewrites arguments end to end', async (t) => {
  const { dir, env } = await inputRoot(t);
  const base = await startLauncher(t, upstream(), env);
  const capabilities = await (await fetch(`${base}/api/forge-capabilities`)).json();
  assert.equal(capabilities.forgeExtensions, 1);
  assert.ok(capabilities.features.includes('frames'));
  const plain = await (await post(base, { prompt: 'p', images: ['a'] })).json();
  assert.deepEqual(plain.args.slice(plain.args.indexOf('-W'), plain.args.indexOf('-W') + 2), [
    '-W',
    '608',
  ]);
  const response = await post(
    base,
    forgeBody({ images: 'frames', width: 736, height: 416, ref_videos: undefined }, ['a', 'b']),
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.args[result.args.indexOf('-W') + 1], '736');
  assert.ok(result.args.includes('--init-img') && result.args.includes('--end-img'));
  assert.equal(result.args.includes('--ref-image'), false);
  const bad = await post(base, forgeBody({ ref_audios: ['../../etc/passwd'] }));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /prepared reference audio is missing/);
  // Fixture sanity check: the valid clip exists, so the rejection below is about the path.
  assert.equal(existsSync(path.join(dir, 'job1', 'audio-1.wav')), true);
});

test('a changed H3 argument loop refuses the new options instead of ignoring them', async (t) => {
  const base = await startLauncher(t, upstream(false));
  const plain = await post(base, { prompt: 'p', images: ['a'] });
  assert.equal(plain.status, 200);
  const response = await post(base, forgeBody({ images: 'none' }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot apply the new video options/);
});

test('first-frame and text modes use an FL2VA checkpoint when one is installed', async (t) => {
  const { env } = await inputRoot(t);
  const models = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-models-'));
  t.after(() => fs.rm(models, { recursive: true, force: true }));
  const withModels = { ...env, FORGE_H3_MODEL_ROOT: models };
  const run = (forge, images = ['a']) => {
    const body = forgeBody(forge, images);
    assert.equal(h3Args.check(body, withModels), null);
    const args = baseArgs();
    h3Args.extend(args, body, { refs: ['f0.png'] });
    return args;
  };
  // Nothing installed: the Ref2VA weights H3 already passes are left alone.
  assert.equal(run({ images: 'frames' }).includes('--diffusion-model'), false);
  await fs.writeFile(path.join(models, 'minimax_h3_ref2va_pruned-Q4_K_M.gguf'), 'x');
  await fs.writeFile(path.join(models, 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors'), 'x');
  let args = run({ images: 'frames' });
  assert.ok(args[args.indexOf('--diffusion-model') + 1].endsWith('fp8_scaled.safetensors'));
  await fs.writeFile(path.join(models, 'minimax_h3_fl2va_pruned-Q4_K_M.gguf'), 'x');
  args = run({ images: 'none' });
  assert.ok(args[args.indexOf('--diffusion-model') + 1].endsWith('fl2va_pruned-Q4_K_M.gguf'));
  // Reference mode, and reference clips without pictures, always keep the Ref2VA model.
  assert.equal(run({ images: 'references' }).includes('--diffusion-model'), false);
  assert.equal(
    run({ images: 'none', ref_audios: ['job1/audio-1.wav'] }).includes('--diffusion-model'),
    false,
  );
});

test('video options name the field that is out of range', () => {
  const reference = [image];
  assert.throws(
    () => normalize({ references: reference, sampler: 'dpm' }),
    /Choose a sampler from euler, res_multistep/,
  );
  assert.throws(
    () => normalize({ references: reference, scheduler: 'karras' }),
    /Choose a scheduler from simple, beta, discrete/,
  );
  assert.throws(
    () => normalize({ references: reference, reference_detail: 'low' }),
    /Reference detail must be match or max/,
  );
  assert.throws(
    () => normalize({ references: reference, max_vram: 3 }),
    /GPU memory budget must be a whole number of GiB from 4 to 24/,
  );
});
