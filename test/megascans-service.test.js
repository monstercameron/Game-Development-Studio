import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAssetMeta } from '../runtime/asset-metadata.js';
import { megascansService, sweepOrphanStaging } from '../runtime/megascans-service.js';
import { PNG, fakeId, startFakeFab } from './fixtures/fake-fab.js';
import { buildZip, tinyGlb } from './fixtures/zip-builder.js';

const PROJECT_ID = '0f6bd0a2-5d35-4ef9-a6a0-6a6a3f6d1f11';
const LISTING_ID = '854ffc09-e07f-45c2-9569-37cb7c4ab9c2';
const quiet = { info() {}, warn() {}, error() {} };

async function startService(t, serviceOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-svc-'));
  const projectsRoot = path.join(root, 'projects');
  const folder = path.join(projectsRoot, 'My Game');
  await fs.mkdir(path.join(folder, '3d'), { recursive: true });
  await fs.writeFile(
    path.join(folder, '.forge-project.json'),
    JSON.stringify({ id: PROJECT_ID, name: 'My Game', createdAt: new Date().toISOString() }),
  );
  const service = megascansService({
    directory: path.join(root, 'runtime'),
    projectsRoot,
    thumbsDirectory: path.join(root, 'thumbs'),
    // Nothing in these tests may reach fab.com: an unreachable loopback port is the default.
    fabBaseUrl: serviceOptions.fabBaseUrl || 'http://127.0.0.1:9',
    fabMinIntervalMs: 5,
    fabImageIntervalMs: 5,
    scanMaxPages: 2,
    logger: quiet,
    ...serviceOptions,
  });
  let handler;
  service.configureServer({
    middlewares: {
      use: (_prefix, callback) => {
        handler = callback;
      },
    },
  });
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/megascans/, '') || '/';
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    service.state?.runner.stop();
    await service.state?.runner.idle();
    server.closeAllConnections();
    server.close();
    service.state?.handle.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (method, route, { body, headers = {}, raw } = {}) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const response = await fetch(`${origin}/api/megascans${route}`, {
      method,
      headers: {
        ...(method === 'POST'
          ? {
              Origin: origin,
              'X-Forge-Request': 'megascans',
              ...(raw ? {} : { 'Content-Type': 'application/json' }),
            }
          : {}),
        ...headers,
      },
      body: payload,
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const waitFor = async (id, statuses) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const { data } = await call('GET', `/imports/${id}`);
      if (statuses.includes(data.import.status)) {
        return data.import;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the import.');
  };
  const upload = (bytes, { filename = 'pack.zip', listing, project = PROJECT_ID } = {}) =>
    call(
      'POST',
      `/imports?project=${project}&filename=${encodeURIComponent(filename)}${listing ? `&listing=${listing}` : ''}`,
      { raw: bytes },
    );
  return { call, waitFor, upload, folder, root, service, origin };
}

test('status reports what is automated: Fab metadata yes, downloads only after confirmation', async (t) => {
  const { call } = await startService(t);
  const { status, data } = await call('GET', '/status');
  assert.equal(status, 200);
  assert.equal(data.fabMetadata, true);
  assert.equal(data.automatedDownload, false);
  assert.match(data.downloadNote, /only after you confirm/);
  assert.equal(data.fab.downloads.confirmed, false);
  assert.equal(data.fab.cache.stale, true);
  assert.equal(data.fab.scan.status, 'idle');
  assert.equal(data.limits.maxConcurrent, 2);
  assert.ok(data.limits.extensions.includes('.zip'));
  assert.match(data.sellerUrl, /^https:\/\/www\.fab\.com\/sellers\/Quixel%20Megascans/);
});

test('routes enforce loopback host, studio origin and the request header on writes', async (t) => {
  const { origin, call } = await startService(t);
  const post = (headers) =>
    fetch(`${origin}/api/megascans/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ url: LISTING_ID, title: 'x' }),
    });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Origin: origin })).status, 403);
  assert.equal(
    (await post({ Origin: 'http://evil.example', 'X-Forge-Request': 'megascans' })).status,
    403,
  );
  assert.equal((await post({ Origin: origin, 'X-Forge-Request': 'project' })).status, 403);
  assert.equal((await post({ Origin: origin, 'X-Forge-Request': 'megascans' })).status, 201);
  assert.equal((await call('GET', '/unknown')).status, 404);
  const put = await fetch(`${origin}/api/megascans/listings`, { method: 'PUT' });
  assert.equal(put.status, 405);
});

test('listings can be added, searched, shown with their imports and removed', async (t) => {
  const { call } = await startService(t);
  const bad = await call('POST', '/listings', {
    body: { url: 'https://example.com/listings/x', title: 'x' },
  });
  assert.equal(bad.status, 400);
  const added = await call('POST', '/listings', {
    body: {
      url: `https://www.fab.com/listings/${LISTING_ID}?x=1`,
      title: 'Old Crate',
      tags: 'wood, crate',
    },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.listing.url, `https://www.fab.com/listings/${LISTING_ID}`);
  const found = await call('GET', '/listings?q=crat&tag=wood&sort=title&page=1');
  assert.equal(found.data.total, 1);
  assert.deepEqual(found.data.tags, [
    { tag: 'crate', count: 1 },
    { tag: 'wood', count: 1 },
  ]);
  assert.equal((await call('GET', `/listings/${LISTING_ID}`)).data.listing.title, 'Old Crate');
  assert.equal((await call('GET', '/listings/not-an-id')).status, 404);
  assert.equal(
    (await call('POST', `/listings/${LISTING_ID}/remove`, { body: {} })).data.removed,
    true,
  );
  assert.equal((await call('GET', `/listings/${LISTING_ID}`)).status, 404);
});

