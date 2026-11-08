import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { audioPayload } from '../src/audio-payload.js';
import { JobQueue, estimateFromJobs } from '../runtime/jobs.js';
import { rerunRequest } from '../src/rerun-request.js';

test('audio settings map to the supported worker parameters and respect overrides', () => {
  const music = audioPayload(
    'music',
    'project',
    {
      prompt: 'ambient',
      second: '[Instrumental]',
      options: ['30 seconds', 'Melody'],
      seed: '42',
      musicDuration: '47.5',
      musicSteps: '24',
      musicGuidance: '3.2',
      musicNegative: 'drums',
      musicTitle: 'Forest',
    },
    {
      seedGenerator: () => {
        throw Error('Must not generate a seed');
      },
    },
  );
  assert.deepEqual(music.request, {
    style: 'ambient',
    lyrics: '[Instrumental]',
    duration_seconds: 47.5,
    cot: 'melody',
    seed: 42,
    ode_steps: 24,
    title: 'Forest',
    negative: 'drums',
    cfg_scale: 3.2,
  });
  const random = audioPayload(
    'music',
    'project',
    {
      prompt: 'ambient',
      second: '[Instrumental]',
      options: ['15 seconds', 'Full arrangement'],
      seed: '',
    },
    { seedGenerator: () => 1234 },
  );
  assert.equal(random.request.seed, 1234);
  assert.equal(random.request.ode_steps, 32);
  assert.equal(random.request.cfg_scale, null);
  const sfx = audioPayload('sfx', 'project', {
    prompt: 'door creak',
    options: ['10 seconds', 'Draft · 4 steps'],
    soundDuration: '2.5',
    soundSteps: '11',
    seed: '',
  });
  assert.deepEqual(sfx.request, { prompt: 'door creak', duration: 2.5, steps: 11, seed: -1 });
  const voice = audioPayload(
    'voices',
    'project',
    {
      prompt: 'hello',
      second: 'whisper',
      options: ['Vivian', 'English'],
      voiceMaxTokens: '768',
    },
    { seedGenerator: () => 5 },
  );
  assert.deepEqual(voice.request, {
    text: 'hello',
    speaker: 'Vivian',
    language: 'English',
    instruct: 'whisper',
    max_new_tokens: 768,
    seed: 5,
  });
  // Sampling and an explicit seed are sent only when entered.
  const sampled = audioPayload('voices', 'project', {
    prompt: 'hello',
    options: ['Ryan', 'Auto'],
    seed: '12',
    voiceTemperature: '0.7',
    voiceTopP: '0.9',
    voiceTopK: '30',
    voiceRepetition: '1.1',
    voiceMaxTokens: '4096',
  });
  assert.deepEqual(sampled.request, {
    text: 'hello',
    speaker: 'Ryan',
    language: 'Auto',
    instruct: '',
    max_new_tokens: 4096,
    seed: 12,
    temperature: 0.7,
    top_p: 0.9,
    top_k: 30,
    repetition_penalty: 1.1,
  });
  for (const [field, value, pattern] of [
    ['voiceMaxTokens', '4097', /token limit/],
    ['voiceTemperature', '0', /temperature/],
    ['voiceTopP', '1.5', /top-p/],
    ['voiceTopK', '1.5', /top-k/],
    ['voiceRepetition', '0.9', /repetition/],
    ['seed', '-1', /Seed/],
  ]) {
    assert.throws(
      () => audioPayload('voices', 'p', { prompt: 'x', options: [], [field]: value }),
      pattern,
    );
  }
});

test('audio settings reject invalid custom values before queueing', () => {
  const music = { prompt: 'x', second: 'x', options: ['15 seconds', 'Off'], seed: '1' };
  assert.throws(() => audioPayload('music', 'p', { ...music, musicGuidance: '20.1' }), /Guidance/);
  assert.throws(() => audioPayload('music', 'p', { ...music, musicSteps: '2.2' }), /Music steps/);
  assert.throws(() => audioPayload('music', 'p', { ...music, seed: '-1' }), /Seed/);
  assert.throws(
    () =>
      audioPayload('sfx', 'p', {
        prompt: 'x',
        options: ['5 seconds', 'Balanced · 8 steps'],
        soundDuration: '381',
      }),
    /Sound duration/,
  );
  assert.throws(
    () => audioPayload('voices', 'p', { prompt: 'x', options: [], voiceMaxTokens: '63' }),
    /Voice token limit/,
  );
});

