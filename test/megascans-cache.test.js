import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FabClient, FabSource } from '../runtime/megascans-fab.js';
import { ValidatorStore, openMegascansDb } from '../runtime/megascans-db.js';
import { MegascansLibrary } from '../runtime/megascans-library.js';
import { megascansService } from '../runtime/megascans-service.js';
import { FabSync } from '../runtime/megascans-sync.js';
import { ThumbnailCache } from '../runtime/megascans-thumbs.js';
import { FILE_UIDS, PNG, fakeId, startFakeFab } from './fixtures/fake-fab.js';

const quiet = { info() {}, warn() {}, error() {} };

async function setup(t) {
  const fab = await startFakeFab({ total: 3, pageSize: 3 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-cache-'));
  const handle = openMegascansDb(directory);
  const clock = { time: Date.parse('2026-06-01T12:00:00Z') };
  const library = new MegascansLibrary(handle, { now: () => new Date(clock.time) });
  const client = new FabClient({
    baseUrl: fab.base,
    minIntervalMs: 2,
    imageIntervalMs: 2,
    backoffMs: 1,
    maxAttempts: 1,
    cdnHosts: ['127.0.0.1'],
    allowInsecureCdn: true,
  });
  client.validators = new ValidatorStore(handle.db, { now: () => new Date(clock.time) });
  const sync = new FabSync({
    handle,
    library,
    source: new FabSource(client, { pageSize: 3 }),
    now: () => new Date(clock.time),
    logger: quiet,
  });
  t.after(async () => {
    await fab.close().catch(() => {});
    handle.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { fab, handle, library, client, sync, clock, directory };
}

test('identical requests made at the same time share one transfer', async (t) => {
  const { fab, client } = await setup(t);
  fab.state.delayMs = 30;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => client.getJson('/i/listings/search?seller=x')),
  );
  assert.equal(fab.count('/i/listings/search'), 1);
  assert.ok(results.every((result) => Array.isArray(result.results)));
  // A different request is not merged with it.
  await client.getJson('/i/listings/search?seller=y');
  assert.equal(fab.count('/i/listings/search'), 2);
});

test('concurrent refreshes and detail reads are single-flight too', async (t) => {
  const { fab, sync, clock } = await setup(t);
  fab.state.delayMs = 30;
  const [first, second] = await Promise.all([sync.refresh(), sync.refresh()]);
  assert.equal(fab.count('/i/listings/search'), 1);
  assert.equal(first.added, second.added);

  clock.time += 61_000;
  const id = fakeId(1);
  const reads = await Promise.all([sync.loadDetail(id), sync.loadDetail(id), sync.loadDetail(id)]);
  assert.ok(reads.every((read) => read.fetched));
  assert.equal(fab.count(`/i/listings/${id}`), 3, 'one set: details, formats and technical info');
});

test('unchanged pages and details are revalidated with If-None-Match and not downloaded again', async (t) => {
  const { fab, library, sync, clock, handle } = await setup(t);
  fab.state.etags = true;
  const first = await sync.refresh();
  assert.equal(first.added, 3);
  assert.equal(fab.state.log[0].headers['if-none-match'], undefined);
  const stored = handle.db.prepare("SELECT etag FROM http_cache WHERE key LIKE 'search:%'").get();
  assert.equal(stored.etag, '"rev-1"');

  clock.time += 61_000;
  const again = await sync.refresh();
  assert.equal(again.notModified, true);
  assert.equal(again.added, 0);
  assert.equal(fab.state.log.at(-1).headers['if-none-match'], '"rev-1"');
  assert.equal(library.count({ source: 'fab' }), 3, 'the saved listings are kept');
  assert.equal(
    sync.status().cache.fetchedAt,
    new Date(clock.time).toISOString(),
    'its age is renewed',
  );

  const id = fakeId(2);
  assert.equal((await sync.loadDetail(id)).fetched, true);
  const before = fab.state.log.length;
  clock.time += 31_000;
  const unchanged = await sync.loadDetail(id, { force: true });
  assert.equal(unchanged.notModified, true);
  assert.equal(fab.state.log.length - before, 2, 'both reads were conditional and answered 304');
  assert.ok(unchanged.listing.detail.groups.length > 0, 'the details are still there');
  assert.equal(unchanged.listing.detailFetchedAt, new Date(clock.time).toISOString());

  // When Fab's copy changes the full data is read again.
  fab.state.revision = 2;
  clock.time += 61_000;
  const changed = await sync.refresh();
  assert.equal(changed.notModified, undefined);
  assert.equal(changed.updated, 3);
});

test('a cached thumbnail is checked once it is old, and kept when unchanged or when Fab is away', async (t) => {
  const { fab, library, client, sync, directory } = await setup(t);
  const skew = { ms: 0 };
  fab.state.etags = true;
  await sync.refresh();
  const thumbs = new ThumbnailCache({
    client,
    library,
    directory: path.join(directory, 'thumbs'),
    now: () => Date.now() + skew.ms,
    logger: quiet,
  });
  const id = fakeId(1);
  await thumbs.get(id);
  const media = () => fab.state.log.filter((entry) => entry.path.startsWith('/media/')).length;
  assert.equal(media(), 1);
  await thumbs.get(id);
  assert.equal(media(), 1, 'a fresh copy is not checked');

  skew.ms += 31 * 24 * 3600 * 1000;
  const checked = await thumbs.get(id);
  assert.equal(media(), 2);
  assert.equal(fab.state.log.at(-1).headers['if-none-match'], '"rev-1"');
  assert.deepEqual(checked.bytes, PNG);
  await thumbs.get(id);
  assert.equal(media(), 2, 'the check renewed its age');

  skew.ms += 31 * 24 * 3600 * 1000;
  await fab.close();
  const offline = await thumbs.get(id);
  assert.deepEqual(offline.bytes, PNG, 'an old copy is served when Fab cannot be reached');
});

test('listings, details and previews are served from the cache when Fab is unreachable', async (t) => {
  const fab = await startFakeFab({ total: 3, pageSize: 3 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-offline-'));
  const service = megascansService({
    directory: path.join(root, 'runtime'),
    projectsRoot: path.join(root, 'projects'),
    thumbsDirectory: path.join(root, 'thumbs'),
    fabBaseUrl: fab.base,
    fabMinIntervalMs: 2,
    fabImageIntervalMs: 2,
    logger: quiet,
  });
  let handler;
  service.configureServer({ middlewares: { use: (_prefix, callback) => (handler = callback) } });
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/megascans/, '') || '/';
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    service.state?.handle.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (method, route, body) => {
    const response = await fetch(`${origin}/api/megascans${route}`, {
      method,
      headers:
        method === 'POST'
          ? { Origin: origin, 'X-Forge-Request': 'megascans', 'Content-Type': 'application/json' }
          : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json().catch(() => null), response };
  };
  await call('POST', '/refresh', {});
  await call('POST', `/listings/${fakeId(1)}/refresh`, {});
  assert.equal((await call('GET', `/thumbs/${fakeId(1)}`)).status, 200);
  await fab.close();

  const search = await call('GET', '/listings?q=crate');
  assert.equal(search.data.total, 3);
  const detail = await call('GET', `/listings/${fakeId(1)}`);
  assert.equal(detail.data.listing.detail.groups[0].id, 'glb');
  assert.equal(detail.data.listing.detailFetchedAt !== null, true);
  assert.equal(
    (await call('GET', `/thumbs/${fakeId(1)}`)).status,
    200,
    'the preview comes from disk',
  );

  const unread = await call('POST', `/listings/${fakeId(2)}/refresh`, {});
  assert.equal(unread.status, 502);
  assert.match(unread.data.error, /Could not reach Fab/);
  const status = (await call('GET', '/status')).data;
  assert.match(status.fab.unreachable.message, /Could not reach Fab/);
  assert.equal(status.fab.block, null, 'being offline is not a block');
  assert.equal((await call('GET', '/listings?q=crate')).data.total, 3);
});

test('signed download addresses are never written to the cache database', async (t) => {
  const { fab, client, handle, sync } = await setup(t);
  fab.state.etags = true;
  await sync.refresh();
  await client.getDownloadInfo(fakeId(1), 'converted-files', FILE_UIDS.glbLow);
  await client.getDownloadInfo(fakeId(1), 'converted-files', FILE_UIDS.glbLow);
  const tables = handle.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%fts%'")
    .all()
    .map((row) => row.name);
  for (const table of tables) {
    const dump = JSON.stringify(handle.db.prepare(`SELECT * FROM ${table}`).all());
    assert.equal(dump.includes('SECRET-SIGNED-TOKEN'), false, table);
    assert.equal(dump.includes('download-info'), false, table);
  }
  assert.equal(fab.state.infoLog.length, 2, 'each call asked Fab again; nothing was reused');
});