test('an uploaded archive is imported into the project with recorded provenance', async (t) => {
  const { call, upload, waitFor, folder } = await startService(t);
  await call('POST', '/listings', {
    body: { url: LISTING_ID, title: 'Old Wooden Crate', tags: ['wood'] },
  });
  const zip = buildZip([
    { name: 'Crate/crate.fbx', data: 'Kaydara FBX Binary  \0' },
    { name: 'Crate/Textures/crate_albedo.png', data: Buffer.alloc(1024, 3) },
    { name: 'Crate/readme.pdf', data: 'x' },
  ]);
  const queued = await upload(zip, { filename: 'Crate.zip', listing: LISTING_ID });
  assert.equal(queued.status, 201);
  assert.equal(
    queued.data.import.status === 'queued' || queued.data.import.status === 'running',
    true,
  );
  const finished = await waitFor(queued.data.import.id, ['completed', 'failed']);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.output.skipped, 1);
  const rel = finished.output.files[0];
  assert.match(rel, /^3d\/megascans-old-wooden-crate-[0-9a-f]{8}\/crate\.fbx$/);
  assert.equal((await fs.stat(path.join(folder, ...rel.split('/')))).isFile(), true);
  assert.deepEqual(await fs.readdir(path.join(folder, '.forge-staging', 'megascans')), []);

  const meta = readAssetMeta(await fs.realpath(folder), rel);
  assert.equal(meta.source, 'import');
  assert.equal(meta.prompt.title, 'Old Wooden Crate');
  assert.equal(meta.settings.seller, 'Quixel Megascans');
  assert.equal(meta.settings.license, 'Fab Standard License');
  assert.equal(meta.settings.fab_listing_id, LISTING_ID);
  assert.equal(meta.settings.source_link, `https://www.fab.com/listings/${LISTING_ID}`);
  assert.match(meta.settings.attribution, /Old Wooden Crate by Quixel Megascans/);

  const detail = await call('GET', `/listings/${LISTING_ID}`);
  assert.equal(detail.data.imports[0].status, 'completed');
  const listed = await call('GET', '/imports');
  assert.equal(listed.data.summary.completed, 1);
  // Dismissing removes the record only; the project file stays.
  assert.equal((await call('POST', `/imports/${finished.id}/dismiss`, { body: {} })).status, 200);
  assert.equal((await call('GET', `/imports/${finished.id}`)).status, 404);
  await fs.stat(path.join(folder, ...rel.split('/')));
});

test('a single GLB file is imported without a listing', async (t) => {
  const { upload, waitFor, folder } = await startService(t);
  const queued = await upload(tinyGlb(), { filename: 'Scan One.glb' });
  const finished = await waitFor(queued.data.import.id, ['completed', 'failed']);
  assert.equal(finished.status, 'completed', finished.error);
  assert.match(finished.output.files[0], /^3d\/scan-one-[0-9a-f]{8}\.glb$/);
  const meta = readAssetMeta(await fs.realpath(folder), finished.output.files[0]);
  assert.equal(meta.prompt.title, 'Scan One');
  assert.equal(meta.settings.fab_listing_id, undefined);
});

