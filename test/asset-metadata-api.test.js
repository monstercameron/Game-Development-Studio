import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DB_NAME, readAssetMeta } from '../runtime/asset-metadata.js';

function setEnvironment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (before === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = before;
      }
    });
  }
}

test('asset details API backfills, searches, and follows rename, trash, restore and permanent delete', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-meta-api-'));
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-meta-runtime-'));
  t.after(() =>
    Promise.all([root, runtime].map((dir) => fs.rm(dir, { recursive: true, force: true }))),
  );
  setEnvironment(t, { FORGE_PROJECTS_DIR: root, FORGE_RUNTIME_DIR: runtime });
  const { projectsService } = await import(`../projects.js?meta-api=${randomUUID()}`);
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
  const origin = `http://127.0.0.1:${server.address().port}`;

  const id = randomUUID(),
    folder = path.join(root, 'fixture'),
    jobId = randomUUID(),
    asset = `images/forge-${jobId}.png`;
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.mkdir(path.join(folder, 'text'), { recursive: true });
  await fs.writeFile(
    path.join(folder, '.forge-project.json'),
    JSON.stringify({ id, name: 'Fixture', createdAt: new Date().toISOString() }),
  );
  await fs.writeFile(path.join(folder, asset), 'png');
  await fs.writeFile(path.join(folder, 'images', 'hand-drawn.png'), 'png');
  // A pre-existing job record, in the same schema the queue uses.
  const db = new DatabaseSync(path.join(runtime, 'jobs.sqlite'));
  db.exec(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, remote_id TEXT, stage TEXT, error TEXT, output TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, details TEXT)',
  );
  db.prepare(
    'INSERT INTO jobs (id,type,project_id,request,status,output,created_at,updated_at,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    jobId,
    'images',
    id,
    JSON.stringify({
      prompt: 'A bronze compass on a map',
      width: 1024,
      height: 576,
      num_inference_steps: 30,
      references: [],
      seed: 12,
    }),
    'completed',
    asset,
    '2026-11-07T10:00:00.000Z',
    '2026-11-07T10:01:00.000Z',
    '2026-11-07T10:00:05.000Z',
    '2026-11-07T10:01:00.000Z',
  );
  db.close();
  const jobsBefore = await fs.readFile(path.join(runtime, 'jobs.sqlite'));

  const base = `${origin}/api/projects/${id}/assets`;
  const get = async (suffix) => {
    const response = await fetch(`${base}/${suffix}`);
    return { status: response.status, body: await response.json() };
  };
  const post = (action, body) =>
    fetch(`${base}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project', Origin: origin },
      body: JSON.stringify(body),
    });

  // Lazy backfill on first read.
  let result = await get(`details?path=${encodeURIComponent(asset)}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.metadata.prompt.text, 'A bronze compass on a map');
  assert.equal(result.body.metadata.model.name, 'Qwen Image 2.1');
  assert.equal(result.body.metadata.backfilled, true);
  assert.equal(result.body.metadata.seed, 12);
  assert.equal(result.body.metadata.timing.seconds, 55);
  // Files without a known origin say so; unknown paths are rejected.
  result = await get('details?path=images%2Fhand-drawn.png');
  assert.deepEqual(result.body, { metadata: null });
  assert.equal((await get('details?path=images%2Fnope.png')).status, 404);
  assert.equal((await get('details?path=..%2Fsecret.png')).status, 404);

  // The database is hidden: it is never listed as an asset, nor are its companions.
  const listing = await (await fetch(`${origin}/api/projects/`)).json();
  const listed = listing.projects.find((item) => item.id === id).assets.map((item) => item.id);
  assert.deepEqual(listed.sort(), [asset, 'images/hand-drawn.png'].sort());
  assert.ok((await fs.readdir(folder)).includes(DB_NAME));

  // Index and search are single requests.
  result = await get('details-index');
  assert.equal(result.body.assets[asset].model, 'Qwen Image 2.1');
  assert.ok(!('images/hand-drawn.png' in result.body.assets));
  assert.deepEqual((await get('search?q=compass')).body.paths, [asset]);
  assert.deepEqual((await get('search?q=qwen')).body.paths, [asset]);
  assert.deepEqual((await get('search?q=zebra')).body.paths, []);

  // Rename keeps the details with the file.
  let response = await post('rename', { path: asset, name: 'compass-final.png' });
  assert.equal(response.status, 200);
  const renamed = 'images/compass-final.png';
  result = await get(`details?path=${encodeURIComponent(renamed)}`);
  assert.equal(result.body.metadata.prompt.text, 'A bronze compass on a map');
  assert.equal(readAssetMeta(folder, asset), null);
  assert.deepEqual((await get('search?q=compass')).body.paths, [renamed]);

  // Trash and restore keep the record; permanently clearing the trash removes it.
  response = await post('trash', { path: renamed });
  const { trashId } = await response.json();
  assert.equal((await get(`details?path=${encodeURIComponent(renamed)}`)).status, 404);
  assert.equal(readAssetMeta(folder, renamed).model.name, 'Qwen Image 2.1');
  response = await post('restore', { trashId });
  assert.equal(response.status, 200);
  assert.equal(
    (await get(`details?path=${encodeURIComponent(renamed)}`)).body.metadata.model.name,
    'Qwen Image 2.1',
  );
  await post('trash', { path: renamed });
  response = await post('clear-trash', { confirmation: 'permanently-delete-trash' });
  assert.deepEqual(await response.json(), { deleted: 1 });
  assert.equal(readAssetMeta(folder, renamed), null);
  assert.deepEqual((await get('search?q=compass')).body.paths, []);

  // Saved text records the model and prompt it was produced from.
  response = await post('create-text', {
    kind: 'chat',
    content: 'A tavern description',
    provenance: {
      model: { name: 'qwen3.8-27b', id: 'compatible' },
      prompt: 'Describe a tavern',
      settings: { temperature: 0.7, apiKey: 'secret-value' },
    },
  });
  assert.equal(response.status, 201);
  const saved = (await response.json()).path;
  result = await get(`details?path=${encodeURIComponent(saved)}`);
  assert.equal(result.body.metadata.source, 'saved-text');
  assert.equal(result.body.metadata.prompt.text, 'Describe a tavern');
  assert.deepEqual(result.body.metadata.settings, { temperature: 0.7 });
  assert.deepEqual((await get('search?q=tavern')).body.paths, [saved]);
  response = await post('create-text', { kind: 'decision', content: '{"choice":1}' });
  const decision = (await response.json()).path;
  assert.equal(
    (await get(`details?path=${encodeURIComponent(decision)}`)).body.metadata.model.name,
    'Mammoth-1',
  );

  // The jobs database is only ever read.
  assert.deepEqual(await fs.readFile(path.join(runtime, 'jobs.sqlite')), jobsBefore);
});

test('a corrupt project database does not break the asset listing or details route', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-meta-corrupt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  setEnvironment(t, {
    FORGE_PROJECTS_DIR: root,
    FORGE_RUNTIME_DIR: path.join(root, 'no-runtime'),
  });
  const { projectsService } = await import(`../projects.js?meta-corrupt=${randomUUID()}`);
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = randomUUID(),
    folder = path.join(root, 'fixture'),
    asset = `images/forge-${randomUUID()}.png`;
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(
    path.join(folder, '.forge-project.json'),
    JSON.stringify({ id, name: 'Fixture', createdAt: new Date().toISOString() }),
  );
  await fs.writeFile(path.join(folder, asset), 'png');
  await fs.writeFile(path.join(folder, DB_NAME), 'garbage'.repeat(100));
  const listing = await (await fetch(`${origin}/api/projects/`)).json();
  assert.equal(listing.projects[0].assets.length, 1);
  const response = await fetch(
    `${origin}/api/projects/${id}/assets/details?path=${encodeURIComponent(asset)}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { metadata: null });
});
