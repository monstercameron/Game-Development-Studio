import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { videoProgress } from '../runtime/video-progress.js';

test('video progress rejects invalid step counts and out-of-range samples', () => {
  for (const steps of [0, -1, 1.5, '8', Number.NaN]) {
    assert.equal(videoProgress('1/8 - 10.0s/it - ETA 01:20', steps), null);
  }
  assert.equal(videoProgress('9/8 - 10.0s/it - ETA 01:20', 8), null);
  assert.equal(videoProgress('1/8 - 10.0s/it - ETA 01:2', 8), null);
});

test('video progress uses the latest valid matching sample and ignores malformed lines', () => {
  const details = [
    '1/8 - 15.0s/it - ETA 01:50',
    '2/8 - 16.1s/it - ETA 02:16',
    '3/9 - 12.0s/it - ETA 01:12',
    '4/8 - 16x/it - ETA 02:00',
    '9/8 - 16.0s/it - ETA 02:00',
  ].join('\n');

  assert.equal(videoProgress(details, 8), 'Rendering video · step 2/8 · ETA 02:16');
});

async function createVideoJobHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-video-job-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const harnessPath = path.join(directory, 'video-job-harness.js');
  const videoJobUrl = pathToFileURL(path.resolve('runtime/video-job.js')).href;
  await fs.writeFile(
    harnessPath,
    `const statuses = JSON.parse(process.env.FORGE_VIDEO_STATUS);
    globalThis.fetch = async (input) => {
      const url = String(input);
      process.send({ type: 'fetch', url });
      const status = Array.isArray(statuses) ? statuses.shift() : statuses;
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay, ...args) =>
      delay >= 3000 ? setImmediate(callback, ...args) : nativeSetTimeout(callback, delay, ...args);
    await import(${JSON.stringify(videoJobUrl)});\n`,
  );
  return harnessPath;
}

async function runVideoJob(t, { status, request = {}, remoteId = 'remote-video-1' }) {
  const harnessPath = await createVideoJobHarness(t);
  const projectFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-video-project-'));
  t.after(() => fs.rm(projectFolder, { recursive: true, force: true }));
  const child = fork(harnessPath, [], {
    env: { ...process.env, FORGE_VIDEO_STATUS: JSON.stringify(status) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const messages = [];
  child.on('message', (message) => messages.push(message));
  const exit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Video job harness did not exit.'));
    }, 3000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  child.send({
    job: {
      id: 'forge-job-1',
      remoteId,
      request: { steps: 8, references: [], ...request },
    },
    projectFolder,
    baseUrl: 'http://fake-h3.test',
  });
  assert.equal(await exit, 0);
  return messages;
}

test('video job refuses to submit when its persisted references are invalid', async (t) => {
  const messages = await runVideoJob(t, {
    remoteId: null,
    request: { references: ['not-a-staged-reference'] },
    status: {},
  });

  assert.deepEqual(messages, [
    {
      jobId: 'forge-job-1',
      type: 'failed',
      error: 'Could not read video references: Provide 1 to 9 staged reference image IDs.',
    },
  ]);
});

test('video job interrupts when H3 reports an unknown job instead of trusting gallery data', async (t) => {
  const messages = await runVideoJob(t, {
    status: {
      ready: true,
      files: ['remote-video-1.webm'],
      videos: ['remote-video-1.webm'],
      job: { id: 'a-different-job', state: 'complete', output: 'remote-video-1.webm' },
    },
  });

  assert.equal(messages.at(-1).type, 'interrupted');
  assert.match(messages.at(-1).error, /no longer recognizes this job/);
  assert.equal(
    messages.some((message) => message.url?.includes('/videos/')),
    false,
  );
});

test('video job interrupts on an unrecognized H3 job state', async (t) => {
  const messages = await runVideoJob(t, {
    status: {
      ready: true,
      files: [],
      videos: [],
      job: { id: 'remote-video-1', state: 'queued' },
    },
  });

  assert.equal(messages.at(-1).type, 'interrupted');
  assert.match(messages.at(-1).error, /unexpected job state/);
});

test('video job reconnects after a malformed H3 status response', async (t) => {
  const messages = await runVideoJob(t, {
    status: [
      { ready: 'yes', files: [], videos: [] },
      {
        ready: true,
        files: [],
        videos: [],
        job: { id: 'remote-video-1', state: 'queued' },
      },
    ],
  });

  assert.ok(
    messages.some(
      (message) =>
        message.type === 'progress' && message.stage === 'Waiting to reconnect to H3 Studio.',
    ),
  );
  assert.equal(messages.at(-1).type, 'interrupted');
});

test('video job rejects a completed response with a path outside its remote job ID', async (t) => {
  const messages = await runVideoJob(t, {
    status: {
      ready: true,
      files: [],
      videos: [],
      job: { id: 'remote-video-1', state: 'complete', output: 'other.webm' },
    },
  });

  assert.equal(messages.at(-1).type, 'failed');
  assert.match(messages.at(-1).error, /invalid video path/);
  assert.equal(
    messages.some((message) => message.url?.includes('/videos/')),
    false,
  );
});
