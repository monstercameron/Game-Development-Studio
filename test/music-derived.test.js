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
import { normalizeDerivedMusic, resolveDerivedMusic } from '../runtime/music-derived.js';
import { derivedSubmission, sourceTrack } from '../runtime/music-request.js';
import { deriveMusicRequest, canDeriveMusic } from '../src/music-derive.js';
import { jobHint } from '../src/job-hints.js';

const musicJobPath = fileURLToPath(new URL('../runtime/music-job.js', import.meta.url));

test('extend and re-synthesize requests are validated and keep only their own fields', () => {
  const extend = normalizeDerivedMusic({
    operation: 'extend',
    source: 'music/forge-a.flac',
    seed: 9,
    add_seconds: 45,
    lyrics_addition: '  [Verse 2]\nmore  ',
    title: ' Longer ',
  });
  assert.deepEqual(extend, {
    operation: 'extend',
    source: 'music/forge-a.flac',
    seed: 9,
    title: 'Longer',
    add_seconds: 45,
    lyrics_addition: '[Verse 2]\nmore',
  });
  assert.equal(
    normalizeDerivedMusic({ operation: 'extend', source: 'music/a.flac' }).add_seconds,
    30,
  );
  const random = normalizeDerivedMusic({ operation: 'resynth', source: 'music/a.flac' });
  assert.ok(Number.isSafeInteger(random.seed) && random.seed >= 0 && random.seed <= 2147483647);
  assert.equal(
    normalizeDerivedMusic({ operation: 'resynth', source: 'music/a.flac', ode_steps: 16 })
      .ode_steps,
    16,
  );
  const rejected = [
    [{ operation: 'loop', source: 'music/a.flac' }, /extend or resynth/],
    [{ operation: 'extend', source: '../a.flac' }, /Invalid asset path/],
    [{ operation: 'extend', source: '.hidden/a.flac' }, /Invalid asset path/],
    [{ operation: 'extend', source: 'music/a.flac', seed: -1 }, /seed/],
    [{ operation: 'extend', source: 'music/a.flac', add_seconds: 0 }, /1 to 300/],
    [{ operation: 'extend', source: 'music/a.flac', add_seconds: 301 }, /1 to 300/],
    [{ operation: 'extend', source: 'music/a.flac', ode_steps: 8 }, /only when re-synthesizing/],
    [{ operation: 'resynth', source: 'music/a.flac', add_seconds: 10 }, /only when extending/],
    [{ operation: 'resynth', source: 'music/a.flac', ode_steps: 0 }, /1 to 100/],
    [{ operation: 'extend', source: 'music/a.flac', lyrics_addition: 'x'.repeat(5001) }, /5000/],
  ];
  for (const [request, pattern] of rejected) {
    assert.throws(() => normalizeDerivedMusic(request), pattern, JSON.stringify(request));
  }
});

test('the engine requests carry the track YuE2 reported and nothing else', async () => {
  assert.deepEqual(
    derivedSubmission(
      {
        operation: 'extend',
        add_seconds: 30,
        seed: 4,
        title: 'T',
        lyrics_addition: 'la',
        source: 'music/a.flac',
        style: 'ignored',
      },
      'app/track-1',
    ),
    {
      path: '/api/jobs/extend',
      payload: {
        track: 'app/track-1',
        add_seconds: 30,
        seed: 4,
        title: 'T',
        lyrics_addition: 'la',
      },
    },
  );
  assert.deepEqual(derivedSubmission({ operation: 'resynth', seed: 4 }, 'app/track-1'), {
    path: '/api/jobs/resynth',
    payload: { track: 'app/track-1', seed: 4 },
  });
  assert.throws(() => derivedSubmission({ operation: 'resynth', seed: 1 }, ''), /did not report/);
  const fetcher = async (url) => ({
    ok: true,
    json: async () => ({ status: 'done', track: `seen:${url.split('/').pop()}` }),
  });
  assert.equal(await sourceTrack('http://x', 'yue 1', fetcher), 'seen:yue%201');
  await assert.rejects(
    sourceTrack('http://x', 'a', async () => ({
      ok: true,
      json: async () => ({ status: 'running' }),
    })),
    /no longer has/,
  );
  await assert.rejects(
    sourceTrack('http://x', 'a', async () => ({ ok: false, status: 404 })),
    /404/,
  );
});

async function makeProject(t, holder) {
  t.after(() => holder.queue?.stop());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-music-derived-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const project = path.join(projects, 'Fixture');
  const projectId = randomUUID();
  await fs.mkdir(path.join(project, 'music'), { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id: projectId }));
  holder.queue = new JobQueue({
    directory: path.join(root, 'state'),
    projects,
    autoStart: false,
  });
  return { root, projects, project, projectId, queue: holder.queue };
}

