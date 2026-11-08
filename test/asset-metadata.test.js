import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DB_NAME,
  LIMITS,
  backfillAssetMeta,
  buildJobMetadata,
  buildProvenanceMetadata,
  deleteAssetMeta,
  moveAssetMeta,
  readAssetMeta,
  readMetaIndex,
  recordConversion,
  recordJobOutput,
  recordSavedText,
  redact,
  resetBackfillCache,
  searchAssetMeta,
  upsertAssetMeta,
  validateAssetPath,
} from '../runtime/asset-metadata.js';

async function project(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-meta-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  resetBackfillCache();
  return folder;
}
const jobId = () => randomUUID();
function job(type, request, extra = {}) {
  const id = extra.id || jobId();
  return {
    id,
    type,
    projectId: extra.projectId || randomUUID(),
    status: 'completed',
    request,
    output: extra.output || `images/forge-${id}.png`,
    startedAt: '2026-11-07T10:00:00.000Z',
    finishedAt: '2026-11-07T10:00:42.000Z',
    ...extra,
  };
}

test('image jobs record model, prompt, negative prompt, settings and staged references', () => {
  const source = job('images', {
    prompt: 'A bronze compass',
    negative_prompt: 'blurry',
    true_cfg_scale: 3,
    width: 1024,
    height: 576,
    num_inference_steps: 30,
    seed: 77,
    references: [`${randomUUID()}.png`],
  });
  const meta = buildJobMetadata(source, source.output, {
    referenceSizes: { [source.request.references[0]]: 2048 },
  });
  assert.equal(meta.model.name, 'Qwen Image 2.1');
  assert.equal(meta.model.id, 'images');
  assert.equal(meta.prompt, 'A bronze compass');
  assert.equal(meta.negative, 'blurry');
  assert.equal(meta.seed, 77);
  assert.deepEqual(
    Object.keys(meta.settings).sort(),
    ['height', 'num_inference_steps', 'seed', 'true_cfg_scale', 'width'].sort(),
  );
  assert.equal(meta.references.length, 1);
  assert.equal(meta.references[0].mime, 'image/png');
  assert.equal(meta.references[0].size, 2048);
  assert.equal(meta.startedAt, '2026-11-07T10:00:00.000Z');
});

test('each job type maps its prompt fields and engine to the right model', () => {
  const music = buildJobMetadata(
    job('music', {
      style: 'orchestral',
      lyrics: '[verse] hi',
      negative: 'drums',
      title: 'Theme',
      seed: 5,
      cot: 'full',
    }),
    'music/forge-a.flac',
  );
  assert.equal(music.model.name, 'YuE2');
  assert.deepEqual(
    [music.prompt, music.secondary, music.negative, music.title],
    ['orchestral', '[verse] hi', 'drums', 'Theme'],
  );
  const voice = buildJobMetadata(
    job('voices', { text: 'Hello', instruct: 'whisper', speaker: 'Ryan', language: 'English' }),
    'voices/forge-a.wav',
  );
  assert.equal(voice.model.name, 'Qwen3-TTS');
  assert.equal(voice.prompt, 'Hello');
  assert.equal(voice.secondary, 'whisper');
  assert.equal(voice.settings.speaker, 'Ryan');
  const shape = buildJobMetadata(
    job('3d', {
      model: 'hunyuan',
      references: [`${randomUUID()}.png`],
      seed: 1,
      steps: 30,
      resolution: 128,
      texture: true,
      texture_size: 2048,
    }),
    '3d/forge-a.glb',
  );
  assert.equal(shape.model.name, 'Hunyuan3D 2.1');
  assert.match(shape.model.version, /texture/);
  assert.equal(shape.prompt, null);
  assert.equal(shape.settings.texture, true);
  const trellis = buildJobMetadata(
    job('trellis', {
      model: 'trellis',
      references: [`${randomUUID()}.png`],
      seed: 42,
      steps: 12,
      texture_size: 1024,
    }),
    '3d/forge-b.glb',
  );
  assert.equal(trellis.model.name, 'TRELLIS.2');
  const world = buildJobMetadata(
    job('world', {
      model: 'hy-world',
      mode: 'image',
      prompt: '',
      output: 'splat',
      resolution: 518,
      references: [`${randomUUID()}.webp`],
      seed: 42,
      steps: 50,
    }),
    '3d/forge-c.ply',
  );
  assert.equal(world.model.name, 'HY-World 2.0');
  const bricks = buildJobMetadata(
    job('motion-bricks', {
      pose: `${randomUUID()}.bvh`,
      context_frame: 0,
      target_frame: 20,
      min_tokens: 8,
      max_tokens: 14,
    }),
    'motion/forge-d.bvh',
  );
  assert.equal(bricks.model.name, 'NVIDIA MotionBricks');
  assert.equal(bricks.references[0].mime, 'text/plain');
  assert.equal(bricks.settings.target_frame, 20);
  const sam = buildJobMetadata(
    job('segmentation', {
      prompt: 'compass',
      references: [`${randomUUID()}.png`],
      output: 'mask',
      confidence: 0.5,
    }),
    'masks/forge-e.png',
  );
  assert.equal(sam.model.name, 'SAM 3.1');
  assert.equal(sam.kind, 'mask');
});

