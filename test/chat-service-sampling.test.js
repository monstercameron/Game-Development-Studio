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

// Starts the Forge chat proxy with a fake upstream that records the outgoing request.
async function harness() {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const app = express();
  chatService({ fetchImpl }).configureServer({ middlewares: app });
  const forge = await listen(app);
  const origin = `http://127.0.0.1:${forge.address().port}`;
  const complete = (body) =>
    fetch(origin + '/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forge-Request': 'chat' },
      body: JSON.stringify(body),
    });
  return { sent, complete, close: () => forge.close() };
}

const local = {
  provider: 'compatible',
  endpoint: 'http://127.0.0.1:8098/v1',
  model: 'qwen3.8-27b',
  messages: [{ role: 'user', content: 'hi' }],
};

test('sampling options reach a compatible server under OpenAI field names', async () => {
  const h = await harness();
  try {
    const r = await h.complete({
      ...local,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      presencePenalty: 0.2,
      frequencyPenalty: 0.1,
      seed: 42,
      stop: ['END'],
    });
    assert.equal(r.status, 200);
    await r.text();
    const body = h.sent[0].body;
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
    assert.equal(body.min_p, 0.05);
    assert.equal(body.presence_penalty, 0.2);
    assert.equal(body.frequency_penalty, 0.1);
    assert.equal(body.seed, 42);
    assert.deepEqual(body.stop, ['END']);
  } finally {
    h.close();
  }
});

test('out-of-range sampling is refused before anything is sent upstream', async () => {
  const h = await harness();
  try {
    const r = await h.complete({ ...local, topP: 3 });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Top-p must be above 0 up to 1/);
    assert.equal(h.sent.length, 0);
  } finally {
    h.close();
  }
});

test('top-k is refused for the OpenAI provider', async () => {
  const h = await harness();
  try {
    const r = await h.complete({
      provider: 'openai',
      apiKey: 'test-key-not-real',
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      topK: 40,
    });
    assert.equal(r.status, 400);
    assert.equal(h.sent.length, 0);
  } finally {
    h.close();
  }
});

test('a non-numeric temperature is refused instead of silently becoming 0', async () => {
  const h = await harness();
  try {
    const r = await h.complete({ ...local, temperature: 'warm' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Temperature must be a number from 0 to 2/);
    assert.equal(h.sent.length, 0);
  } finally {
    h.close();
  }
});

test('Thinking Off on the local engine disables the chat template thinking', async () => {
  const h = await harness();
  try {
    const off = await h.complete({ ...local, effort: 'none' });
    await off.text();
    assert.deepEqual(h.sent[0].body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(h.sent[0].body.reasoning_budget_tokens, undefined);
    const low = await h.complete({ ...local, effort: 'low' });
    await low.text();
    assert.deepEqual(h.sent[1].body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(h.sent[1].body.reasoning_budget_tokens, 256);
  } finally {
    h.close();
  }
});

test('Thinking High reaches the Qwen template as xhigh, other servers keep high', async () => {
  // The Qwen3.8 template rejects "high" with an HTTP 500 (seen live on llama.cpp b12180).
  const h = await harness();
  try {
    const high = await h.complete({ ...local, effort: 'high' });
    await high.text();
    assert.equal(h.sent[0].body.reasoning_effort, 'xhigh');
    assert.equal(h.sent[0].body.reasoning_budget_tokens, 1536);
    const other = await h.complete({
      ...local,
      endpoint: 'http://127.0.0.1:1234/v1',
      effort: 'high',
    });
    await other.text();
    assert.equal(h.sent[1].body.reasoning_effort, 'high');
    assert.equal(h.sent[1].body.reasoning_budget_tokens, undefined);
  } finally {
    h.close();
  }
});