test('reruns preserve fine-tuning while changing only prompt and requested seed', () => {
  const music = {
    type: 'music',
    request: {
      style: 'ambient',
      lyrics: '[Instrumental]',
      duration_seconds: 47.5,
      cot: 'melody',
      seed: 42,
      ode_steps: 24,
      title: 'Forest',
      negative: 'drums',
      cfg_scale: 3.2,
    },
  };
  assert.deepEqual(rerunRequest(music, 'orchestral', { seed: 77 }), {
    ...music.request,
    style: 'orchestral',
    seed: 77,
  });
  assert.equal(music.request.style, 'ambient');
  const extension = {
    type: 'music',
    request: {
      operation: 'extend',
      source: 'music/forge-a.flac',
      style: 'ambient',
      add_seconds: 12,
      seed: 3,
    },
  };
  // The style of an extension comes from the track it continues, so a refine cannot replace it.
  assert.equal(rerunRequest(extension, 'something else', { seed: 4 }).style, 'ambient');
  assert.equal(rerunRequest(extension, 'something else', { seed: 4 }).seed, 4);
  assert.equal(music.request.seed, 42);
  const sound = {
    type: 'sfx',
    request: { prompt: 'door creak', duration: 2.5, steps: 11, seed: 8 },
  };
  assert.deepEqual(rerunRequest(sound, 'door slam', { seed: 99 }), {
    ...sound.request,
    prompt: 'door slam',
    seed: 99,
  });
  const voice = {
    type: 'voices',
    request: {
      text: 'Hello',
      speaker: 'Vivian',
      language: 'English',
      instruct: 'whisper',
      max_new_tokens: 768,
    },
  };
  assert.deepEqual(rerunRequest(voice, 'Goodbye', { seed: 99 }), {
    ...voice.request,
    text: 'Goodbye',
    seed: 99,
  });
  assert.deepEqual(rerunRequest(voice, 'Goodbye'), { ...voice.request, text: 'Goodbye' });
  const image = {
    type: 'images',
    request: { prompt: 'forest', references: ['first.png'], width: 1024 },
  };
  assert.deepEqual(rerunRequest(image, 'forest at night', { reference: 'second.png' }).references, [
    'first.png',
    'second.png',
  ]);
  assert.deepEqual(image.request.references, ['first.png']);
});

test('music timing history distinguishes single and dual guidance branches', () => {
  const request = { duration_seconds: 15, cot: 'full', ode_steps: 32, cfg_scale: 1 };
  const job = {
    type: 'music',
    status: 'completed',
    request,
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:30Z',
  };
  assert.equal(estimateFromJobs([job], { type: 'music', request }).sampleCount, 1);
  assert.equal(
    estimateFromJobs([job], { type: 'music', request: { ...request, cfg_scale: 2 } }).sampleCount,
    0,
  );
  assert.equal(
    estimateFromJobs([job], { type: 'music', request: { ...request, cfg_scale: null } })
      .sampleCount,
    1,
  );
});

test('fine-tuned audio inputs persist in the durable queue and invalid guidance is rejected', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-audio-settings-'));
  const projects = path.join(dir, 'projects'),
    folder = path.join(projects, 'game'),
    projectId = randomUUID();
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const state = path.join(dir, 'runtime');
  let queue = new JobQueue({ directory: state, projects, autoStart: false });
  t.after(() => queue?.stop());
  const requests = [
    audioPayload('music', projectId, {
      prompt: 'ambient',
      second: '[Instrumental]',
      options: ['30 seconds', 'Full arrangement'],
      seed: '42',
      musicDuration: '42.5',
      musicSteps: '16',
      musicGuidance: '2',
      musicNegative: 'brass',
    }),
    audioPayload('sfx', projectId, {
      prompt: 'a twig snaps',
      options: ['5 seconds', 'Balanced · 8 steps'],
      seed: '123',
      soundDuration: '2.5',
      soundSteps: '9',
    }),
    audioPayload('voices', projectId, {
      prompt: 'Hello',
      second: 'soft',
      options: ['Ryan', 'English'],
      voiceMaxTokens: '384',
      seed: '77',
    }),
  ];
  const jobs = requests.map((value) => queue.enqueue(value));
  assert.throws(
    () => queue.enqueue({ ...requests[0], request: { ...requests[0].request, cfg_scale: 21 } }),
    /CFG scale/,
  );
  queue.stop();
  queue = new JobQueue({ directory: state, projects, autoStart: false });
  for (let i = 0; i < jobs.length; i++) {
    assert.deepEqual(queue.get(jobs[i].id).request, requests[i].request);
  }
});