test('hostile or unusable uploads fail with a plain message and write nothing', async (t) => {
  const { upload, waitFor, folder, root } = await startService(t);
  const cases = [
    [buildZip([{ name: '../../escape.glb', data: tinyGlb() }]), /outside its folder/],
    [
      buildZip([
        { name: 'a.glb', data: tinyGlb() },
        { name: 'setup.exe', data: 'MZ' },
      ]),
      /executable or script/,
    ],
    [buildZip([{ name: 'a.png', data: 'x' }]), /No supported 3D model/],
    [Buffer.from('this is not a zip file at all, just text.'), /not a readable ZIP|too small|ZIP/],
  ];
  for (const [bytes, pattern] of cases) {
    const queued = await upload(bytes);
    assert.equal(queued.status, 201);
    const finished = await waitFor(queued.data.import.id, ['failed', 'completed']);
    assert.equal(finished.status, 'failed');
    assert.match(finished.error, pattern);
    assert.doesNotMatch(finished.error, new RegExp(path.basename(root)));
  }
  assert.deepEqual(await fs.readdir(path.join(folder, '3d')), []);
  assert.equal((await fs.readdir(root)).includes('escape.glb'), false);
  assert.equal((await fs.readdir(path.join(root, 'projects'))).includes('escape.glb'), false);
});

test('uploads are validated before anything is stored', async (t) => {
  const { upload, call, folder } = await startService(t, { maxUploadBytes: 5000 });
  assert.equal((await upload(Buffer.alloc(6000, 1))).status, 413);
  assert.equal((await upload(tinyGlb(), { filename: 'setup.exe' })).status, 400);
  assert.equal((await upload(tinyGlb(), { filename: 'model.uasset' })).status, 400);
  assert.equal(
    (await upload(tinyGlb(), { filename: '../../x.glb', project: 'not-a-uuid' })).status,
    400,
  );
  assert.equal(
    (await upload(tinyGlb(), { project: '11111111-1111-4111-8111-111111111111' })).status,
    404,
  );
  assert.equal((await upload(tinyGlb(), { listing: LISTING_ID })).status, 404);
  assert.equal((await call('GET', '/imports')).data.imports.length, 0);
  const staging = await fs
    .readdir(path.join(folder, '.forge-staging', 'megascans'))
    .catch(() => []);
  assert.deepEqual(staging, []);
});

test('an upload without a declared length is refused', async (t) => {
  const { origin } = await startService(t);
  const url = new URL(`${origin}/api/megascans/imports?project=${PROJECT_ID}&filename=a.glb`);
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: { Origin: origin, 'X-Forge-Request': 'megascans', 'Transfer-Encoding': 'chunked' },
      },
      (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode);
      },
    );
    request.on('error', reject);
    request.end(tinyGlb());
  });
  assert.equal(response, 411);
});

test('waiting imports can be cancelled, retried and dismissed, and dismissal removes staging', async (t) => {
  const { upload, call, folder } = await startService(t, { maxConcurrent: 0 });
  const queued = await upload(tinyGlb(), { filename: 'a.glb' });
  const id = queued.data.import.id;
  const staged = path.join(folder, '.forge-staging', 'megascans', id);
  await fs.stat(path.join(staged, 'upload.glb'));
  assert.equal((await call('POST', `/imports/${id}/dismiss`, { body: {} })).status, 409);
  const cancelled = await call('POST', `/imports/${id}/cancel`, { body: {} });
  assert.equal(cancelled.data.import.status, 'cancelled');
  assert.equal((await call('POST', `/imports/${id}/cancel`, { body: {} })).status, 409);
  const retried = await call('POST', `/imports/${id}/retry`, { body: {} });
  assert.equal(retried.data.import.status, 'queued');
  await call('POST', `/imports/${id}/cancel`, { body: {} });
  assert.equal((await call('POST', `/imports/${id}/dismiss`, { body: {} })).status, 200);
  await assert.rejects(fs.stat(staged));
  assert.equal((await call('POST', `/imports/${id}/retry`, { body: {} })).status, 404);
});

test('retry refuses when the staged upload was removed', async (t) => {
  const { upload, call, folder } = await startService(t, { maxConcurrent: 0 });
  const id = (await upload(tinyGlb(), { filename: 'a.glb' })).data.import.id;
  await call('POST', `/imports/${id}/cancel`, { body: {} });
  await fs.rm(path.join(folder, '.forge-staging', 'megascans', id), { recursive: true });
  const retry = await call('POST', `/imports/${id}/retry`, { body: {} });
  assert.equal(retry.status, 409);
  assert.match(retry.data.error, /Choose the file again/);
});