test('secrets, long text, control characters and nested settings are sanitised', () => {
  assert.equal(redact('use hf_abcdefghijklmnop now'), 'use [REDACTED] now');
  const meta = buildJobMetadata(
    job('sfx', {
      prompt: `door\u0000 Authorization: Bearer abc123 ${'x'.repeat(LIMITS.prompt + 50)}`,
      duration: 5,
      steps: 8,
      seed: -1,
      api_key: 'sk-secretsecretsecret',
      endpoint: 'http://127.0.0.1:1/x',
      nested: { a: 1 },
      local_path: 'C:\\Users\\me',
    }),
    'sfx/forge-a.wav',
  );
  assert.ok(meta.prompt.length <= LIMITS.prompt);
  assert.ok(!meta.prompt.includes('\u0000'));
  assert.ok(!meta.prompt.includes('abc123'));
  assert.deepEqual(Object.keys(meta.settings).sort(), ['duration', 'seed', 'steps']);
  assert.equal(meta.seed, null, 'a random (-1) seed is not recorded as a seed');
  const json = JSON.stringify(meta);
  assert.ok(!json.includes('sk-secret') && !json.includes('127.0.0.1'));
  assert.throws(() => buildProvenanceMetadata({ path: '../x.png' }), /Invalid asset path/);
});

test('asset paths follow the same rules as staged references', () => {
  for (const bad of [
    '',
    '../a.png',
    'a/../b.png',
    '/abs.png',
    'a\\b.png',
    'C:/a.png',
    '.hidden/a.png',
    'a/.x.png',
    'a//b.png',
  ]) {
    assert.throws(() => validateAssetPath(bad), /Invalid asset path/, bad);
  }
  assert.equal(validateAssetPath('images/forge-a.png'), 'images/forge-a.png');
});

test('records round trip through the project database, which is a hidden single file', async (t) => {
  const folder = await project(t);
  const source = job('images', {
    prompt: 'castle',
    width: 1024,
    height: 1024,
    num_inference_steps: 40,
    seed: 3,
  });
  assert.equal(recordJobOutput(source, folder), true);
  const names = await fs.readdir(folder);
  assert.deepEqual(
    names,
    [DB_NAME],
    'only the hidden database is created (no -wal/-shm companions)',
  );
  const meta = readAssetMeta(folder, source.output);
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.source, 'job');
  assert.equal(meta.backfilled, false);
  assert.equal(meta.job.id, source.id);
  assert.equal(meta.model.name, 'Qwen Image 2.1');
  assert.equal(meta.model.version, 'Qwen-Image-2.1');
  assert.equal(meta.prompt.text, 'castle');
  assert.equal(meta.timing.seconds, 42);
  assert.equal(meta.tool.name, 'Forge');
  assert.equal(readAssetMeta(folder, 'images/missing.png'), null);
  // The database is created lazily: reading a project that has none creates nothing.
  const empty = await project(t);
  assert.equal(readAssetMeta(empty, 'images/a.png'), null);
  assert.deepEqual(await fs.readdir(empty), []);
});

