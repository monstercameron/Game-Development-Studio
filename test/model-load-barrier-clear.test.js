import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeSupervisor } from '../runtime/supervisor.js';
import { JobQueue } from '../runtime/jobs.js';

async function withBarrier(t, engine, serviceEnv, response, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-barrier-clear-'));
  const queue = new JobQueue({ directory, autoStart: false });
  queue.suspendForModelLoad(engine);
  assert.equal(queue.markModelLoadRequested(engine), true);
  queue.stop();

  let server;
  let url;
  if (response !== null) {
    server = createServer((_request, res) => {
      if (response.delay) {
        setTimeout(() => send(res, response), response.delay);
      } else {
        send(res, response);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  }

  const env = {
    ...process.env,
    FORGE_RUNTIME_DIR: directory,
    [serviceEnv]: url ?? 'http://127.0.0.1:1',
  };
  const supervisor = new RuntimeSupervisor({ env, timeout: 10000, log: () => {} });
  supervisor.start();
  t.after(async () => {
    const child = supervisor.child;
    supervisor.stop();
    if (child && child.exitCode === null) {
      await once(child, 'exit');
    }
    server?.closeAllConnections();
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await waitFor(() => supervisor.status().ready);
  await callback(supervisor);
}

function send(res, response) {
  res.statusCode = response.status ?? 200;
  res.setHeader('Content-Type', response.contentType ?? 'application/json');
  res.end(response.body ?? JSON.stringify(response.json));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), 'runtime worker did not become ready');
}

test('music barrier clears only after a valid idle worker health response', async (t) => {
  await withBarrier(
    t,
    'music',
    'FORGE_MUSIC_URL',
    { json: { api_version: '1', model: { loaded: false, loading: false } } },
    async (supervisor) => {
      const result = await supervisor.call('clearMusicLoadBarrier', { confirmNotLoading: true });
      assert.equal(result.cleared, true);
      assert.equal((await supervisor.call('health')).modelLoadBarrier, 'idle');
    },
  );
});

test('music barrier remains on loading, malformed, unsuccessful, and unreachable status', async (t) => {
  const cases = [
    [
      'loading',
      { json: { api_version: '1', model: { loaded: false, loading: true } } },
      /still loading/,
    ],
    ['malformed', { contentType: 'application/json', body: '{' }, /cannot be verified/],
    ['HTTP error', { status: 503, json: { error: 'starting' } }, /cannot be verified/],
    ['unreachable', null, /cannot be verified/],
  ];
  for (const [name, response, error] of cases) {
    await t.test(name, async (subtest) => {
      await withBarrier(subtest, 'music', 'FORGE_MUSIC_URL', response, async (supervisor) => {
        await assert.rejects(
          supervisor.call('clearMusicLoadBarrier', { confirmNotLoading: true }),
          error,
        );
        assert.equal((await supervisor.call('health')).modelLoadBarrier, 'loading');
      });
    });
  }
});

test('TTS phase schema rejects active and unrecognized worker states', async (t) => {
  for (const [name, phase] of [
    ['loading', 'loading'],
    ['unknown', 'starting-soon'],
  ]) {
    await t.test(name, async (subtest) => {
      await withBarrier(
        subtest,
        'tts',
        'FORGE_TTS_URL',
        { json: { phase } },
        async (supervisor) => {
          await assert.rejects(
            supervisor.call('clearTtsLoadBarrier', { confirmNotLoading: true }),
            /still loading|cannot be verified/,
          );
          assert.equal((await supervisor.call('health')).modelLoadBarrier, 'loading');
        },
      );
    });
  }
});

test('TTS phase schema accepts a known idle state', async (t) => {
  await withBarrier(t, 'tts', 'FORGE_TTS_URL', { json: { phase: 'idle' } }, async (supervisor) => {
    assert.equal(
      (await supervisor.call('clearTtsLoadBarrier', { confirmNotLoading: true })).cleared,
      true,
    );
  });
});
