import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { JobQueue } from '../runtime/jobs.js';
import { checkpointLoadedFor, TTS_CHECKPOINTS } from '../runtime/voice-modes.js';
import {
  checkpointInstalled,
  createTtsLoader,
  createTtsPreparation,
} from '../runtime/tts-preparation.js';
import { stageProjectClip } from '../runtime/clips.js';
import { buildJobMetadata } from '../runtime/asset-metadata.js';
import { audioPayload } from '../src/audio-payload.js';
import {
  cloneReferenceLengthProblem,
  readClipDurationSeconds,
  voiceModeFieldErrors,
} from '../src/voice-modes.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';

const ttsJobPath = fileURLToPath(new URL('../runtime/tts-job.js', import.meta.url));
// A 64-byte stand-in for a WAV file: the RIFF/WAVE header is what the staging checks read.
const wav = Buffer.alloc(64, 1);
wav.write('RIFF', 0, 'ascii');
wav.write('WAVE', 8, 'ascii');

async function makeQueue(t) {
  const holder = { queue: null };
  t.after(() => holder.queue?.stop());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-voice-modes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'Fixture'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'Fixture', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  holder.queue = new JobQueue({ directory: path.join(root, 'state'), projects, autoStart: false });
  return { queue: holder.queue, projectId };
}

