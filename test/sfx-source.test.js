import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobQueue } from '../runtime/jobs.js';
import { stageProjectClip } from '../runtime/clips.js';
import { isAudioSourceId, readAudioSource } from '../runtime/references.js';
import { normalizeSoundSource, requireAudioInput, soundPayload } from '../runtime/sfx-request.js';
import { audioPayload, soundSourceFields } from '../src/audio-payload.js';
import { draftJob, reusePlan } from '../src/generation-details.js';
import { changeAmountProblem, regionProblems } from '../src/sound-source.js';

const sfxJobPath = fileURLToPath(new URL('../runtime/sfx-job.js', import.meta.url));
const sourceId = '11111111-2222-3333-4444-555555555555.wav';

// A minimal RIFF/WAVE header plus samples: enough for the type check, not a playable sound.
const wav = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WAVEfmt '),
  Buffer.alloc(40, 1),
]);

test('source sound options are all-or-nothing and depend on the chosen mode', () => {
  assert.deepEqual(normalizeSoundSource({}, 5), {});
  assert.deepEqual(normalizeSoundSource({ source_audio: sourceId, edit_mode: 'variation' }, 5), {
    source_audio: sourceId,
    edit_mode: 'variation',
    init_noise_level: 0.9,
  });
  assert.deepEqual(
    normalizeSoundSource(
      { source_audio: sourceId, edit_mode: 'variation', init_noise_level: 0.3 },
      5,
    ),
    { source_audio: sourceId, edit_mode: 'variation', init_noise_level: 0.3 },
  );
  assert.deepEqual(
    normalizeSoundSource(
      { source_audio: sourceId, edit_mode: 'replace', inpaint_start: 1, inpaint_end: 2.5 },
      5,
    ),
    { source_audio: sourceId, edit_mode: 'replace', inpaint_start: 1, inpaint_end: 2.5 },
  );
  assert.deepEqual(normalizeSoundSource({ source_audio: sourceId, edit_mode: 'continue' }, 5), {
    source_audio: sourceId,
    edit_mode: 'continue',
  });
  const rejected = [
    [{ edit_mode: 'variation' }, /need a staged source/],
    [{ init_noise_level: 0.5 }, /need a staged source/],
    [{ source_audio: '../x.wav', edit_mode: 'variation' }, /staged source sound ID/],
    [{ source_audio: sourceId }, /Choose variation/],
    [{ source_audio: sourceId, edit_mode: 'loop' }, /Choose variation/],
    [{ source_audio: sourceId, edit_mode: 'variation', init_noise_level: 0 }, /0.05 to 1/],
    [{ source_audio: sourceId, edit_mode: 'variation', init_noise_level: 1.5 }, /0.05 to 1/],
    [{ source_audio: sourceId, edit_mode: 'variation', inpaint_start: 1 }, /no replaced region/],
    [{ source_audio: sourceId, edit_mode: 'replace' }, /start and end/],
    [
      { source_audio: sourceId, edit_mode: 'replace', inpaint_start: 3, inpaint_end: 2 },
      /start and end/,
    ],
    [
      { source_audio: sourceId, edit_mode: 'replace', inpaint_start: 1, inpaint_end: 9 },
      /start and end/,
    ],
    [
      {
        source_audio: sourceId,
        edit_mode: 'replace',
        inpaint_start: 1,
        inpaint_end: 2,
        init_noise_level: 0.5,
      },
      /only to a variation/,
    ],
    [{ source_audio: sourceId, edit_mode: 'continue', inpaint_end: 3 }, /no replaced region/],
  ];
  for (const [request, pattern] of rejected) {
    assert.throws(() => normalizeSoundSource(request, 5), pattern, JSON.stringify(request));
  }
  assert.equal(isAudioSourceId(sourceId), true);
  assert.equal(isAudioSourceId('11111111-2222-3333-4444-555555555555.opus'), false);
});

test('a staged source sound is a read-only snapshot that is rechecked when the job runs', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sfx-stage-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, 'sfx'));
  await fs.writeFile(path.join(project, 'sfx', 'hit.wav'), wav);
  const staged = await stageProjectClip(project, 'sfx/hit.wav');
  assert.equal(isAudioSourceId(staged.id), true);
  await fs.writeFile(path.join(project, 'sfx', 'hit.wav'), 'edited after staging');
  assert.deepEqual(await readAudioSource(project, staged.id), wav, 'later edits do not leak in');
  await assert.rejects(readAudioSource(project, 'not-an-id.wav'), /staged source sound ID/);
  await assert.rejects(readAudioSource(project, sourceId), /ENOENT|missing/);
  await fs.writeFile(path.join(project, '.forge-inputs', staged.id), 'tampered');
  await assert.rejects(readAudioSource(project, staged.id), /WAV, FLAC, MP3, or Ogg|between 44/);
});