test('the queue picks a voice seed, keeps entered sampling, and rejects out-of-range values', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-voice-'));
  const projects = path.join(dir, 'projects'),
    folder = path.join(projects, 'game'),
    projectId = randomUUID();
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({ directory: path.join(dir, 'runtime'), projects, autoStart: false });
  t.after(async () => {
    queue.stop();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const base = { text: 'Hello', speaker: 'Ryan', language: 'English', instruct: '' };
  const plain = queue.enqueue({ type: 'voices', projectId, request: base }).request;
  assert.ok(Number.isSafeInteger(plain.seed) && plain.seed >= 0, 'a seed is chosen and recorded');
  for (const key of ['temperature', 'top_p', 'top_k', 'repetition_penalty']) {
    assert.equal(Object.hasOwn(plain, key), false);
  }
  const tuned = queue.enqueue({
    type: 'voices',
    projectId,
    request: { ...base, max_new_tokens: 4096, seed: 9, temperature: 0.7, top_k: 20 },
  }).request;
  assert.deepEqual(
    [tuned.seed, tuned.max_new_tokens, tuned.temperature, tuned.top_k],
    [9, 4096, 0.7, 20],
  );
  for (const bad of [
    { max_new_tokens: 4097 },
    { seed: -1 },
    { temperature: 0 },
    { top_p: 1.1 },
    { top_k: 1.5 },
    { repetition_penalty: 0.5 },
  ]) {
    assert.throws(
      () => queue.enqueue({ type: 'voices', projectId, request: { ...base, ...bad } }),
      /Invalid voice/,
    );
  }
});

test('music score and sampling overrides are sent only when entered and are validated', () => {
  const base = {
    prompt: 'ambient',
    second: '[Verse]\nla',
    options: ['15 seconds', 'Full arrangement'],
    seed: '7',
  };
  const plain = audioPayload('music', 'p', base).request;
  for (const key of ['abc', 'temperature', 'top_p', 'top_k', 'repetition_penalty']) {
    assert.equal(Object.hasOwn(plain, key), false, `${key} must be absent when not entered`);
  }
  const tuned = audioPayload('music', 'p', {
    ...base,
    musicScore: '  X:1\nK:C\nCDEF|  ',
    musicTemperature: '0.8',
    musicTopP: '0.9',
    musicTopK: '50',
    musicRepetition: '1.1',
  }).request;
  assert.equal(tuned.abc, 'X:1\nK:C\nCDEF|');
  assert.deepEqual(
    [tuned.temperature, tuned.top_p, tuned.top_k, tuned.repetition_penalty],
    [0.8, 0.9, 50, 1.1],
  );
  const off = { ...base, options: ['15 seconds', 'Off'] };
  assert.throws(() => audioPayload('music', 'p', { ...off, musicScore: 'X:1' }), /Planning/);
  assert.equal(audioPayload('music', 'p', { ...off, musicScore: '   ' }).request.cot, 'off');
  assert.throws(
    () => audioPayload('music', 'p', { ...base, musicTemperature: '5.1' }),
    /Temperature/,
  );
  assert.throws(() => audioPayload('music', 'p', { ...base, musicTopP: '0' }), /Top-p/);
  assert.throws(() => audioPayload('music', 'p', { ...base, musicTopK: '2.5' }), /Top-k/);
  assert.throws(
    () => audioPayload('music', 'p', { ...base, musicRepetition: '0.9' }),
    /Repetition penalty/,
  );
});

test('the queue validates music score and sampling and picks a random seed when none is given', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-music-extra-'));
  const projects = path.join(dir, 'projects'),
    folder = path.join(projects, 'game'),
    projectId = randomUUID();
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const queue = new JobQueue({ directory: path.join(dir, 'runtime'), projects, autoStart: false });
  t.after(async () => {
    queue.stop();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const request = { style: 'ambient', lyrics: '[Instrumental]' };
  const enqueue = (extra, base = request) =>
    queue.enqueue({ type: 'music', projectId, request: { ...base, ...extra } });
  const random = queue.get(enqueue({}).id).request;
  assert.ok(Number.isSafeInteger(random.seed) && random.seed >= 0 && random.seed <= 2147483647);
  assert.equal(Object.hasOwn(random, 'abc'), false);
  const tuned = queue.get(
    enqueue({ abc: ' X:1\nK:C\nCDEF| ', temperature: 0.7, top_p: 0.9, top_k: 40, seed: 5 }).id,
  ).request;
  assert.equal(tuned.abc, 'X:1\nK:C\nCDEF|');
  assert.deepEqual([tuned.temperature, tuned.top_p, tuned.top_k, tuned.seed], [0.7, 0.9, 40, 5]);
  assert.throws(() => enqueue({ abc: 'X:1', cot: 'off' }), /Planning/);
  assert.throws(() => enqueue({ abc: 'x'.repeat(20001) }), /Score/);
  assert.throws(() => enqueue({ temperature: 6 }), /sampling/);
  assert.throws(() => enqueue({ top_p: 0 }), /sampling/);
  assert.throws(() => enqueue({ top_k: 1.5 }), /sampling/);
  assert.throws(() => enqueue({ repetition_penalty: 0.5 }), /sampling/);
});

test('music submissions use the compact endpoint unless a score or sampling is set', async () => {
  const { submission } = await import('../runtime/music-request.js');
  const request = {
    style: 'ambient',
    lyrics: '[Instrumental]',
    duration_seconds: 8,
    seed: 3,
    cot: 'full',
    title: '',
    ode_steps: 16,
    negative: '',
    cfg_scale: null,
  };
  assert.deepEqual(submission(request), { path: '/api/v1/jobs', payload: request });
  const advanced = submission({ ...request, abc: 'X:1', temperature: 0.8 });
  assert.equal(advanced.path, '/api/jobs');
  assert.equal(advanced.payload.abc, 'X:1');
  assert.equal(Object.hasOwn(advanced.payload, 'duration_seconds'), false);
  assert.deepEqual(advanced.payload.semantic_sampling, {
    temperature: 0.8,
    min_tokens: 0,
    max_tokens: 200,
  });
  assert.equal(advanced.payload.ode_steps, 16);
});
