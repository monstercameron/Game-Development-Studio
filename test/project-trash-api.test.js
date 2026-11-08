import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

test('project trash HTTP API lists, restores, and requires confirmation and local origin to clear', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trash-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = process.env.FORGE_PROJECTS_DIR;
  process.env.FORGE_PROJECTS_DIR = root;
  t.after(() => {
    if (before === undefined) {
      delete process.env.FORGE_PROJECTS_DIR;
    } else {
      process.env.FORGE_PROJECTS_DIR = before;
    }
  });
  const { projectsService } = await import(`../runtime/projects.js?trash-test=${randomUUID()}`);
  let handler;
  projectsService().configureServer({
    middlewares: {
      use: (_prefix, callback) => {
        handler = callback;
      },
    },
  });
  const server = createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/projects/, '');
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`,
    id = randomUUID(),
    folder = path.join(root, 'fixture');
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(
    path.join(folder, '.forge-project.json'),
    JSON.stringify({ id, name: 'Fixture', createdAt: new Date().toISOString() }),
  );
  await fs.writeFile(path.join(folder, 'images', 'asset.png'), 'fixture');
  const endpoint = `${origin}/api/projects/${id}/assets/`;
  async function post(action, body, allowed = true) {
    return fetch(endpoint + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forge-Request': 'project',
        Origin: allowed ? origin : 'http://untrusted.example',
      },
      body: JSON.stringify(body),
    });
  }
  let response = await post('trash', { path: 'images/asset.png' });
  assert.equal(response.status, 200);
  const { trashId } = await response.json();
  assert.equal((await (await fetch(endpoint + 'trash')).json()).items[0].trashId, trashId);
  response = await post('clear-trash', { confirmation: 'permanently-delete-trash' }, false);
  assert.equal(response.status, 403);
  response = await post('clear-trash', {});
  assert.equal(response.status, 400);
  response = await post('restore', { trashId });
  assert.equal(response.status, 200);
  assert.equal(await fs.readFile(path.join(folder, 'images', 'asset.png'), 'utf8'), 'fixture');
  await post('trash', { path: 'images/asset.png' });
  response = await post('clear-trash', { confirmation: 'permanently-delete-trash' });
  assert.deepEqual(await response.json(), { deleted: 1 });
  assert.equal((await (await fetch(endpoint + 'trash')).json()).items.length, 0);
});