test('the queue stores source-sound options only when they are used', async (t) => {
  const holder = { queue: null };
  t.after(() => holder.queue?.stop());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sfx-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Fixture', 'sfx'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Fixture', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  const queue = new JobQueue({ directory: path.join(root, 'state'), projects, autoStart: false });
  holder.queue = queue;
  const plain = queue.enqueue({ type: 'sfx', projectId, request: { prompt: 'a door' } });
  for (const key of ['source_audio', 'edit_mode', 'init_noise_level', 'inpaint_start']) {
    assert.equal(Object.hasOwn(plain.request, key), false);
  }
  const replaced = queue.enqueue({
    type: 'sfx',
    projectId,
    request: {
      prompt: 'a door',
      duration: 6,
      source_audio: sourceId,
      edit_mode: 'replace',
      inpaint_start: 2,
      inpaint_end: 4,
    },
  });
  assert.equal(replaced.request.edit_mode, 'replace');
  assert.equal(replaced.request.inpaint_end, 4);
  assert.throws(
    () =>
      queue.enqueue({
        type: 'sfx',
        projectId,
        request: { prompt: 'a door', source_audio: sourceId, edit_mode: 'replace' },
      }),
    /start and end/,
  );
  // Timing history for edits never mixes with plain renders.
  const estimate = queue.estimate({
    type: 'sfx',
    projectId,
    request: { prompt: 'a door', source_audio: sourceId, edit_mode: 'continue', duration: 9 },
  });
  assert.equal(estimate.available, false);
});

test('the browser sends a source sound only when one is chosen', () => {
  const draft = { prompt: 'a door', options: ['5 seconds', 'Balanced · 8 steps'] };
  const request = (extra) => audioPayload('sfx', randomUUID(), { ...draft, ...extra }).request;
  assert.equal(Object.hasOwn(request({}), 'source_audio'), false);
  assert.deepEqual(
    { ...request({ soundSourceId: sourceId, soundInitLevel: '0.4' }) },
    {
      prompt: 'a door',
      duration: 5,
      source_audio: sourceId,
      edit_mode: 'variation',
      init_noise_level: 0.4,
      steps: 8,
      seed: -1,
    },
  );
  assert.deepEqual(soundSourceFields({ soundSourceId: sourceId, soundEditMode: 'continue' }, 5), {
    source_audio: sourceId,
    edit_mode: 'continue',
  });
  assert.deepEqual(
    soundSourceFields(
      {
        soundSourceId: sourceId,
        soundEditMode: 'replace',
        soundRegionStart: '1',
        soundRegionEnd: '2',
      },
      5,
    ),
    { source_audio: sourceId, edit_mode: 'replace', inpaint_start: 1, inpaint_end: 2 },
  );
  assert.throws(
    () =>
      soundSourceFields(
        {
          soundSourceId: sourceId,
          soundEditMode: 'replace',
          soundRegionStart: '3',
          soundRegionEnd: '9',
        },
        5,
      ),
    /fit inside the sound duration/,
  );
  assert.throws(
    () => soundSourceFields({ soundSourceId: sourceId, soundInitLevel: '2' }, 5),
    /Change amount/,
  );
});

test('Lab support for source sounds is read from its status', async () => {
  const lab = (status) => async () => ({ ok: true, json: async () => status });
  await requireAudioInput('http://lab', lab({ audio_input: true }));
  await assert.rejects(
    requireAudioInput('http://lab', lab({ loaded: true })),
    /does not accept source/,
  );
  await assert.rejects(
    requireAudioInput('http://lab', lab({ audio_input: 'yes' })),
    /does not accept/,
  );
});