test('recording a job never throws even when the project folder is unusable', async (t) => {
  const folder = await project(t);
  const logged = [];
  const result = recordJobOutput(job('images', { prompt: 'x' }), path.join(folder, 'missing'), {
    logger: (message) => logged.push(message),
  });
  assert.equal(result, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /operation=asset_meta_record/);
  assert.ok(!logged[0].includes(folder), 'log lines carry codes only, not paths');
  assert.equal(recordJobOutput({ id: 'x' }, folder), false);
});

test('index, upsert replace, move, delete and parameterised search', async (t) => {
  const folder = await project(t);
  const a = job('images', {
    prompt: 'A weathered potion shop',
    width: 1024,
    height: 576,
    num_inference_steps: 30,
  });
  const b = job(
    'sfx',
    { prompt: 'sword impact with echo', duration: 5, steps: 8, seed: 9 },
    { output: 'sfx/forge-b.wav' },
  );
  recordJobOutput(a, folder);
  recordJobOutput(b, folder);
  const index = readMetaIndex(folder);
  assert.equal(index[a.output].model, 'Qwen Image 2.1');
  assert.equal(index[b.output].seed, 9);
  assert.deepEqual(searchAssetMeta(folder, 'potion'), [a.output]);
  assert.deepEqual(searchAssetMeta(folder, 'pot'), [a.output], 'prefix match');
  assert.deepEqual(
    searchAssetMeta(folder, 'stable audio'),
    [b.output],
    'model names are searchable',
  );
  assert.deepEqual(searchAssetMeta(folder, `'; DROP TABLE asset_meta; --`), []);
  assert.deepEqual(searchAssetMeta(folder, '   '), []);
  assert.equal(readAssetMeta(folder, a.output).prompt.text, 'A weathered potion shop');

  recordJobOutput({ ...a, request: { ...a.request, prompt: 'A burned tavern' } }, folder);
  assert.deepEqual(searchAssetMeta(folder, 'potion'), []);
  assert.deepEqual(searchAssetMeta(folder, 'tavern'), [a.output]);

  const child = buildProvenanceMetadata({
    path: 'images/child.png',
    source: 'conversion',
    parentPath: a.output,
  });
  upsertAssetMeta(folder, child);
  assert.equal(moveAssetMeta(folder, a.output, 'images/renamed.png'), true);
  assert.equal(readAssetMeta(folder, a.output), null);
  assert.equal(readAssetMeta(folder, 'images/renamed.png').prompt.text, 'A burned tavern');
  assert.equal(readAssetMeta(folder, 'images/child.png').parent.path, 'images/renamed.png');
  assert.deepEqual(searchAssetMeta(folder, 'tavern'), ['images/renamed.png']);
  assert.equal(moveAssetMeta(folder, 'images/none.png', 'images/other.png'), false);

  assert.equal(deleteAssetMeta(folder, ['images/renamed.png']), 1);
  assert.deepEqual(searchAssetMeta(folder, 'tavern'), []);
  assert.equal(deleteAssetMeta(folder, []), 0);
});

