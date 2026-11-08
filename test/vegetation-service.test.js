import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAiAssistSettings } from '../runtime/ai-assist-settings.js';
import { vegetationService } from '../runtime/vegetation-service.js';
import { makeFakeSeedThree, useFakeSeedThree } from './fixtures/fake-seedthree-setup.js';

const FAKE_KEY = 'fake-key-for-tests-only';
let fake;
let restoreEnvironment;
let runtimeDirectory;

before(async () => {
  fake = await makeFakeSeedThree();
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-veg-service-'));
  restoreEnvironment = useFakeSeedThree(fake, runtimeDirectory);
});

after(async () => {
  restoreEnvironment();
  await fake.remove();
  await fs.rm(runtimeDirectory, { recursive: true, force: true });
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}

async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
  }
  return text;
}

// A stand-in for OpenAI: records every request and answers from a queue of replies.
async function fakeOpenAI(replies) {
  const seen = [];
  const remote = await listen(async (req, res) => {
    const body = await readBody(req);
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    const reply = replies.shift() || {
      status: 500,
      json: { error: { message: 'no reply queued' } },
    };
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  return { ...remote, seen };
}

const outputText = (value) => ({
  json: { output_text: JSON.stringify(value), model: 'gpt-6-luna' },
});

async function startStudio(options = {}) {
  const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-ai-settings-'));
  const settings = createAiAssistSettings({ directory: settingsDirectory });
  const keyReads = { count: 0 };
  const credentials = {
    status: () => [{ provider: 'openai', saved: options.key !== false }],
    get: async () => {
      keyReads.count += 1;
      return options.key === false ? '' : FAKE_KEY;
    },
  };
  const app = express();
  vegetationService({
    runtimeDir: settingsDirectory,
    credentials,
    aiAssistSettings: settings,
    ...options.service,
  }).configureServer({ middlewares: app });
  const studio = await listen(app);
  const origin = studio.url;
  return {
    settings,
    keyReads,
    settingsDirectory,
    get: (route) => fetch(`${origin}/api/vegetation${route}`),
    post: (route, body, headers = true) =>
      fetch(`${origin}/api/vegetation${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(headers ? { Origin: origin, 'X-Forge-Request': 'vegetation' } : {}),
        },
        body: JSON.stringify(body ?? {}),
      }),
    async close() {
      await studio.close();
      await fs.rm(settingsDirectory, { recursive: true, force: true });
    },
  };
}

test('status and schema describe a ready checkout; writes need the studio origin', async () => {
  const studio = await startStudio();
  try {
    const status = await (await studio.get('/status')).json();
    assert.equal(status.checkout.state, 'ready');
    assert.equal(status.describe.provider, 'openai');
    assert.equal(status.describe.model, 'gpt-6-luna');
    assert.equal(status.describe.state, 'ready');
    assert.match(
      status.describe.notice,
      /Your description and the plant parameter list are sent to OpenAI/,
    );
    const schema = await (await studio.get('/schema')).json();
    assert.ok(schema.schema.species.some((item) => item.key === 'fakeTree'));
    assert.ok(schema.measured.fakeTree.low < schema.measured.fakeTree.high);
    assert.equal((await studio.post('/fetch', {}, false)).status, 403);
    assert.equal((await studio.post('/describe', { description: 'oak' }, false)).status, 403);
    assert.equal((await studio.get('/nope')).status, 404);
  } finally {
    await studio.close();
  }
});

test('an unfetched checkout gives an actionable status and no schema', async () => {
  const previous = process.env.FORGE_SEEDTHREE_DIR;
  process.env.FORGE_SEEDTHREE_DIR = path.join(os.tmpdir(), 'forge-never-fetched');
  const studio = await startStudio();
  try {
    const status = await (await studio.get('/status')).json();
    assert.equal(status.checkout.state, 'missing');
    assert.equal(status.checkout.action, 'fetch');
    const schema = await studio.get('/schema');
    assert.equal(schema.status, 409);
    assert.match((await schema.json()).error, /Fetch SeedThree/);
    assert.equal((await studio.post('/describe', { description: 'a tree' })).status, 409);
  } finally {
    process.env.FORGE_SEEDTHREE_DIR = previous;
    await studio.close();
  }
});

test('Fetch runs once at a time and only when asked', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const studio = await startStudio({
    service: {
      fetchCheckout: async ({ onStep }) => {
        calls += 1;
        onStep('Downloading');
        await gate;
      },
    },
  });
  try {
    await studio.get('/status');
    assert.equal(calls, 0, 'reading the status never fetches');
    const first = await (await studio.post('/fetch')).json();
    await studio.post('/fetch');
    assert.equal(first.fetch.running, true);
    assert.equal(calls, 1);
    assert.equal((await (await studio.get('/status')).json()).fetch.step, 'Downloading');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fetchState = (await (await studio.get('/status')).json()).fetch;
    assert.equal(fetchState.running, false);
    assert.equal(fetchState.error, '');
  } finally {
    await studio.close();
  }
});

test('Describe it without a saved OpenAI key asks for the key and sends nothing', async () => {
  const remote = await fakeOpenAI([]);
  const studio = await startStudio({ key: false, service: { openaiBaseUrl: `${remote.url}/v1/` } });
  try {
    const status = await (await studio.get('/describe')).json();
    assert.equal(status.state, 'needs_key');
    const reply = await studio.post('/describe', { description: 'a tall oak' });
    assert.equal(reply.status, 400);
    const body = await reply.json();
    assert.equal(body.code, 'no_key');
    assert.match(body.error, /Add your OpenAI key in Settings/);
    assert.equal(remote.seen.length, 0);
    assert.equal(
      (await (await studio.post('/describe/check')).json()).code,
      'no_key',
      'the model check also needs a key',
    );
  } finally {
    await studio.close();
    await remote.close();
  }
});

test('Describe it sends only the description and the parameter list to OpenAI', async () => {
  const remote = await fakeOpenAI([
    outputText({ species: 'fakeTree' }),
    outputText({
      seed: 4242,
      params: {
        height: 9000,
        branches: 7.4,
        crown: 'conical',
        evil: 1,
        barkTint: 5,
        'paramOverrides.angle.1': 20,
      },
    }),
  ]);
  const studio = await startStudio({ service: { openaiBaseUrl: `${remote.url}/v1/` } });
  try {
    const description = 'a tall weathered tree with few branches';
    const reply = await studio.post('/describe', { description });
    assert.equal(reply.status, 200);
    const { suggestion } = await reply.json();
    assert.equal(suggestion.species, 'fakeTree');
    assert.equal(suggestion.seed, 4242);
    // Out-of-range numbers are clamped, labels become values, and invented or
    // unoffered names are dropped.
    assert.deepEqual(suggestion.params, { height: 30, branches: 7, crown: 0 });
    assert.ok(suggestion.ignored.includes('evil'));
    assert.ok(suggestion.ignored.includes('barkTint'));
    assert.ok(
      suggestion.ignored.includes('paramOverrides.angle.1'),
      'advanced controls are not offered',
    );
    assert.equal(suggestion.provider, 'openai');
    assert.equal(suggestion.model, 'gpt-6-luna');
    assert.equal(remote.seen.length, 2);
    for (const request of remote.seen) {
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.store, false);
      assert.deepEqual(body.text, { format: { type: 'json_object' } });
      assert.ok(body.max_output_tokens <= 2000);
      const sent = `${body.instructions}\n${body.input}`;
      assert.ok(sent.includes(description));
      // Nothing about the studio, the machine or any project leaves the computer.
      for (const secret of [
        os.homedir(),
        os.tmpdir(),
        os.userInfo().username,
        'projects',
        FAKE_KEY,
        'forge-',
      ]) {
        assert.ok(!sent.includes(secret), `the request must not contain ${secret}`);
      }
    }
    assert.match(JSON.parse(remote.seen[0].body).input, /fakeTree: Fake Tree/);
    assert.match(JSON.parse(remote.seen[1].body).input, /branches \| Branches \| 1 to 20 step 1/);
    assert.ok(!JSON.parse(remote.seen[1].body).input.includes('barkTint'));
  } finally {
    await studio.close();
    await remote.close();
  }
});

test('a species the person already chose is kept and costs one request', async () => {
  const remote = await fakeOpenAI([outputText({ params: { height: 5 } })]);
  const studio = await startStudio({ service: { openaiBaseUrl: `${remote.url}/v1/` } });
  try {
    const reply = await studio.post('/describe', { description: 'short', species: 'fakeShrub' });
    const { suggestion } = await reply.json();
    assert.equal(suggestion.species, 'fakeShrub');
    assert.deepEqual(suggestion.params, { height: 5 });
    assert.equal(suggestion.seed, null);
    assert.equal(remote.seen.length, 1);
    assert.equal(
      (await studio.post('/describe', { description: 'x', species: 'nope' })).status,
      400,
    );
    assert.equal((await studio.post('/describe', { description: '' })).status, 400);
    assert.equal((await studio.post('/describe', { description: 'x'.repeat(601) })).status, 400);
    assert.equal(remote.seen.length, 1, 'invalid input is rejected before any request');
  } finally {
    await studio.close();
    await remote.close();
  }
});

test('unusable model output is reported, not guessed', async () => {
  const remote = await fakeOpenAI([
    { json: { output_text: 'Sure! Here is a tree.' } },
    outputText({ species: 'oak-tree-of-doom' }),
    outputText({ species: 'fakeTree' }),
    { json: { output_text: '[1,2,3]' } },
  ]);
  const studio = await startStudio({ service: { openaiBaseUrl: `${remote.url}/v1/` } });
  try {
    const first = await studio.post('/describe', { description: 'a tree' });
    assert.equal(first.status, 502);
    assert.equal((await first.json()).code, 'bad_output');
    const second = await studio.post('/describe', { description: 'a tree' });
    assert.equal(second.status, 502);
    assert.equal((await second.json()).code, 'bad_output');
  } finally {
    await studio.close();
    await remote.close();
  }
});

test('provider errors are shown with the provider message and no key', async () => {
  const notFound = {
    status: 404,
    json: { error: { message: `The model gpt-6-luna does not exist (key ${FAKE_KEY}).` } },
  };
  const remote = await fakeOpenAI([
    notFound,
    { status: 401, json: { error: { message: 'bad key' } } },
    { status: 429, json: { error: { message: 'slow down' } } },
    { status: 503, json: { error: { message: 'down' } } },
    notFound,
    { status: 200, json: { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna-mini' }] } },
  ]);
  const studio = await startStudio({ service: { openaiBaseUrl: `${remote.url}/v1/` } });
  try {
    const missing = await studio.post('/describe', { description: 'a tree' });
    assert.equal(missing.status, 404);
    const errorMessage = (await missing.json()).error;
    assert.match(errorMessage, /could not find the model gpt-6-luna/);
    assert.match(errorMessage, /does not exist/);
    assert.ok(!errorMessage.includes(FAKE_KEY));
    for (const [status, pattern] of [
      [401, /rejected the saved API key/],
      [429, /rate limit/],
      [503, /server problem/],
    ]) {
      const failed = await studio.post('/describe', { description: 'a tree' });
      assert.equal(failed.status, status);
      assert.match((await failed.json()).error, pattern);
    }
    const checked = await (await studio.post('/describe/check')).json();
    assert.equal(checked.exists, false);
    assert.deepEqual(checked.models, ['gpt-6-luna-mini', 'gpt-6.1-sol']);
  } finally {
    await studio.close();
    await remote.close();
  }
});

test('the provider and model id are saved server-side and used on the next request', async () => {
  const remote = await fakeOpenAI([outputText({ params: {} })]);
  const studio = await startStudio({ service: { openaiBaseUrl: `${remote.url}/v1/` } });
  try {
    studio.settings.set({
      feature: 'vegetation-describe',
      provider: 'openai',
      model: 'my-model-7',
    });
    const reopened = createAiAssistSettings({ directory: studio.settingsDirectory });
    assert.equal(reopened.get('vegetation-describe').model, 'my-model-7');
    await studio.post('/describe', { description: 'a tree', species: 'fakeTree' });
    assert.equal(JSON.parse(remote.seen[0].body).model, 'my-model-7');
    assert.equal((await (await studio.get('/describe')).json()).model, 'my-model-7');
  } finally {
    await studio.close();
    await remote.close();
  }
});

test('the local provider uses the running chat engine, never OpenAI and never starts it', async () => {
  const openai = await fakeOpenAI([]);
  const local = [];
  const engine = await listen(async (req, res) => {
    const body = await readBody(req);
    local.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/health') {
      return res.end('{"status":"ok"}');
    }
    return res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"params": {"height": 12, "levels": 1}}' } }],
      }),
    );
  });
  const studio = await startStudio({
    service: { openaiBaseUrl: `${openai.url}/v1/`, localChatUrl: engine.url },
  });
  try {
    studio.settings.set({ feature: 'vegetation-describe', provider: 'local', model: 'gpt-6-luna' });
    const status = await (await studio.get('/describe')).json();
    assert.equal(status.provider, 'local');
    assert.equal(status.localChatRunning, true);
    assert.match(status.notice, /local chat model on this computer/);
    const { suggestion } = await (
      await studio.post('/describe', { description: 'a small tree', species: 'fakeTree' })
    ).json();
    assert.deepEqual(suggestion.params, { height: 12 });
    assert.equal(suggestion.provider, 'local');
    assert.equal(suggestion.model, 'qwen3.8-27b');
    assert.equal(studio.keyReads.count, 0, 'the OpenAI key is not read for the local provider');
    assert.equal(openai.seen.length, 0);
    const chat = local.find((item) => item.url === '/v1/chat/completions');
    assert.equal(chat.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(chat.body).response_format, { type: 'json_object' });
    assert.deepEqual(
      local
        .map((item) => item.url)
        .filter((url) => url !== '/health' && url !== '/v1/chat/completions'),
      [],
      'only health and completions are requested, nothing that starts a model',
    );
  } finally {
    await studio.close();
    await engine.close();
    await openai.close();
  }
});

test('with the local chat model stopped, Describe it says so and starts nothing', async () => {
  const closed = await listen(() => {});
  const deadUrl = closed.url;
  await closed.close();
  const studio = await startStudio({ service: { localChatUrl: deadUrl } });
  try {
    studio.settings.set({ feature: 'vegetation-describe', provider: 'local', model: 'gpt-6-luna' });
    const status = await (await studio.get('/describe')).json();
    assert.equal(status.localChatRunning, false);
    const reply = await studio.post('/describe', { description: 'a tree', species: 'fakeTree' });
    assert.equal(reply.status, 409);
    const body = await reply.json();
    assert.equal(body.code, 'chat_model_unavailable');
    assert.match(body.error, /Start chat model/);
  } finally {
    await studio.close();
  }
});