function completeMusic(queue, projectId, remoteId = 'yue-source') {
  const job = queue.enqueue({
    type: 'music',
    projectId,
    request: { style: 'warm synth pop', lyrics: '[Verse]\nhello', title: 'Hello' },
  });
  queue.db
    .prepare("UPDATE jobs SET status='completed', remote_id=?, output=? WHERE id=?")
    .run(remoteId, `music/forge-${job.id}.flac`, job.id);
  return job;
}

test('the queue resolves a music asset to the finished YuE2 render that made it', async (t) => {
  const { projectId, queue } = await makeProject(t, {});
  const source = completeMusic(queue, projectId);
  const asset = `music/forge-${source.id}.flac`;
  const extended = queue.enqueue({
    type: 'music',
    projectId,
    request: {
      operation: 'extend',
      source: asset,
      seed: 3,
      add_seconds: 20,
      lyrics_addition: '[Verse 2]\nmore',
    },
  });
  assert.equal(extended.status, 'queued');
  assert.equal(extended.request.source_job, source.id);
  assert.equal(extended.request.source_remote, 'yue-source');
  assert.equal(extended.request.style, 'warm synth pop');
  assert.equal(extended.request.lyrics, '[Verse]\nhello\n\n[Verse 2]\nmore');
  assert.equal(extended.request.title, 'Hello (extended)');
  assert.equal(extended.request.duration_seconds, 20);
  const resynth = queue.enqueue({
    type: 'music',
    projectId,
    request: { operation: 'resynth', source: asset, title: 'Again' },
  });
  assert.equal(resynth.request.title, 'Again');
  assert.equal(resynth.request.lyrics, '[Verse]\nhello');
  assert.equal(Object.hasOwn(resynth.request, 'duration_seconds'), false);
  assert.equal(jobHint(extended), `Extending ${asset} by 20 s`);
  assert.equal(jobHint(resynth), `Re-synthesizing ${asset}`);
});

test('derived titles cut a long style at a word and do not repeat the suffix when chained', async (t) => {
  const { projectId, queue } = await makeProject(t, {});
  const style =
    'English, mellow acoustic folk, gentle fingerpicked guitar, warm male voice, 90 BPM';
  const source = queue.enqueue({
    type: 'music',
    projectId,
    request: { style, lyrics: '[Verse]\nhello' },
  });
  queue.db
    .prepare("UPDATE jobs SET status='completed', remote_id=?, output=? WHERE id=?")
    .run('yue-a', `music/forge-${source.id}.flac`, source.id);
  const first = queue.enqueue({
    type: 'music',
    projectId,
    request: { operation: 'extend', source: `music/forge-${source.id}.flac`, add_seconds: 5 },
  });
  assert.equal(
    first.request.title,
    'English, mellow acoustic folk, gentle fingerpicked guitar (extended)',
  );
  queue.db
    .prepare("UPDATE jobs SET status='completed', remote_id=?, output=? WHERE id=?")
    .run('yue-b', `music/forge-${first.id}.flac`, first.id);
  const second = queue.enqueue({
    type: 'music',
    projectId,
    request: { operation: 'extend', source: `music/forge-${first.id}.flac`, add_seconds: 5 },
  });
  assert.equal(second.request.title, first.request.title);
  const resynth = queue.enqueue({
    type: 'music',
    projectId,
    request: { operation: 'resynth', source: `music/forge-${first.id}.flac` },
  });
  assert.match(resynth.request.title, /fingerpicked guitar \(re-synthesized\)$/);
});

test('only finished tracks from this project can be extended', async (t) => {
  const { projectId, queue } = await makeProject(t, {});
  const source = completeMusic(queue, projectId);
  const request = (asset) => ({
    type: 'music',
    projectId,
    request: { operation: 'extend', source: asset },
  });
  assert.throws(
    () => queue.enqueue(request('music/not-made-by-forge.flac')),
    /finished YuE2 track/,
  );
  assert.throws(
    () => queue.enqueue(request(`music/forge-${randomUUID()}.flac`)),
    /finished YuE2 track/,
  );
  queue.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(source.id);
  assert.throws(
    () => queue.enqueue(request(`music/forge-${source.id}.flac`)),
    /finished YuE2 track/,
  );
  queue.db.prepare("UPDATE jobs SET status='completed', remote_id=NULL WHERE id=?").run(source.id);
  assert.throws(
    () => queue.enqueue(request(`music/forge-${source.id}.flac`)),
    /finished YuE2 track/,
  );
  assert.equal(queue.list().filter((job) => job.request.operation).length, 0);
  // A job from another project is not a valid source even with the right file name.
  const other = { id: source.id, type: 'music', projectId: randomUUID(), status: 'completed' };
  assert.throws(
    () =>
      resolveDerivedMusic(
        {
          type: 'music',
          projectId,
          request: { operation: 'extend', source: `music/forge-${source.id}.flac` },
        },
        { projectFolder: os.tmpdir(), lookup: () => ({ ...other, remoteId: 'yue-x' }) },
      ),
    /finished YuE2 track/,
  );
});