test('saved text and conversions record provenance; conversions inherit the parent', async (t) => {
  const folder = await project(t);
  recordSavedText(folder, 'text/chat-1.txt', 'chat', {
    model: { name: 'qwen3.8-27b', id: 'compatible' },
    prompt: 'Describe a tavern',
    secondary: 'You are helpful',
    settings: { temperature: 0.7, max_tokens: 2048, apiKey: 'nope', nested: { a: 1 } },
  });
  const chat = readAssetMeta(folder, 'text/chat-1.txt');
  assert.equal(chat.source, 'saved-text');
  assert.equal(chat.type, 'chat');
  assert.equal(chat.model.name, 'qwen3.8-27b');
  assert.equal(chat.prompt.secondary, 'You are helpful');
  assert.deepEqual(chat.settings, { temperature: 0.7, max_tokens: 2048 });
  recordSavedText(folder, 'text/transcript-1.txt', 'transcript', null);
  assert.equal(readAssetMeta(folder, 'text/transcript-1.txt').model.name, 'Nemotron ASR');
  recordSavedText(folder, 'text/decision-1.json', 'decision', { prompt: 'gate scene' });
  assert.equal(readAssetMeta(folder, 'text/decision-1.json').model.name, 'Mammoth-1');

  const source = job('images', {
    prompt: 'castle',
    width: 1024,
    height: 576,
    num_inference_steps: 30,
    seed: 4,
  });
  recordJobOutput(source, folder);
  assert.equal(
    recordConversion(folder, source.output, 'images/forge-x-converted.webp', { format: 'webp' }),
    true,
  );
  const copy = readAssetMeta(folder, 'images/forge-x-converted.webp');
  assert.equal(copy.source, 'conversion');
  assert.equal(copy.parent.path, source.output);
  assert.equal(copy.model.name, 'Qwen Image 2.1');
  assert.equal(copy.prompt.text, 'castle');
  assert.equal(copy.settings.conversion_format, 'webp');
  assert.equal(copy.job.id, source.id);
});

test('backfill recovers older assets from a jobs lookup without touching it', async (t) => {
  const folder = await project(t);
  const projectId = randomUUID();
  const image = job(
    'images',
    { prompt: 'old compass', width: 1024, height: 576, num_inference_steps: 30 },
    { projectId },
  );
  const other = job('images', { prompt: 'other project' }, { projectId: randomUUID() });
  const running = job('images', { prompt: 'still running' }, { projectId, status: 'running' });
  const lookups = [];
  const jobLookup = (ids) => {
    lookups.push(ids);
    return new Map(
      [image, other, running]
        .filter((item) => ids.includes(item.id))
        .map((item) => [item.id, item]),
    );
  };
  const base = `images/forge-${image.id}.png`;
  const assets = [
    { id: base },
    { id: `images/forge-${image.id}-converted.webp` },
    { id: `images/forge-${image.id}-converted-converted-2.png` },
    { id: 'images/renamed-by-user.png', sourceOutput: base },
    { id: `images/forge-${other.id}.png` },
    { id: `images/forge-${running.id}.png` },
    { id: 'images/hand-made.png' },
    { id: `images/forge-${randomUUID()}.png` },
  ];
  const created = backfillAssetMeta(folder, projectId, assets, { jobLookup });
  assert.equal(created, 4);
  const record = readAssetMeta(folder, base);
  assert.equal(record.source, 'job');
  assert.equal(record.backfilled, true);
  assert.equal(record.prompt.text, 'old compass');
  assert.equal(record.model.name, 'Qwen Image 2.1');
  const converted = readAssetMeta(folder, `images/forge-${image.id}-converted.webp`);
  assert.equal(converted.source, 'conversion');
  assert.equal(converted.parent.path, base);
  assert.equal(converted.prompt.text, 'old compass');
  const chained = readAssetMeta(folder, `images/forge-${image.id}-converted-converted-2.png`);
  assert.equal(chained.parent.path, `images/forge-${image.id}-converted.webp`);
  assert.equal(readAssetMeta(folder, 'images/renamed-by-user.png').prompt.text, 'old compass');
  assert.equal(
    readAssetMeta(folder, `images/forge-${other.id}.png`),
    null,
    'other projects are never used',
  );
  assert.equal(
    readAssetMeta(folder, `images/forge-${running.id}.png`),
    null,
    'unfinished jobs are skipped',
  );
  assert.equal(readAssetMeta(folder, 'images/hand-made.png'), null);

  // Existing rows are never overwritten, and a second pass is a no-op.
  recordJobOutput({ ...image, request: { ...image.request, prompt: 'edited' } }, folder);
  lookups.length = 0;
  assert.equal(backfillAssetMeta(folder, projectId, assets, { jobLookup }), 0);
  assert.equal(readAssetMeta(folder, base).prompt.text, 'edited');
  assert.ok(lookups.every((ids) => !ids.includes(image.id)));
});