// A stand-in for fetch: GET /api/status answers with `status`, and model load posts answer with
// `loadStatus`. Every call is recorded so a test can assert that no load request was sent.
function fakeWorker(status, { loadStatus = 202 } = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${new URL(url).pathname}`;
    calls.push({ key, body: options.body ? JSON.parse(options.body) : null });
    if (key === 'GET /api/status') {
      return { ok: true, status: 200, json: async () => status };
    }
    return { ok: loadStatus < 400, status: loadStatus, json: async () => ({}) };
  };
  return { fetcher, calls };
}

const healthyGpu = { devices: [{ index: 0, name: 'NVIDIA GPU', freeMiB: 40 * 1024 }] };
const baseStatus = {
  engine: 'forge-qwen3-tts-v1',
  phase: 'ready',
  loaded: true,
  loaded_variant: 'custom_voice',
  model_downloaded: true,
  variants: { custom_voice: true, base: true, voice_design: true },
};

test('design and clone requests keep only their own fields and need consent and a transcript', async (t) => {
  const { queue, projectId } = await makeQueue(t);
  const design = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello',
      mode: 'design',
      voice_description: '  A warm narrator.  ',
      speaker: 'Aiden',
    },
  });
  assert.equal(design.request.mode, 'design');
  assert.equal(design.request.voice_description, 'A warm narrator.');
  for (const key of ['speaker', 'instruct', 'reference_audio', 'reference_text']) {
    assert.equal(Object.hasOwn(design.request, key), false, `${key} is not stored for design`);
  }
  assert.throws(
    () => queue.enqueue({ type: 'voices', projectId, request: { text: 'Hi', mode: 'design' } }),
    /Describe the voice/,
  );

  const reference = `${randomUUID()}.wav`;
  const clone = {
    text: 'Hello again',
    mode: 'clone',
    reference_audio: reference,
    reference_text: ' The words in the clip. ',
    reference_consent: true,
  };
  const cloned = queue.enqueue({ type: 'voices', projectId, request: clone });
  assert.deepEqual(
    {
      mode: cloned.request.mode,
      reference_audio: cloned.request.reference_audio,
      reference_text: cloned.request.reference_text,
    },
    { mode: 'clone', reference_audio: reference, reference_text: 'The words in the clip.' },
  );
  assert.equal(Object.hasOwn(cloned.request, 'reference_consent'), false);
  assert.throws(
    () =>
      queue.enqueue({ type: 'voices', projectId, request: { ...clone, reference_consent: false } }),
    /right to use this voice/,
  );
  assert.throws(
    () =>
      queue.enqueue({
        type: 'voices',
        projectId,
        request: { ...clone, reference_audio: '../x.wav' },
      }),
    /WAV, FLAC or MP3/,
  );
  assert.throws(
    () => queue.enqueue({ type: 'voices', projectId, request: { ...clone, reference_text: '  ' } }),
    /exact words/,
  );
  assert.throws(
    () => queue.enqueue({ type: 'voices', projectId, request: { ...clone, mode: 'whisper' } }),
    /preset voice, clone a voice, or design/,
  );
});

test('preset voice requests keep their original shape and timing profile', async (t) => {
  const { queue, projectId } = await makeQueue(t);
  const preset = queue.enqueue({
    type: 'voices',
    projectId,
    request: { text: 'Hello there', speaker: 'Serena', instruct: 'Gently.' },
  });
  assert.equal(preset.request.speaker, 'Serena');
  assert.equal(preset.request.instruct, 'Gently.');
  assert.equal(Object.hasOwn(preset.request, 'mode'), false);
});

test('a loaded checkpoint matches a request only when its variant is the one the mode needs', () => {
  assert.equal(
    checkpointLoadedFor({ loaded: true }, { text: 'x' }),
    true,
    'old workers are preset',
  );
  assert.equal(checkpointLoadedFor({ loaded: true }, { mode: 'clone' }), false);
  assert.equal(
    checkpointLoadedFor({ loaded: true, loaded_variant: 'base' }, { mode: 'clone' }),
    true,
  );
  assert.equal(
    checkpointLoadedFor({ loaded: true, loaded_variant: 'base' }, { mode: 'design' }),
    false,
  );
  assert.equal(checkpointLoadedFor({ loaded: false }, { mode: 'clone' }), false);
});

test('the checkpoint loader refuses a missing checkpoint before any load request', async () => {
  const status = {
    ...baseStatus,
    loaded: false,
    phase: 'idle',
    variants: { custom_voice: true, base: false, voice_design: true },
  };
  const { fetcher, calls } = fakeWorker(status);
  const loadTts = createTtsLoader({
    hardware: async () => healthyGpu,
    services: async () => [],
    baseUrl: 'http://127.0.0.1:8281',
    fetcher,
  });
  const result = await loadTts('base');
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'model_missing');
  assert.match(result.body.message, /Qwen3-TTS-12Hz-1\.7B-Base/);
  assert.equal(
    calls.some((call) => call.key === 'POST /api/model/load'),
    false,
  );
});

test('switching checkpoints posts the wanted variant so the worker unloads the resident one', async () => {
  const { fetcher, calls } = fakeWorker(baseStatus);
  const loadTts = createTtsLoader({
    hardware: async () => healthyGpu,
    services: async () => [],
    baseUrl: 'http://127.0.0.1:8281',
    fetcher,
  });
  const swap = await loadTts('voice_design');
  assert.equal(swap.status, 202);
  assert.equal(swap.body.code, 'load_requested');
  assert.equal(swap.body.variant, 'voice_design');
  assert.match(swap.body.message, /VoiceDesign/);
  const post = calls.find((call) => call.key === 'POST /api/model/load');
  assert.deepEqual(post.body, { variant: 'voice_design' });

  const same = await loadTts('custom_voice');
  assert.equal(same.body.code, 'already_loaded');
  const anyLoaded = await loadTts();
  assert.equal(anyLoaded.body.code, 'already_loaded', 'an unspecified load never swaps');
});

test('an older worker that cannot report checkpoints is asked to restart for a clone or design', async () => {
  const oldStatus = {
    engine: 'forge-qwen3-tts-v1',
    loaded: true,
    phase: 'ready',
    model_downloaded: true,
  };
  const { fetcher, calls } = fakeWorker(oldStatus);
  const loadTts = createTtsLoader({
    hardware: async () => healthyGpu,
    services: async () => [],
    baseUrl: 'http://127.0.0.1:8281',
    fetcher,
  });
  const result = await loadTts('base');
  assert.equal(result.body.code, 'worker_restart_required');
  assert.equal(
    calls.some((call) => call.key === 'POST /api/model/load'),
    false,
  );
});

test('admission uses the checkpoint budget and refuses short GPU memory', async () => {
  const { fetcher, calls } = fakeWorker({ ...baseStatus, loaded: false, phase: 'idle' });
  const loadTts = createTtsLoader({
    hardware: async () => ({ devices: [{ index: 0, name: 'GPU', freeMiB: 4 * 1024 }] }),
    services: async () => [],
    baseUrl: 'http://127.0.0.1:8281',
    fetcher,
  });
  const result = await loadTts('base');
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'insufficient_gpu_memory');
  assert.equal(result.body.requiredMiB, TTS_CHECKPOINTS.base.budgetMiB + 2 * 1024);
  assert.equal(
    calls.some((call) => call.key === 'POST /api/model/load'),
    false,
  );
});

test('preparation names the missing checkpoint and loads the variant the job needs', async () => {
  assert.equal(checkpointInstalled({ variants: { base: false } }, 'base'), false);
  assert.equal(checkpointInstalled({ model_downloaded: true }, 'custom_voice'), true);
  const loads = [];
  const prepareTts = createTtsPreparation({
    startEngine: async () => ({ status: 'started' }),
    loadModel: async (variant) => {
      loads.push(variant);
      return { status: 202, body: { code: 'load_requested', message: 'requested' } };
    },
  });
  const missing = await prepareTts({
    health: { ...baseStatus, variants: { custom_voice: true, base: false, voice_design: true } },
    reachable: true,
    claimLoad: () => true,
    variant: 'base',
  });
  assert.equal(missing.status, 'needs_attention');
  assert.match(missing.error, /Qwen3-TTS-12Hz-1\.7B-Base/);
  assert.deepEqual(loads, []);

  const loading = await prepareTts({
    health: { ...baseStatus, loaded_variant: 'custom_voice' },
    reachable: true,
    claimLoad: () => true,
    variant: 'base',
  });
  assert.equal(loading.status, 'waiting_engine');
  assert.deepEqual(loads, ['base']);
});

test('the voice job sends a staged clone clip as base64 and submits nothing when the clip is gone', async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    requests.push({
      url: req.url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/generate') {
      res.end(JSON.stringify({ id: 'a'.repeat(32) }));
    } else if (req.url === `/api/jobs/${'a'.repeat(32)}`) {
      res.end(JSON.stringify({ status: 'completed', truncated: false }));
    } else if (req.url === `/api/jobs/${'a'.repeat(32)}/audio`) {
      res.setHeader('Content-Type', 'audio/wav');
      res.end('cloned wav bytes');
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-clone-worker-'));
  await fs.mkdir(path.join(directory, 'voices'));
  await fs.writeFile(path.join(directory, 'voices', 'ref.wav'), wav);
  const staged = await stageProjectClip(directory, 'voices/ref.wav');
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const run = async (request) => {
    requests.length = 0;
    const child = fork(ttsJobPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const done = new Promise((resolve) => {
      child.on('message', (message) => {
        if (['complete', 'failed', 'interrupted'].includes(message.type)) {
          resolve(message);
        }
      });
    });
    child.send({
      job: { id: 'clone-job', request },
      projectFolder: directory,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });
    const outcome = await done;
    child.disconnect?.();
    return { outcome, requests: [...requests] };
  };

  const clone = {
    mode: 'clone',
    text: 'Hello there',
    language: 'English',
    max_new_tokens: 1024,
    seed: 7,
    reference_audio: staged.id,
    reference_text: 'The words in the clip.',
  };
  const sent = await run(clone);
  assert.equal(sent.outcome.type, 'complete');
  const generate = sent.requests.find((item) => item.url === '/api/generate').body;
  assert.equal(generate.reference_audio_base64, wav.toString('base64'));
  assert.equal(Object.hasOwn(generate, 'reference_audio'), false);
  assert.equal(generate.reference_text, 'The words in the clip.');
  assert.equal(generate.mode, 'clone');

  const gone = await run({ ...clone, reference_audio: '11111111-2222-3333-4444-555555555555.wav' });
  assert.equal(gone.outcome.type, 'failed');
  assert.equal(
    gone.requests.some((item) => item.url === '/api/generate'),
    false,
    'nothing is submitted when the staged clip is missing',
  );
  assert.match(gone.outcome.error, /no longer available/);
  assert.doesNotMatch(gone.outcome.error, /ENOENT|[A-Za-z]:[\\/]|\.forge-inputs/);
});

test('the voice payload sends mode fields only for the chosen mode', () => {
  const projectId = randomUUID();
  const seeded = () => 11;
  const design = audioPayload(
    'voices',
    projectId,
    {
      prompt: 'Hello',
      options: ['Ryan', 'English'],
      second: 'ignored',
      voiceMode: 'design',
      voiceDescription: ' Bright. ',
    },
    { seedGenerator: seeded },
  );
  assert.deepEqual(design.request.voice_description, 'Bright.');
  assert.equal(Object.hasOwn(design.request, 'speaker'), false);
  assert.equal(Object.hasOwn(design.request, 'instruct'), false);

  const clone = audioPayload(
    'voices',
    projectId,
    {
      prompt: 'Hello',
      voiceMode: 'clone',
      voiceReferenceId: `${randomUUID()}.flac`,
      voiceReferenceText: 'Transcript.',
      voiceConsent: true,
    },
    { seedGenerator: seeded },
  );
  assert.equal(clone.request.mode, 'clone');
  assert.equal(clone.request.reference_consent, true);
  assert.throws(
    () =>
      audioPayload(
        'voices',
        projectId,
        {
          prompt: 'Hello',
          voiceMode: 'clone',
          voiceReferenceId: `${randomUUID()}.wav`,
          voiceReferenceText: 'x',
        },
        { seedGenerator: seeded },
      ),
    /right to use/,
  );
  assert.throws(
    () =>
      audioPayload(
        'voices',
        projectId,
        { prompt: 'Hello', voiceMode: 'clone' },
        { seedGenerator: seeded },
      ),
    /Choose a WAV, FLAC or MP3 reference clip from the project\./,
  );

  const preset = audioPayload(
    'voices',
    projectId,
    { prompt: 'Hello', options: ['Aiden', 'English'], second: 'Calm.' },
    { seedGenerator: seeded },
  );
  assert.equal(preset.request.speaker, 'Aiden');
  assert.equal(preset.request.instruct, 'Calm.');
  assert.equal(Object.hasOwn(preset.request, 'mode'), false);
});

test('generation details record the mode, the transcript and the reference clip', async (t) => {
  const { queue, projectId } = await makeQueue(t);
  const reference = `${randomUUID()}.wav`;
  const cloned = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello',
      mode: 'clone',
      reference_audio: reference,
      reference_text: 'Reference words.',
      reference_consent: true,
    },
  });
  const job = {
    ...cloned,
    id: randomUUID(),
    status: 'completed',
    startedAt: null,
    finishedAt: null,
  };
  const record = buildJobMetadata(job, 'voices/forge-out.wav');
  assert.equal(record.settings.mode, 'clone');
  assert.equal(record.model.version, TTS_CHECKPOINTS.base.folder);
  const designed = buildJobMetadata(
    { ...job, request: { ...job.request, mode: 'design' } },
    'voices/d.wav',
  );
  assert.equal(designed.model.version, TTS_CHECKPOINTS.voice_design.folder);
  const preset = buildJobMetadata(
    { ...job, request: { text: 'Hi', speaker: 'Ryan' } },
    'voices/p.wav',
  );
  assert.equal(preset.model.version, TTS_CHECKPOINTS.custom_voice.folder);
  assert.equal(record.settings.reference_text, 'Reference words.');
  assert.equal(Object.hasOwn(record.settings, 'reference_audio'), false);
  assert.ok(
    record.references.some((entry) => entry.id === reference && /Voice reference/.test(entry.name)),
  );

  const meta = {
    type: 'voices',
    job: { type: 'voices' },
    prompt: { text: 'Hello', secondary: '' },
    seed: 5,
    settings: { ...record.settings },
  };
  const plan = reusePlan(meta);
  assert.equal(plan.draft.voiceMode, 'clone');
  assert.equal(plan.draft.voiceReferenceText, 'Reference words.');
  assert.equal(plan.draft.voiceReferenceId, '', 'the staged clip is chosen again');
  assert.equal(plan.draft.voiceReferenceName, '');
  const rows = Object.fromEntries(describeSettings(meta).map((row) => [row.key, row.value]));
  assert.equal(rows.reference_text, 'Reference words.');
});

const LENGTH_MESSAGE = 'Reference audio must be 3 to 30 seconds long.';

test('a reference clip outside 3 to 30 seconds blocks the clone payload', () => {
  const clone = (seconds) => ({
    prompt: 'Hello',
    voiceMode: 'clone',
    voiceReferenceId: `${randomUUID()}.wav`,
    voiceReferenceText: 'Transcript.',
    voiceConsent: true,
    voiceReferenceSeconds: seconds,
  });
  assert.equal(cloneReferenceLengthProblem(2.99), LENGTH_MESSAGE);
  assert.equal(cloneReferenceLengthProblem(30.01), LENGTH_MESSAGE);
  assert.equal(cloneReferenceLengthProblem(3), '');
  assert.equal(cloneReferenceLengthProblem(30), '');
  assert.equal(cloneReferenceLengthProblem(null), '', 'an unreadable clip is not blocked');
  assert.equal(cloneReferenceLengthProblem(Number.NaN), '');
  assert.throws(() => audioPayload('voices', 'p', clone(1)), { message: LENGTH_MESSAGE });
  assert.throws(() => audioPayload('voices', 'p', clone(45)), { message: LENGTH_MESSAGE });
  assert.equal(audioPayload('voices', 'p', clone(12)).request.mode, 'clone');
  assert.equal(audioPayload('voices', 'p', clone(null)).request.mode, 'clone');
});

// A stand-in for the browser Audio element and the object URL functions. The outcome decides what
// the element reports: a duration, an error, or nothing at all (a stalled read).
function stubAudio(outcome) {
  const previous = {
    Audio: globalThis.Audio,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  const revoked = [];
  class FakeAudio {
    set src(value) {
      this.source = value;
      setTimeout(() => {
        if (outcome.silent) {
          return;
        }
        if (outcome.error) {
          this.onerror?.(new Event('error'));
          return;
        }
        this.duration = outcome.duration;
        this.onloadedmetadata?.();
      }, 0);
    }
  }
  globalThis.Audio = FakeAudio;
  URL.createObjectURL = () => 'blob:forge-test-clip';
  URL.revokeObjectURL = (url) => revoked.push(url);
  return {
    revoked,
    restore() {
      globalThis.Audio = previous.Audio;
      URL.createObjectURL = previous.createObjectURL;
      URL.revokeObjectURL = previous.revokeObjectURL;
    },
  };
}

test('the clip duration is read in the browser and never blocks when unreadable', async (t) => {
  const clip = new Blob(['stand-in clip'], { type: 'audio/wav' });
  const readWith = async (outcome, options) => {
    const stub = stubAudio(outcome);
    t.after(() => stub.restore());
    const seconds = await readClipDurationSeconds(clip, options);
    return { seconds, revoked: stub.revoked };
  };

  const short = await readWith({ duration: 1.2 });
  assert.equal(short.seconds, 1.2);
  assert.equal(cloneReferenceLengthProblem(short.seconds), LENGTH_MESSAGE);
  assert.deepEqual(short.revoked, ['blob:forge-test-clip'], 'the object URL is released');

  const long = await readWith({ duration: 45 });
  assert.equal(cloneReferenceLengthProblem(long.seconds), LENGTH_MESSAGE);

  const inRange = await readWith({ duration: 7.5 });
  assert.equal(inRange.seconds, 7.5);
  assert.equal(cloneReferenceLengthProblem(inRange.seconds), '');

  assert.equal((await readWith({ duration: Number.POSITIVE_INFINITY })).seconds, null);
  assert.equal((await readWith({ error: true })).seconds, null, 'a decode error is not a verdict');
  assert.equal(
    (await readWith({ silent: true }, { timeoutMs: 5 })).seconds,
    null,
    'a stalled read times out',
  );

  const stub = stubAudio({ duration: 9 });
  t.after(() => stub.restore());
  URL.createObjectURL = () => {
    throw new Error('object URLs are unavailable');
  };
  assert.equal(await readClipDurationSeconds(clip), null, 'a browser refusal resolves to null');
});

test('voice-only cloning needs no transcript and never stores or sends one', async (t) => {
  const { queue, projectId } = await makeQueue(t);
  const reference = `${randomUUID()}.wav`;
  const voiceOnly = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello',
      mode: 'clone',
      reference_audio: reference,
      reference_consent: true,
      clone_voice_only: true,
    },
  });
  assert.equal(voiceOnly.request.clone_voice_only, true);
  assert.equal(voiceOnly.request.reference_audio, reference);
  assert.equal(Object.hasOwn(voiceOnly.request, 'reference_text'), false);

  const withTranscript = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello',
      mode: 'clone',
      reference_audio: reference,
      reference_text: 'Words that are dropped.',
      reference_consent: true,
      clone_voice_only: true,
    },
  });
  assert.equal(Object.hasOwn(withTranscript.request, 'reference_text'), false);

  // A transcript clone keeps its original shape: the flag is stored only when it is on.
  const transcriptClone = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello',
      mode: 'clone',
      reference_audio: reference,
      reference_text: 'Words in the clip.',
      reference_consent: true,
      clone_voice_only: false,
    },
  });
  assert.equal(Object.hasOwn(transcriptClone.request, 'clone_voice_only'), false);
  assert.equal(transcriptClone.request.reference_text, 'Words in the clip.');

  const base = {
    text: 'Hello',
    mode: 'clone',
    reference_audio: reference,
    reference_consent: true,
  };
  assert.throws(
    () => queue.enqueue({ type: 'voices', projectId, request: { ...base, reference_text: '' } }),
    /exact words/,
    'a transcript clone still needs its transcript',
  );
  assert.throws(
    () =>
      queue.enqueue({
        type: 'voices',
        projectId,
        request: { ...base, clone_voice_only: 'yes' },
      }),
    /true or false/,
  );
  assert.throws(
    () =>
      queue.enqueue({
        type: 'voices',
        projectId,
        request: { ...base, clone_voice_only: true, reference_consent: false },
      }),
    /right to use this voice/,
    'voice-only cloning still needs consent',
  );
  assert.throws(
    () =>
      queue.enqueue({
        type: 'voices',
        projectId,
        request: { ...base, clone_voice_only: true, reference_audio: '../x.wav' },
      }),
    /WAV, FLAC or MP3/,
    'voice-only cloning still needs a project clip',
  );
});

test('voice-only clone fields: the client drops the transcript requirement and matches the server', async () => {
  const clone = {
    voiceMode: 'clone',
    voiceReferenceId: 'reference-1',
    voiceReferenceSeconds: 6,
    voiceConsent: true,
    voiceReferenceText: '',
  };
  assert.match(voiceModeFieldErrors(clone).transcript, /exact words/);
  assert.equal(voiceModeFieldErrors({ ...clone, voiceCloneVoiceOnly: true }).transcript, '');
  assert.match(
    voiceModeFieldErrors({ ...clone, voiceCloneVoiceOnly: true, voiceConsent: false }).consent,
    /right to use this voice/,
    'voice-only cloning still needs consent',
  );
  const withoutClip = voiceModeFieldErrors({
    ...clone,
    voiceCloneVoiceOnly: true,
    voiceReferenceId: '',
  });
  assert.match(withoutClip.reference, /WAV, FLAC or MP3/, 'the clip is still required');
});

test('voice-only clone payload sends the flag and no transcript', async (t) => {
  const { projectId } = await makeQueue(t);
  const reference = `${randomUUID()}.wav`;
  const draft = {
    prompt: 'Hello',
    options: ['Ryan', 'English'],
    voiceMode: 'clone',
    voiceReferenceId: reference,
    voiceReferenceSeconds: 6,
    voiceConsent: true,
    voiceReferenceText: 'Typed but not sent.',
    voiceCloneVoiceOnly: true,
  };
  const seeded = () => 4;
  const payload = audioPayload('voices', projectId, draft, { seedGenerator: seeded });
  assert.equal(payload.request.clone_voice_only, true);
  assert.equal(payload.request.reference_audio, reference);
  assert.equal(Object.hasOwn(payload.request, 'reference_text'), false);
  assert.equal(payload.request.reference_consent, true);

  const transcriptClone = audioPayload(
    'voices',
    projectId,
    { ...draft, voiceCloneVoiceOnly: false, voiceReferenceText: 'Words in the clip.' },
    { seedGenerator: seeded },
  );
  assert.equal(Object.hasOwn(transcriptClone.request, 'clone_voice_only'), false);
  assert.equal(transcriptClone.request.reference_text, 'Words in the clip.');
  assert.throws(
    () =>
      audioPayload(
        'voices',
        projectId,
        { ...draft, voiceCloneVoiceOnly: false, voiceReferenceText: '' },
        { seedGenerator: seeded },
      ),
    /exact words/,
  );
});

test('voice-only renders record the flag, not a transcript, and Reuse restores the checkbox', async (t) => {
  const { queue, projectId } = await makeQueue(t);
  const voiceOnly = queue.enqueue({
    type: 'voices',
    projectId,
    request: {
      text: 'Hello',
      mode: 'clone',
      reference_audio: `${randomUUID()}.wav`,
      reference_consent: true,
      clone_voice_only: true,
    },
  });
  const job = {
    ...voiceOnly,
    id: randomUUID(),
    status: 'completed',
    startedAt: null,
    finishedAt: null,
  };
  const record = buildJobMetadata(job, 'voices/vo.wav');
  assert.equal(record.settings.clone_voice_only, true);
  assert.equal(Object.hasOwn(record.settings, 'reference_text'), false);
  assert.equal(record.model.version, TTS_CHECKPOINTS.base.folder);

  const meta = {
    type: 'voices',
    job: { type: 'voices' },
    prompt: { text: 'Hello', secondary: '' },
    seed: 5,
    settings: { ...record.settings },
  };
  const plan = reusePlan(meta);
  assert.equal(plan.draft.voiceMode, 'clone');
  assert.equal(plan.draft.voiceCloneVoiceOnly, true);
  assert.equal(plan.draft.voiceReferenceText, '');
  const row = describeSettings(meta).find((item) => item.key === 'clone_voice_only');
  assert.deepEqual(
    { label: row.label, value: row.value },
    { label: 'Voice only (no transcript)', value: 'On' },
  );

  const transcriptRender = buildJobMetadata(
    { ...job, request: { text: 'Hi', mode: 'clone', reference_text: 'Words.' } },
    'voices/t.wav',
  );
  const restored = reusePlan({ ...meta, settings: { ...transcriptRender.settings } });
  assert.equal(restored.draft.voiceCloneVoiceOnly, false);
  assert.equal(restored.draft.voiceReferenceText, 'Words.');
});
