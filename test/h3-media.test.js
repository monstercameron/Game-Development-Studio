import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const inputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-media-root-'));
process.env.FORGE_H3_INPUT_ROOT = inputRoot;
const python =
  process.env.FORGE_TRANSCODE_PYTHON ||
  path.join(path.dirname(root), 'Snapdargon-DJ', '.runtime', 'python.exe');
const hasPython = existsSync(python);
const { buildSubmission, needsExtensions, h3SupportsExtensions, removeJobInputs } =
  await import('../runtime/video-media.js');
const { stageProjectClip, stagedClipPath } = await import('../runtime/clips.js');
const { stageReference } = await import('../runtime/references.js');

const png1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const base = { prompt: 'a scene', aspect: 'landscape', frames: 124, steps: 12, seed: 1 };

function makeClip(file, seconds, audio) {
  const script = `
import sys
from fractions import Fraction
import av
import numpy as np
out, seconds, with_audio = sys.argv[1], float(sys.argv[2]), sys.argv[3] == "1"
with av.open(out, "w") as dst:
    video = dst.add_stream("libvpx", rate=24)
    video.width, video.height, video.pix_fmt = 96, 64, "yuv420p"
    sound = dst.add_stream("libopus", rate=48000, layout="stereo") if with_audio else None
    for n in range(round(seconds * 24)):
        pixels = np.zeros((64, 96, 3), dtype=np.uint8)
        pixels[:, :, 0] = (n * 5) % 255
        frame = av.VideoFrame.from_ndarray(pixels, format="rgb24")
        frame.pts = n
        frame.time_base = Fraction(1, 24)
        dst.mux(video.encode(frame))
    dst.mux(video.encode(None))
    if sound:
        total = int(48000 * seconds)
        tone = (np.sin(np.arange(total) * 2 * np.pi * 440 / 48000) * 8000).astype(np.int16)
        stereo = np.stack([tone, tone], axis=1).reshape(1, -1)
        for start in range(0, total - 960, 960):
            frame = av.AudioFrame.from_ndarray(
                stereo[:, start * 2 : (start + 960) * 2], format="s16", layout="stereo"
            )
            frame.sample_rate = 48000
            frame.pts = start
            frame.time_base = Fraction(1, 48000)
            dst.mux(sound.encode(frame))
        dst.mux(sound.encode(None))
`;
  const result = spawnSync(python, ['-I', '-c', script, file, String(seconds), audio ? '1' : '0'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}
async function project(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-media-project-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'video'));
  return folder;
}
// One second of a quiet 8 kHz mono tone; the media runtime must convert it to 32 kHz stereo.
function toneWav() {
  const samples = 8000,
    data = Buffer.alloc(samples * 2);
  for (let n = 0; n < samples; n++) {
    data.writeInt16LE(Math.round(Math.sin((n / 8000) * 2 * Math.PI * 440) * 6000), n * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const dimensions = (dataUrl) => {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test('only options H3 cannot express need the extensions', () => {
  assert.equal(needsExtensions({ ...base, references: ['a'] }), false);
  assert.equal(needsExtensions({ ...base, aspect: 'portrait', references: ['a'] }), false);
  assert.equal(needsExtensions({ ...base, frames: 243, steps: 30 }), false);
  for (const change of [
    { source: 'frames' },
    { source: 'text' },
    { first_frame: 'a' },
    { reference_videos: ['a'] },
    { reference_audios: ['a'] },
    { frames: 311 },
    { steps: 4 },
    { turbo: true },
    { cfg_scale: 2 },
    { sampler: 'euler' },
    { scheduler: 'beta' },
    { max_vram: 12 },
    { reference_detail: 'max' },
    { resolution: 'medium' },
    { aspect: 'cinema' },
    { aspect: 'photo' },
  ]) {
    assert.equal(needsExtensions({ ...base, ...change }), true, JSON.stringify(change));
  }
});

test('a plain request sends exactly what earlier versions sent', async (t) => {
  const folder = await project(t);
  const { id } = await stageReference(folder, png1);
  const { body, extended } = await buildSubmission(folder, 'job-plain', {
    ...base,
    references: [id],
  });
  assert.equal(extended, false);
  assert.deepEqual(Object.keys(body).sort(), [
    'aspect',
    'frames',
    'images',
    'prompt',
    'seed',
    'steps',
  ]);
  assert.match(body.images[0], /^data:image\/png;base64,/);
  assert.equal(body.forge, undefined);
});

test('text-only requests send a placeholder image that the launcher drops', async (t) => {
  const folder = await project(t);
  const { body, extended } = await buildSubmission(folder, 'job-text', {
    ...base,
    source: 'text',
    references: [],
    aspect: 'cinema',
    resolution: 'medium',
    frames: 311,
    steps: 8,
    cfg_scale: 2,
    negative_prompt: 'blurry',
    turbo: false,
    sampler: 'euler',
    max_vram: 8,
  });
  t.after(() => removeJobInputs('job-text'));
  assert.equal(extended, true);
  assert.equal(body.aspect, 'landscape');
  assert.equal(body.frames, 124);
  assert.equal(body.steps, 8);
  assert.equal(body.images.length, 1);
  assert.deepEqual(body.forge, {
    version: 1,
    width: 896,
    height: 384,
    frames: 311,
    steps: 8,
    images: 'none',
    cfg_scale: 2,
    negative_prompt: 'blurry',
    sampler: 'euler',
    max_vram: 8,
  });
});

test('staged references are checked again when the job runs', async (t) => {
  const folder = await project(t);
  await assert.rejects(
    buildSubmission(folder, 'job-bad', { ...base, references: ['not-staged'] }),
    /Provide 1 to 9 staged reference/,
  );
  await assert.rejects(
    buildSubmission(folder, 'job-bad', {
      ...base,
      source: 'frames',
      first_frame: '11111111-1111-4111-8111-111111111111.png',
      references: [],
    }),
    /Reference image is missing|ENOENT|no such file/,
  );
  await removeJobInputs('job-bad');
});

test('clips are copied from project assets and re-read from the staged copy', async (t) => {
  const folder = await project(t);
  await fs.writeFile(path.join(folder, 'video', 'clip.webm'), 'not really a video');
  await fs.writeFile(path.join(folder, 'video', 'notes.txt'), 'x');
  await fs.writeFile(path.join(folder, 'video', '.hidden.webm'), 'x');
  const staged = await stageProjectClip(folder, 'video/clip.webm');
  assert.match(staged.id, /^[a-f0-9-]{36}\.webm$/);
  assert.equal(staged.kind, 'video');
  assert.ok((await stagedClipPath(folder, staged.id, 'video')).endsWith(staged.id));
  await assert.rejects(stagedClipPath(folder, staged.id, 'audio'), /staged reference audio ID/);
  await assert.rejects(stageProjectClip(folder, 'video/notes.txt'), /WebM or MP4/);
  await assert.rejects(
    stageProjectClip(folder, 'video/.hidden.webm'),
    /Invalid project asset path/,
  );
  await assert.rejects(stageProjectClip(folder, '../escape.webm'), /Invalid project asset path/);
  await assert.rejects(stageProjectClip(folder, 'video/missing.webm'), /not in the project/);
});

test(
  'first and last frames are fitted to the render size',
  { skip: !hasPython && 'media runtime not installed' },
  async (t) => {
    const folder = await project(t);
    const first = await stageReference(folder, png1);
    const last = await stageReference(folder, png1);
    const { body, extended } = await buildSubmission(folder, 'job-frames', {
      ...base,
      source: 'frames',
      references: [],
      first_frame: first.id,
      last_frame: last.id,
      resolution: 'medium',
    });
    t.after(() => removeJobInputs('job-frames'));
    assert.equal(extended, true);
    assert.equal(body.images.length, 2);
    assert.deepEqual(dimensions(body.images[0]), [736, 416]);
    assert.deepEqual(dimensions(body.images[1]), [736, 416]);
    assert.equal(body.forge.images, 'frames');
    const single = await buildSubmission(folder, 'job-frames', {
      ...base,
      source: 'frames',
      references: [],
      first_frame: first.id,
    });
    assert.equal(single.body.images.length, 1);
    assert.deepEqual(dimensions(single.body.images[0]), [608, 352]);
  },
);

test(
  'reference videos become 24 fps frame folders and reference audio becomes 32 kHz WAV',
  { skip: !hasPython && 'media runtime not installed' },
  async (t) => {
    const folder = await project(t);
    makeClip(path.join(folder, 'video', 'loud.webm'), 2.5, true);
    makeClip(path.join(folder, 'video', 'silent.webm'), 1.0, false);
    const loud = await stageProjectClip(folder, 'video/loud.webm');
    const silent = await stageProjectClip(folder, 'video/silent.webm');
    await fs.writeFile(path.join(folder, 'video', 'tone.wav'), toneWav());
    const tone = await stageProjectClip(folder, 'video/tone.wav');
    const picture = await stageReference(folder, png1);
    const { body } = await buildSubmission(folder, 'job-clips', {
      ...base,
      references: [picture.id],
      reference_videos: [loud.id],
      reference_audios: [tone.id],
      use_clip_audio: true,
    });
    t.after(() => removeJobInputs('job-clips'));
    assert.deepEqual(body.forge.ref_videos, ['job-clips/video-1']);
    assert.deepEqual(body.forge.ref_video_audios, ['job-clips/video-audio-1.wav']);
    assert.deepEqual(body.forge.ref_audios, ['job-clips/audio-1.wav']);
    assert.equal(body.forge.images, 'references');
    // Encoding a reference clip needs more than the engine's usual 6 GiB budget (video-options.js).
    assert.equal(body.forge.max_vram, 12);
    const frames = await fs.readdir(path.join(inputRoot, 'job-clips', 'video-1'));
    // 2.5 s at 24 fps is 60 frames; MiniMax counts frames as 17 n + 5, so 56 are kept.
    assert.equal(frames.length, 56);
    const wav = await fs.readFile(path.join(inputRoot, 'job-clips', 'video-audio-1.wav'));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 32000);
    assert.equal(wav.readUInt16LE(22), 2);
    const reference = await fs.readFile(path.join(inputRoot, 'job-clips', 'audio-1.wav'));
    assert.equal(reference.readUInt32LE(24), 32000);
    assert.equal(reference.readUInt16LE(22), 2);
    // One second at 32 kHz, stereo, 16 bit.
    assert.equal(reference.length - 44, 32000 * 4);
    // A silent clip cannot lend its sound.
    await assert.rejects(
      buildSubmission(folder, 'job-silent', {
        ...base,
        references: [picture.id],
        reference_videos: [silent.id],
        use_clip_audio: true,
      }),
      /has no sound track/,
    );
    await removeJobInputs('job-silent');
    // Clips alone (no pictures) are a valid reference set.
    const only = await buildSubmission(folder, 'job-only', {
      ...base,
      references: [],
      reference_videos: [silent.id],
    });
    await removeJobInputs('job-only');
    assert.equal(only.body.forge.images, 'none');
    assert.equal(only.body.images.length, 1);
  },
);

test(
  'the converter makes an H.264 MP4 and a GIF from a WebM',
  { skip: !hasPython && 'media runtime not installed' },
  async (t) => {
    const folder = await project(t);
    makeClip(path.join(folder, 'video', 'a.webm'), 1.0, true);
    const { convertAsset } = await import('../runtime/transcode.js');
    const project_ = {
      id: '00000000-0000-4000-8000-000000000000',
      folder,
      assets: [{ id: 'video/a.webm', category: 'Video' }],
    };
    const mp4 = await convertAsset(project_, { path: 'video/a.webm', format: 'mp4' });
    assert.equal(mp4.name, 'a-converted.mp4');
    assert.equal(mp4.backend, 'CPU (PyAV, x264)');
    const header = (await fs.readFile(path.join(folder, 'video', mp4.name))).subarray(4, 8);
    assert.equal(header.toString('ascii'), 'ftyp');
    const gif = await convertAsset(project_, { path: 'video/a.webm', format: 'gif' });
    const bytes = await fs.readFile(path.join(folder, 'video', gif.name));
    assert.equal(bytes.toString('ascii', 0, 3), 'GIF');
    await assert.rejects(
      convertAsset(project_, { path: 'video/a.webm', format: 'png' }),
      /supported/,
    );
  },
);

test('the launcher probe distinguishes updated and older H3 services', async () => {
  const answer = (status, data) => async () => ({ ok: status === 200, json: async () => data });
  assert.equal(await h3SupportsExtensions('http://x', answer(200, { forgeExtensions: 1 })), true);
  assert.equal(await h3SupportsExtensions('http://x', answer(404, { error: 'Not found' })), false);
  assert.equal(await h3SupportsExtensions('http://x', answer(200, {})), false);
  assert.equal(
    await h3SupportsExtensions('http://x', async () => {
      throw Error('refused');
    }),
    false,
  );
});

test('a video job stops with a clear message when H3 was started before the update', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-media-job-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const harness = path.join(directory, 'harness.js');
  await fs.writeFile(
    harness,
    `globalThis.fetch = async (input) => {
       process.send({ type: 'fetch', url: String(input) });
       return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
     };
     await import(${JSON.stringify(pathToFileURL(path.join(root, 'runtime', 'video-job.js')).href)});\n`,
  );
  const folder = await project(t);
  const child = fork(harness, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.send({
    job: {
      id: 'job-old-h3',
      remoteId: null,
      request: { ...base, source: 'text', references: [] },
    },
    projectFolder: folder,
    baseUrl: 'http://fake-h3.test',
  });
  await exited;
  const failed = messages.find((message) => message.type === 'failed');
  assert.match(failed.error, /started before this Forge update/);
  assert.equal(
    messages.some((message) => message.url?.endsWith('/api/generate')),
    false,
  );
  assert.equal(existsSync(path.join(inputRoot, 'job-old-h3')), false);
});

test(
  'a finished render can also be saved as an MP4 recorded as a conversion',
  { skip: !hasPython && 'media runtime not installed' },
  async (t) => {
    const folder = await project(t);
    const source = path.join(folder, 'source.webm');
    makeClip(source, 1.0, true);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-mp4-job-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const harness = path.join(directory, 'harness.js');
    await fs.writeFile(
      harness,
      `import fs from 'node:fs/promises';
       const bytes = await fs.readFile(${JSON.stringify(source)});
       globalThis.fetch = async (input) => {
         const url = String(input);
         if (url.includes('/videos/')) return new Response(bytes, { status: 200 });
         return new Response(
           JSON.stringify({
             ready: true,
             files: [],
             videos: [],
             job: { id: 'remote-1', state: 'complete', output: 'remote-1.webm' },
           }),
           { status: 200 },
         );
       };
       await import(${JSON.stringify(pathToFileURL(path.join(root, 'runtime', 'video-job.js')).href)});\n`,
    );
    const run = async (id, extra) => {
      const child = fork(harness, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const messages = [];
      child.on('message', (message) => messages.push(message));
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send({
        job: { id, remoteId: 'remote-1', request: { ...base, references: [], ...extra } },
        projectFolder: folder,
        baseUrl: 'http://fake-h3.test',
      });
      await exited;
      return messages.find((message) => message.type === 'complete');
    };
    const id = '55555555-5555-4555-8555-555555555555';
    const done = await run(id, { also_mp4: true });
    assert.equal(done.output, `video/forge-${id}.webm`);
    assert.deepEqual(done.conversions, [{ path: `video/forge-${id}.mp4`, format: 'mp4' }]);
    const mp4 = await fs.readFile(path.join(folder, 'video', `forge-${id}.mp4`));
    assert.equal(mp4.subarray(4, 8).toString('ascii'), 'ftyp');
    // Without the option no MP4 is made.
    const other = '66666666-6666-4666-8666-666666666666';
    const plain = await run(other, {});
    assert.equal(plain.conversions, undefined);
    assert.equal(existsSync(path.join(folder, 'video', `forge-${other}.mp4`)), false);
  },
);

test.after(() => fs.rm(inputRoot, { recursive: true, force: true }));