test('the browser builds extend and re-synthesize requests for music assets only', () => {
  const asset = { id: 'music/forge-a.flac', category: 'Audio' };
  assert.equal(canDeriveMusic(asset), true);
  assert.equal(canDeriveMusic({ id: 'sfx/a.wav', category: 'Audio' }), false);
  assert.equal(canDeriveMusic({ id: 'music/a.png', category: 'Images' }), false);
  assert.deepEqual(deriveMusicRequest('extend', asset, {}), {
    operation: 'extend',
    source: 'music/forge-a.flac',
    add_seconds: 30,
  });
  assert.deepEqual(
    deriveMusicRequest('extend', asset, { addSeconds: '12.5', lyricsAddition: ' la ', seed: '4' }),
    {
      operation: 'extend',
      source: 'music/forge-a.flac',
      seed: 4,
      add_seconds: 12.5,
      lyrics_addition: 'la',
    },
  );
  assert.deepEqual(deriveMusicRequest('resynth', asset, { steps: '16' }), {
    operation: 'resynth',
    source: 'music/forge-a.flac',
    ode_steps: 16,
  });
  assert.throws(() => deriveMusicRequest('extend', asset, { addSeconds: '0' }), /1 to 300/);
  assert.throws(() => deriveMusicRequest('resynth', asset, { steps: '1.5' }), /whole number/);
  assert.throws(() => deriveMusicRequest('extend', asset, { seed: '-2' }), /Seed/);
  assert.throws(() => deriveMusicRequest('extend', { id: 'sfx/a.wav' }), /music file/);
});

async function runMusicWorker(t, { request, engine }) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      engine(req, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-music-worker-'));
  await fs.mkdir(path.join(directory, 'music'));
  const child = fork(musicJobPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
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
    job: { id: 'derived-music-job', request },
    projectFolder: directory,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  return { requests, outcome: await done, directory };
}

test('the music worker finds the source track, submits the extension and saves the result', async (t) => {
  const { requests, outcome, directory } = await runMusicWorker(t, {
    request: {
      operation: 'extend',
      source: 'music/forge-a.flac',
      source_remote: 'yue-source',
      seed: 5,
      add_seconds: 30,
      title: 'Hello (extended)',
      lyrics_addition: '[Verse 2]\nmore',
      style: 'warm synth pop',
      lyrics: 'display only',
    },
    engine: (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/jobs/yue-source') {
        res.end(JSON.stringify({ id: 'yue-source', status: 'done', track: 'app/2026-track' }));
      } else if (req.url === '/api/jobs/extend') {
        res.end(JSON.stringify({ jobs: [{ id: 'yue-derived' }] }));
      } else if (req.url === '/api/v1/jobs/yue-derived') {
        res.end(JSON.stringify({ id: 'yue-derived', status: 'done', track: 'app/2026-track-2' }));
      } else if (req.url === '/api/v1/jobs/yue-derived/audio') {
        res.setHeader('Content-Type', 'audio/flac');
        res.end('extended flac bytes');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    },
  });
  assert.equal(outcome.type, 'complete');
  assert.equal(outcome.output, 'music/forge-derived-music-job.flac');
  assert.equal(
    await fs.readFile(path.join(directory, 'music', 'forge-derived-music-job.flac'), 'utf8'),
    'extended flac bytes',
  );
  assert.deepEqual(requests.map((item) => `${item.method} ${item.url}`).slice(0, 2), [
    'GET /api/v1/jobs/yue-source',
    'POST /api/jobs/extend',
  ]);
  assert.deepEqual(requests[1].body, {
    track: 'app/2026-track',
    add_seconds: 30,
    seed: 5,
    title: 'Hello (extended)',
    lyrics_addition: '[Verse 2]\nmore',
  });
});

test('the music worker fails without submitting when YuE2 has lost the source track', async (t) => {
  for (const reply of [
    (res) => {
      res.statusCode = 404;
      res.end('{}');
    },
    (res) => res.end(JSON.stringify({ status: 'done' })),
  ]) {
    const { requests, outcome } = await runMusicWorker(t, {
      request: { operation: 'resynth', source: 'music/a.flac', source_remote: 'gone', seed: 1 },
      engine: (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        reply(res);
      },
    });
    assert.equal(outcome.type, 'failed');
    assert.match(outcome.error, /Could not find the source track/);
    assert.equal(
      requests.some((item) => item.method === 'POST'),
      false,
    );
  }
});