async function runSfxWorker(t, { request, lab }) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/session') {
        res.end(JSON.stringify({ session: 'fixture-session' }));
      } else if (req.url === '/api/status') {
        res.end(JSON.stringify(lab));
      } else if (req.url === '/api/generate') {
        res.statusCode = 202;
        res.end(JSON.stringify({ job_id: 'lab-job' }));
      } else if (req.url === '/api/jobs/lab-job') {
        res.end(JSON.stringify({ status: 'completed', result: { url: '/audio/result.wav' } }));
      } else if (req.url === '/audio/result.wav') {
        res.setHeader('Content-Type', 'audio/wav');
        res.end('edited wav bytes');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sfx-worker-'));
  await fs.mkdir(path.join(directory, 'sfx'));
  await fs.writeFile(path.join(directory, 'sfx', 'hit.wav'), wav);
  const staged = await stageProjectClip(directory, 'sfx/hit.wav');
  const child = fork(sfxJobPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.connected) {
      child.disconnect();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const done = new Promise((resolve) => {
    child.on('message', (message) => {
      if (['complete', 'failed', 'interrupted'].includes(message.type)) {
        resolve(message);
      }
    });
  });
  child.send({
    job: { id: 'sfx-source-job', request: request(staged.id) },
    projectFolder: directory,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  return { requests, outcome: await done, staged, directory };
}

test('the sound worker sends the staged source to a Lab that accepts it and saves the result', async (t) => {
  const { requests, outcome, staged, directory } = await runSfxWorker(t, {
    lab: { audio_input: true, loaded: true },
    request: (id) => ({
      prompt: 'a door',
      duration: 6,
      steps: 8,
      seed: 3,
      source_audio: id,
      edit_mode: 'replace',
      inpaint_start: 2,
      inpaint_end: 4,
    }),
  });
  assert.equal(outcome.type, 'complete');
  assert.equal(await fs.readFile(path.join(directory, outcome.output), 'utf8'), 'edited wav bytes');
  const generate = requests.find((item) => item.url === '/api/generate');
  assert.equal(generate.body.source_audio, wav.toString('base64'));
  assert.deepEqual(
    { ...generate.body, source_audio: '<base64>' },
    {
      prompt: 'a door',
      duration: 6,
      steps: 8,
      seed: 3,
      source_audio: '<base64>',
      edit_mode: 'replace',
      inpaint_start: 2,
      inpaint_end: 4,
    },
  );
  assert.equal(isAudioSourceId(staged.id), true);
});

test('the sound worker refuses to submit a source to a Lab that would ignore it', async (t) => {
  const { requests, outcome } = await runSfxWorker(t, {
    lab: { loaded: true },
    request: (id) => ({ prompt: 'a door', duration: 6, steps: 8, seed: 3, source_audio: id }),
  });
  assert.equal(outcome.type, 'failed');
  assert.match(outcome.error, /does not accept source sounds/);
  assert.equal(
    requests.some((item) => item.url === '/api/generate'),
    false,
  );
});

test('the sound worker fails before submitting when the staged source is gone', async (t) => {
  const { requests, outcome } = await runSfxWorker(t, {
    lab: { audio_input: true },
    request: () => ({ prompt: 'a door', duration: 6, steps: 8, seed: 3, source_audio: sourceId }),
  });
  assert.equal(outcome.type, 'failed');
  assert.equal(
    requests.some((item) => item.url === '/api/generate'),
    false,
  );
});

test('a missing staged source reports what to do instead of a local path', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-sfx-missing-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.forge-inputs'));
  await assert.rejects(
    soundPayload({ prompt: 'a door', source_audio: sourceId }, project),
    (error) => /no longer available/.test(error.message) && !/ENOENT|forge-sfx/.test(error.message),
  );
  await assert.rejects(stageProjectClip(project, 'sfx/gone.wav'), (error) => {
    return /not in the project/.test(error.message) && !/ENOENT|forge-sfx/.test(error.message);
  });
});

test('an unreachable Lab status check is reported without a raw network error', async () => {
  await assert.rejects(
    requireAudioInput('http://127.0.0.1:1', async () => {
      throw TypeError('fetch failed');
    }),
    /Could not check whether Stable Audio Lab accepts source sounds/,
  );
});

test('the page flags a change amount or region that cannot be queued', () => {
  assert.equal(changeAmountProblem(''), '');
  assert.equal(changeAmountProblem('0.05'), '');
  assert.equal(changeAmountProblem('1'), '');
  assert.match(changeAmountProblem('1.5'), /0\.05 to 1/);
  assert.match(changeAmountProblem('0.01'), /0\.05 to 1/);
  const draft = { options: ['10 seconds', 'Balanced · 8 steps'] };
  assert.deepEqual(regionProblems({ ...draft, soundRegionStart: '2', soundRegionEnd: '3.5' }), {
    start: '',
    end: '',
  });
  assert.match(
    regionProblems({ ...draft, soundRegionStart: '3', soundRegionEnd: '2' }).end,
    /after the start/,
  );
  assert.match(
    regionProblems({ ...draft, soundRegionStart: '1', soundRegionEnd: '11' }).end,
    /within the sound duration \(10 s\)/,
  );
  // A custom duration replaces the preset, as it does in the queued request.
  assert.equal(
    regionProblems({ ...draft, soundDuration: '12', soundRegionStart: '1', soundRegionEnd: '11' })
      .end,
    '',
  );
  assert.match(regionProblems({ ...draft, soundRegionStart: '-1' }).start, /0 or more/);
});

test('reusing a derived sound drops a stale source and restores the edit settings', () => {
  const meta = (request) => ({
    job: { id: randomUUID(), type: 'sfx' },
    prompt: { text: request.prompt },
    seed: request.seed,
    settings: request,
  });
  const replaced = draftJob(
    reusePlan(
      meta({
        prompt: 'a door',
        duration: 5,
        steps: 8,
        seed: 3,
        source_audio: sourceId,
        edit_mode: 'replace',
        inpaint_start: 1,
        inpaint_end: 2.5,
      }),
    ),
    randomUUID(),
  ).draftSnapshot;
  assert.equal(replaced.soundSourceId, '');
  assert.equal(replaced.soundSourceName, '');
  assert.equal(replaced.soundEditMode, 'replace');
  assert.deepEqual([replaced.soundRegionStart, replaced.soundRegionEnd], ['1', '2.5']);
  const plain = draftJob(
    reusePlan(meta({ prompt: 'a door', duration: 5, steps: 8, seed: 3 })),
    randomUUID(),
  ).draftSnapshot;
  assert.equal(plain.soundSourceId, '');
  assert.equal(plain.soundEditMode, 'variation');
  assert.equal(plain.soundInitLevel, '');
});
