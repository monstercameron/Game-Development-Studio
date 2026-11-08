import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

test('thumbnail API caches visual assets, rejects stale updates and refreshes when source changes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-thumbnails-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previousProjectsDir = process.env.FORGE_PROJECTS_DIR;
  process.env.FORGE_PROJECTS_DIR = root;
  t.after(() => {
    if (previousProjectsDir === undefined) {
      delete process.env.FORGE_PROJECTS_DIR;
    } else {
      process.env.FORGE_PROJECTS_DIR = previousProjectsDir;
    }
  });
  const { projectsService } = await import(`../runtime/projects.js?thumbnail-test=${randomUUID()}`);
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
  const file = path.join(folder, 'images', 'asset.png');
  await fs.writeFile(file, 'original');
  const listing = await (await fetch(`${origin}/api/projects`)).json(),
    asset = listing.projects[0].assets[0];
  const endpoint = `${origin}/api/projects/${id}/thumbnail?path=${encodeURIComponent(asset.id)}`;
  // A 1x1 PNG keeps the cached payload tiny. The server accepts an upload only when its size and
  // modified time match the source asset it describes.
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const post = (body, source = origin) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project', Origin: source },
      body: JSON.stringify(body),
    });
  assert.equal((await fetch(endpoint)).status, 404);
  assert.equal(
    (await post({ image, size: asset.size, modified: asset.modified }, 'http://untrusted.example'))
      .status,
    403,
  );
  assert.equal((await post({ image, size: asset.size + 1, modified: asset.modified })).status, 400);
  assert.equal(
    (
      await post({
        image: 'data:image/png;base64,AAAA',
        size: asset.size,
        modified: asset.modified,
      })
    ).status,
    400,
  );
  assert.equal((await post({ image, size: asset.size, modified: asset.modified })).status, 201);
  const cached = await fetch(endpoint);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get('content-type'), 'image/png');
  assert.deepEqual(
    Buffer.from(await cached.arrayBuffer()),
    Buffer.from(image.split(',')[1], 'base64'),
  );
  // Changing the source alters its size and modified time, so the cached thumbnail must stop
  // being served and the old client values must be refused.
  await fs.writeFile(file, 'changed and longer');
  assert.equal((await fetch(endpoint)).status, 404);
  assert.equal((await post({ image, size: asset.size, modified: asset.modified })).status, 400);
});