test('a failing jobs lookup never throws out of backfill', async (t) => {
  const folder = await project(t);
  const logged = [];
  const result = backfillAssetMeta(folder, randomUUID(), [{ id: `images/forge-${jobId()}.png` }], {
    jobLookup: () => {
      throw Object.assign(Error('locked'), { code: 'SQLITE_BUSY' });
    },
    logger: (message) => logged.push(message),
  });
  assert.equal(result, 0);
  assert.match(logged[0], /asset_meta_backfill/);
});

test('a corrupt database is quarantined and replaced instead of failing', async (t) => {
  const folder = await project(t);
  await fs.writeFile(path.join(folder, DB_NAME), 'this is not a sqlite database at all'.repeat(40));
  const logged = [];
  const source = job(
    'sfx',
    { prompt: 'click', duration: 1, steps: 8, seed: 1 },
    { output: 'sfx/forge-c.wav' },
  );
  assert.equal(
    recordJobOutput(source, folder, { logger: (message) => logged.push(message) }),
    true,
  );
  assert.equal(readAssetMeta(folder, source.output).prompt.text, 'click');
  const names = await fs.readdir(folder);
  assert.ok(
    names.some((name) => /^\.forge-meta\.corrupt-\d+\.sqlite$/.test(name)),
    names.join(),
  );
  assert.ok(logged.some((line) => line.includes('asset_meta_quarantine')));
});

test('a database from a newer Forge is left untouched', async (t) => {
  const folder = await project(t);
  const file = path.join(folder, DB_NAME);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE asset_meta (path TEXT); PRAGMA user_version=99');
  db.close();
  const before = await fs.readFile(file);
  assert.equal(
    recordJobOutput(job('sfx', { prompt: 'x', duration: 1, steps: 8, seed: 1 }), folder, {
      logger: () => {},
    }),
    false,
  );
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await fs.readdir(folder)).sort(), [DB_NAME]);
});

test('the database cannot be a symbolic link', async (t) => {
  const folder = await project(t);
  const target = path.join(folder, 'elsewhere.sqlite');
  await fs.writeFile(target, '');
  try {
    await fs.symlink(target, path.join(folder, DB_NAME));
  } catch {
    t.skip('symbolic links are not available here');
    return;
  }
  assert.equal(
    recordJobOutput(job('sfx', { prompt: 'x', duration: 1, steps: 8, seed: 1 }), folder, {
      logger: () => {},
    }),
    false,
  );
  assert.equal((await fs.readFile(target)).length, 0);
});

test('prompts up to the field limit are stored whole', async (t) => {
  const folder = await project(t);
  const prompt = 'long '.repeat(3999) + 'end'; // under 20,000 characters
  const source = job(
    'music',
    {
      style: prompt,
      lyrics: 'la',
      seed: 1,
      duration_seconds: 15,
      cot: 'full',
      ode_steps: 32,
      title: '',
      negative: '',
      cfg_scale: null,
    },
    { output: 'music/forge-l.flac' },
  );
  recordJobOutput(source, folder);
  assert.equal(readAssetMeta(folder, source.output).prompt.text.length, prompt.length);
  assert.equal(
    readMetaIndex(folder)[source.output].prompt.length,
    200,
    'listing carries a short preview only',
  );
});
