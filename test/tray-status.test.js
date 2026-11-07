import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import express from 'express';
import { trayStatusService } from '../runtime/tray-status.js';

test('tray status reports fresh native settings and falls back on stale or invalid heartbeats', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tray-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = express();
  let now = Date.now();
  trayStatusService({ directory: root, now: () => now }).configureServer({ middlewares: app });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/tray/status`;
  assert.deepEqual(await (await fetch(url)).json(), { active: false });
  const file = path.join(root, `tray-status-${port}.json`);
  await fs.writeFile(file, '\uFEFF' + JSON.stringify({ render: true, queue: false }));
  now = Date.now() + 100;
  assert.deepEqual(await (await fetch(url)).json(), { active: true, render: true, queue: false });
  now += 16000;
  assert.deepEqual(await (await fetch(url)).json(), { active: false });
  now = Date.now() + 100;
  await fs.writeFile(file, 'invalid');
  assert.deepEqual(await (await fetch(url)).json(), { active: false });
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { host: 'attacker.example:1234' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});
