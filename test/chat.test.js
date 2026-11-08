import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { chatService } from '../runtime/chat-service.js';

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('chat proxy streams structured requests and does not forward API keys to compatible servers', async () => {
  const upstream = express();
  upstream.use(express.json());
  let request;
  upstream.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'qwen3.8-27b' }] }));
  upstream.post('/v1/chat/completions', (req, res) => {
    request = { body: req.body, auth: req.headers.authorization };
    res
      .type('text/event-stream')
      .send('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  });
  const server = await listen(upstream);
  const app = express();
  chatService().configureServer({ middlewares: app });
  const forge = await listen(app);
  const origin = `http://127.0.0.1:${forge.address().port}`;
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const post = (route, body, extra = {}) =>
    fetch(origin + '/api/chat/' + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forge-Request': 'chat',
        ...extra,
      },
      body: JSON.stringify(body),
    });
  try {
    let r = await post('models', { provider: 'compatible', endpoint, apiKey: 'should-not-leak' });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).models, ['qwen3.8-27b']);
    r = await post('completions', {
      provider: 'compatible',
      endpoint,
      apiKey: 'should-not-leak',
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'hi' }],
      format: 'schema',
      schema: { type: 'object' },
      effort: 'high',
    });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /hello/);
    assert.equal(request.auth, undefined);
    assert.equal(request.body.response_format.json_schema.strict, true);
    assert.equal(request.body.reasoning_effort, 'high');
    assert.equal(request.body.reasoning_budget_tokens, undefined);
    r = await post('completions', {
      provider: 'compatible',
      endpoint,
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16384,
    });
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(request.body.max_tokens, 16384);
    r = await post('completions', {
      provider: 'compatible',
      endpoint,
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 262145,
    });
    assert.equal(r.status, 400);
    r = await post('completions', {
      provider: 'compatible',
      endpoint,
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
      effort: 'unexpected',
    });
    assert.equal(r.status, 400);
    r = await post('models', { provider: 'compatible', endpoint: 'http://169.254.169.254/latest' });
    assert.equal(r.status, 400);
    r = await post(
      'models',
      { provider: 'compatible', endpoint },
      { Origin: 'http://attacker.example' },
    );
    assert.equal(r.status, 403);
  } finally {
    forge.closeAllConnections();
    server.closeAllConnections();
    await Promise.all([new Promise((r) => forge.close(r)), new Promise((r) => server.close(r))]);
  }
});

test('local Qwen thinking effort carries an explicit per-request budget', async (t) => {
  const upstream = express();
  upstream.use(express.json());
  let body;
  upstream.post('/v1/chat/completions', (req, res) => {
    body = req.body;
    res.type('text/event-stream').send('data: [DONE]\n\n');
  });
  const local = http.createServer(upstream);
  try {
    await new Promise((resolve, reject) => {
      local.once('error', reject);
      local.listen(8098, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      t.skip('Local model port is in use');
      return;
    }
    throw error;
  }
  const app = express();
  chatService().configureServer({ middlewares: app });
  const forge = await listen(app);
  const origin = `http://127.0.0.1:${forge.address().port}`;
  try {
    const send = (effort) =>
      fetch(origin + '/api/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forge-Request': 'chat' },
        body: JSON.stringify({
          provider: 'compatible',
          endpoint: 'http://127.0.0.1:8098/v1',
          model: 'qwen3.8-27b',
          messages: [{ role: 'user', content: 'hi' }],
          effort,
        }),
      });
    let r = await send('medium');
    await r.text();
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.reasoning_budget_tokens, 768);
    assert.equal(body.chat_template_kwargs.enable_thinking, true);
    r = await send('none');
    await r.text();
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.reasoning_budget_tokens, undefined);
  } finally {
    forge.closeAllConnections();
    local.closeAllConnections();
    await Promise.all([new Promise((r) => forge.close(r)), new Promise((r) => local.close(r))]);
  }
});

test('a refused local server is reported distinctly so chat can start it', async () => {
  const app = express();
  chatService({
    fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    },
  }).configureServer({ middlewares: app });
  const forge = await listen(app);
  const origin = `http://127.0.0.1:${forge.address().port}`;
  try {
    const r = await fetch(origin + '/api/chat/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forge-Request': 'chat' },
      body: JSON.stringify({ provider: 'compatible', endpoint: 'http://127.0.0.1:8098/v1' }),
    });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, 'server_unreachable');
  } finally {
    forge.closeAllConnections();
    await new Promise((resolve) => forge.close(resolve));
  }
});

test('requests streamed token usage only from supported endpoints', async () => {
  const payloads = [];
  const app = express();
  chatService({
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  }).configureServer({ middlewares: app });
  const forge = await listen(app);
  const origin = `http://127.0.0.1:${forge.address().port}`;
  const post = (body) =>
    fetch(origin + '/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forge-Request': 'chat' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
  try {
    for (const body of [
      { provider: 'compatible', endpoint: 'http://127.0.0.1:8098/v1' },
      { provider: 'openai', apiKey: 'test' },
      { provider: 'compatible', endpoint: 'http://127.0.0.1:9999/v1' },
    ]) {
      const r = await post(body);
      assert.equal(r.status, 200);
      await r.text();
    }
    assert.deepEqual(payloads[0].stream_options, { include_usage: true });
    assert.deepEqual(payloads[1].stream_options, { include_usage: true });
    assert.equal(payloads[2].stream_options, undefined);
  } finally {
    forge.closeAllConnections();
    await new Promise((resolve) => forge.close(resolve));
  }
});