test('imports left running by a stopped studio come back interrupted and stay stopped', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-restart-'));
  const { openMegascansDb } = await import('../runtime/megascans-db.js');
  const { ImportQueue } = await import('../runtime/megascans-queue.js');
  const handle = openMegascansDb(path.join(root, 'runtime'));
  const queue = new ImportQueue(handle);
  queue.enqueue({
    id: PROJECT_ID,
    projectId: PROJECT_ID,
    filename: 'a.zip',
    kind: 'archive',
    uploadBytes: 1,
  });
  queue.claimNext();
  handle.close();
  const service = megascansService({
    directory: path.join(root, 'runtime'),
    projectsRoot: path.join(root, 'p'),
    logger: quiet,
  });
  const { queue: restarted, runner } = service.state;
  t.after(async () => {
    runner.stop();
    service.state.handle.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  assert.equal(restarted.get(PROJECT_ID).status, 'interrupted');
  runner.pump();
  await runner.idle();
  assert.equal(restarted.get(PROJECT_ID).status, 'interrupted', 'no automatic retry');
});

test('the orphan sweep removes only old staging folders that no import owns', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-sweep-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, 'Proj', '.forge-staging', 'megascans');
  for (const name of ['owned', 'old-orphan', 'new-orphan']) {
    await fs.mkdir(path.join(base, name), { recursive: true });
  }
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  await fs.utimes(path.join(base, 'owned'), old, old);
  await fs.utimes(path.join(base, 'old-orphan'), old, old);
  const removed = await sweepOrphanStaging(root, new Set(['owned']));
  assert.equal(removed, 1);
  assert.deepEqual((await fs.readdir(base)).sort(), ['new-orphan', 'owned']);
});

test('refresh, search, detail, thumbnails and scan work through the routes against a fake Fab', async (t) => {
  const fab = await startFakeFab({ total: 5, pageSize: 2 });
  t.after(() => fab.close());
  const { call, origin } = await startService(t, { fabBaseUrl: fab.base });

  const refreshed = await call('POST', '/refresh', { body: {} });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.added, 2);
  assert.equal(refreshed.data.fab.cache.listings, 2);
  assert.equal(refreshed.data.fab.cache.stale, false);
  assert.equal((await call('POST', '/refresh', { body: {} })).status, 429, 'one refresh a minute');

  const found = await call('GET', '/listings?q=crate+02');
  assert.equal(found.data.total, 1);
  const listing = found.data.listings[0];
  assert.equal(listing.source, 'fab');
  assert.equal(listing.thumbnailUrl, `/api/megascans/thumbs/${fakeId(2)}`);
  assert.equal(
    JSON.stringify(listing).includes('127.0.0.1'),
    false,
    'no Fab address leaks to the page',
  );

  const thumb = await fetch(`${origin}${listing.thumbnailUrl}`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/png');
  assert.equal(thumb.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), PNG);
  assert.equal((await fetch(`${origin}/api/megascans/thumbs/not-an-id`)).status, 404);

  const detail = await call('POST', `/listings/${fakeId(1)}/refresh`, { body: {} });
  assert.equal(detail.data.fetched, true);
  assert.match(detail.data.listing.detail.description, /Rustic crate & barrel/);

  assert.equal((await call('POST', '/scan', { body: { action: 'bogus' } })).status, 400);
  assert.equal((await call('POST', '/scan', { body: { action: 'start' } })).status, 202);
  await t.test('the scan finishes within its cap', async () => {
    const state = (await call('GET', '/status')).data;
    assert.ok(['running', 'capped', 'completed'].includes(state.fab.scan.status));
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await call('GET', '/scan')).data.scan.status !== 'running') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const scan = (await call('GET', '/scan')).data.scan;
  assert.equal(scan.status, 'capped');
  assert.equal(scan.pagesThisRun, 2);
  const resumed = await call('POST', '/scan', { body: { action: 'resume' } });
  assert.equal(resumed.status, 202);
  await call('POST', '/scan', { body: { action: 'cancel' } });
});

test('a block from Fab is reported plainly and nothing more is requested', async (t) => {
  const fab = await startFakeFab();
  t.after(() => fab.close());
  fab.state.mode = 'challenge';
  const { call } = await startService(t, { fabBaseUrl: fab.base });
  const blocked = await call('POST', '/refresh', { body: {} });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.blocked, true);
  assert.match(blocked.data.error, /Fab is blocking automated requests/);
  const requests = fab.state.log.length;
  assert.equal((await call('POST', '/refresh', { body: {} })).status, 503);
  assert.equal((await call('POST', '/scan', { body: { action: 'start' } })).status, 503);
  assert.equal(fab.state.log.length, requests);
  const status = (await call('GET', '/status')).data;
  assert.equal(status.fab.block.kind, 'blocked');
  assert.equal((await call('POST', '/fab/recheck', { body: {} })).status, 429);
});

test('refresh and scan need the studio origin and request header', async (t) => {
  const { origin } = await startService(t);
  for (const route of ['/refresh', '/scan', '/fab/recheck']) {
    const response = await fetch(`${origin}/api/megascans${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403, route);
  }
});
