import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { chatService } from '../runtime/chat-service.js';

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('chat model listing skips invalid upstream entries and keeps valid model IDs', async () => {
  const upstream = express();
  upstream.get('/v1/models', (_req, res) =>
    res.json({ data: [null, { id: 'qwen-local' }, { id: 42 }, 'invalid', { id: 'other' }] }),
  );
  const upstreamServer = await listen(upstream);
  const app = express();
  chatService().configureServer({ middlewares: app });
  const forgeServer = await listen(app);
  const origin = `http://127.0.0.1:${forgeServer.address().port}`;

  try {
    const response = await fetch(`${origin}/api/chat/models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Forge-Request': 'chat',
      },
      body: JSON.stringify({
        provider: 'compatible',
        endpoint: `http://127.0.0.1:${upstreamServer.address().port}/v1`,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).models, ['qwen-local', 'other']);
  } finally {
    forgeServer.closeAllConnections();
    upstreamServer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => forgeServer.close(resolve)),
      new Promise((resolve) => upstreamServer.close(resolve)),
    ]);
  }
});
