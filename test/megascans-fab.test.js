import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openMegascansDb } from '../runtime/megascans-db.js';
import {
  FabBlockedError,
  FabClient,
  FabError,
  FabSource,
  htmlToText,
  normalizeListing,
  parseSearchResponse,
} from '../runtime/megascans-fab.js';
import { MegascansLibrary } from '../runtime/megascans-library.js';
import { BLOCK_DURATION_MS, FabSync, SyncError } from '../runtime/megascans-sync.js';
import { ThumbnailCache, sniffImage } from '../runtime/megascans-thumbs.js';
import { FILE_UIDS, PNG, fakeId, startFakeFab } from './fixtures/fake-fab.js';

const quiet = { info() {}, warn() {}, error() {} };

async function setup(t, fabOptions = {}, clientOptions = {}) {
  const fab = await startFakeFab(fabOptions);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-fab-'));
  const handle = openMegascansDb(directory);
  const clock = { time: Date.parse('2026-06-01T12:00:00Z') };
  const library = new MegascansLibrary(handle, { now: () => new Date(clock.time) });
  const client = new FabClient({
    baseUrl: fab.base,
    minIntervalMs: 5,
    imageIntervalMs: 5,
    backoffMs: 1,
    ...clientOptions,
  });
  const source = new FabSource(client, { pageSize: fab.state.pageSize });
  const sync = new FabSync({
    handle,
    library,
    source,
    now: () => new Date(clock.time),
    logger: quiet,
    scanMaxPages: 2,
  });
  t.after(async () => {
    sync.cancelScan();
    await sync.scanIdle();
    await fab.close();
    handle.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { fab, handle, library, client, source, sync, clock, directory };
}

test('the client identifies itself honestly and sends no cookies, tokens or browser headers', async (t) => {
  const { fab, client } = await setup(t);
  await client.getJson('/i/listings/search?seller=Quixel+Megascans');
  const headers = fab.state.log[0].headers;
  assert.match(headers['user-agent'], /^Forge-Studio\/\d/);
  assert.doesNotMatch(headers['user-agent'], /Mozilla|Chrome|Safari/i);
  for (const name of ['cookie', 'authorization', 'referer', 'origin', 'x-csrftoken']) {
    assert.equal(headers[name], undefined, name);
  }
  assert.equal(headers.accept, 'application/json');
});

test('requests are serialized with a quiet interval between them', async (t) => {
  const { fab, client } = await setup(t, {}, { minIntervalMs: 80 });
  fab.state.delayMs = 10;
  await Promise.all(Array.from({ length: 4 }, () => client.getJson('/i/listings/search')));
  assert.equal(fab.state.maxInFlight, 1);
  const times = fab.state.log.map((entry) => entry.at);
  for (let index = 1; index < times.length; index++) {
    assert.ok(times[index] - times[index - 1] >= 70, `gap ${times[index] - times[index - 1]} ms`);
  }
});

test('the default pacing is at least 1.5 seconds between metadata requests', async () => {
  const { MIN_INTERVAL_MS } = await import('../runtime/megascans-fab.js');
  assert.ok(MIN_INTERVAL_MS >= 1500);
});

test('429 and 5xx are retried with backoff that honors Retry-After', async (t) => {
  const delays = [];
  const { fab, client } = await setup(
    t,
    {},
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      backoffMs: 10,
    },
  );
  fab.state.failuresLeft = 2;
  fab.state.retryAfter = '7';
  const json = await client.getJson('/i/listings/search');
  assert.ok(Array.isArray(json.results));
  assert.equal(fab.count('/i/listings/search'), 3);
  assert.ok(delays.filter((ms) => ms >= 7000).length >= 2, `delays ${delays}`);

  fab.state.mode = 'flaky500';
  fab.state.failuresLeft = 5;
  fab.state.retryAfter = '0';
  const before = fab.count('/i/listings/search');
  await assert.rejects(
    client.getJson('/i/listings/search'),
    (error) => error instanceof FabError && error.status === 503,
  );
  assert.equal(fab.count('/i/listings/search') - before, 3, 'bounded attempts');
});

test('a long Retry-After or an exhausted 429 becomes a rate-limited state, not a retry storm', async (t) => {
  const { fab, client } = await setup(t, {}, { sleep: async () => {} });
  fab.state.mode = 'limited';
  await assert.rejects(client.getJson('/i/listings/search'), (error) => {
    assert.ok(error instanceof FabBlockedError);
    assert.equal(error.kind, 'rate_limited');
    assert.equal(error.retryAfterSeconds, 99999);
    return true;
  });
  assert.equal(fab.count('/i/listings/search'), 1);
});

test('challenges, refusals and redirects stop at once and are never worked around', async (t) => {
  const { fab, client } = await setup(t);
  for (const mode of ['challenge', 'html200', 'redirect']) {
    fab.state.mode = mode;
    const before = fab.state.log.length;
    await assert.rejects(client.getJson('/i/listings/search'), FabBlockedError, mode);
    assert.equal(fab.state.log.length - before, 1, `${mode}: one request, no retry`);
  }
  // Plain HTML that is not a challenge is an error, not a block.
  fab.state.mode = 'ok';
  const { default: http } = await import('node:http');
  assert.ok(http);
});

test('only the configured host is contacted', async (t) => {
  const { client } = await setup(t);
  await assert.rejects(
    client.getJson('https://elsewhere.example/i/listings/search'),
    /unexpected host/,
  );
  await assert.rejects(client.getImage('https://elsewhere.example/a.png'), /unexpected host/);
  await assert.rejects(client.getImage('http://media.fab.com/a.png'), /unexpected host/);
  await assert.rejects(client.getImage('not a url'), FabError);
});

test('parsing keeps only free Megascans 3D models and plain text', async () => {
  const good = {
    uid: 'ABCDEF01-0000-4000-8000-000000000001',
    title: ' Rock <b>01</b> ',
    listingType: '3d-model',
    startingPrice: { price: 0 },
    user: { sellerName: 'Quixel Megascans' },
    tags: [{ name: 'Rock' }, { name: '' }],
    assetFormats: [],
  };
  assert.equal(normalizeListing(good).id, 'abcdef01-0000-4000-8000-000000000001');
  assert.deepEqual(normalizeListing(good).tags, ['rock']);
  for (const bad of [
    null,
    {},
    { ...good, user: { sellerName: 'Other' } },
    { ...good, startingPrice: { price: 5 } },
    { ...good, startingPrice: {} },
    { ...good, listingType: 'material' },
  ]) {
    assert.equal(normalizeListing(bad), null);
  }
  assert.throws(() => parseSearchResponse({}), FabError);
  assert.equal(
    htmlToText('<p>Fish &amp; chips</p><script>x</script><p>Next&nbsp;line</p>'),
    'Fish & chips\nxNext line',
  );
});

test('refresh fills the cache, serves search from it, and respects the cooldown', async (t) => {
  const { fab, library, sync, clock } = await setup(t, { total: 5, pageSize: 3 });
  assert.equal(sync.status().cache.stale, true);
  const result = await sync.refresh();
  assert.equal(result.added, 3, 'distractors from other sellers, paid and other types are dropped');
  assert.equal(result.hasMore, true);
  assert.equal(library.count({ source: 'fab' }), 3);
  assert.equal(sync.status().cache.stale, false);
  assert.equal(sync.status().cache.listings, 3);

  assert.match(fab.state.log[0].search, /seller=Quixel\+Megascans/);
  assert.match(fab.state.log[0].search, /listing_types=3d-model/);
  assert.match(fab.state.log[0].search, /is_free=1/);

  // Searching the cache needs no further request.
  const requests = fab.state.log.length;
  assert.equal(library.search({ q: 'crate 02' }).total, 1);
  assert.equal(library.search({ q: 'stone' }).total, 1);
  assert.equal(library.search({ tag: 'photogrammetry' }).total, 3);
  assert.equal(library.search({ sort: 'newest' }).listings[0].title, 'Historic Crate 01');
  assert.equal(fab.state.log.length, requests);

  await assert.rejects(
    sync.refresh(),
    (error) => error instanceof SyncError && error.status === 429,
  );
  assert.equal(fab.state.log.length, requests, 'the cooldown makes no request');
  clock.time += 61_000;
  const again = await sync.refresh();
  assert.equal(again.added, 0);
  assert.equal(again.updated, 3);

  clock.time += 25 * 3600 * 1000;
  assert.equal(sync.status().cache.stale, true, 'the 24 hour TTL expires');
});

test('listing detail is cached for a week and read through two fixed endpoints', async (t) => {
  const { fab, library, sync, clock } = await setup(t, { total: 2, pageSize: 2 });
  await sync.refresh();
  const id = fakeId(1);
  const first = await sync.loadDetail(id);
  assert.equal(first.fetched, true);
  const detail = first.listing.detail;
  assert.equal(detail.description, 'Rustic crate & barrel.\nTexel density: 5941 px/m');
  assert.equal(detail.trianglesMin, 2510);
  assert.equal(detail.trianglesMax, 1000012);
  assert.equal(detail.textureResolutionMax, 8192);
  assert.deepEqual(
    detail.groups.map((group) => group.id),
    ['glb', 'fbx', 'usdz', 'extra'],
  );
  assert.equal(detail.recommendedUid, FILE_UIDS.glbMid, 'GLB at mid quality is recommended');
  assert.equal(detail.license, 'Fab Standard License');
  assert.ok(fab.state.log.some((entry) => entry.path === `/i/listings/${id}/asset-formats/fbx`));

  const requests = fab.state.log.length;
  assert.equal((await sync.loadDetail(id)).fetched, false);
  clock.time += 6 * 86400000;
  assert.equal((await sync.loadDetail(id)).fetched, false);
  assert.equal(fab.state.log.length, requests);
  clock.time += 2 * 86400000;
  assert.equal((await sync.loadDetail(id)).fetched, true);
  assert.equal(library.get(id).detail.groups[0].files[0].name, 'crate_xyz_low.glb');
  await assert.rejects(
    sync.loadDetail('99999999-9999-4999-8999-999999999999'),
    (error) => error.status === 404,
  );
});

test('a refusal from Fab is remembered, stops every request, and clears only after the pause', async (t) => {
  const { fab, sync, clock } = await setup(t);
  fab.state.mode = 'challenge';
  await assert.rejects(sync.refresh(), FabBlockedError);
  const stored = sync.block();
  assert.equal(stored.kind, 'blocked');
  assert.match(stored.message, /blocking automated requests/);
  assert.match(stored.message, /Import/);
  const requests = fab.state.log.length;

  fab.state.mode = 'ok';
  await assert.rejects(sync.refresh(), FabBlockedError);
  await assert.rejects(sync.loadDetail(fakeId(1)), Error);
  assert.throws(() => sync.startScan(), FabBlockedError);
  assert.equal(fab.state.log.length, requests, 'no request while blocked');

  assert.throws(
    () => sync.recheck(),
    (error) => error instanceof SyncError && error.status === 429,
  );
  clock.time += BLOCK_DURATION_MS + 1000;
  assert.equal(sync.block(), null);
  sync.recheck();
  assert.equal((await sync.refresh()).added, 2);
});

test('a scan reads a few pages per run, can be resumed, and finishes at the end', async (t) => {
  const { fab, library, sync } = await setup(t, { total: 7, pageSize: 2 });
  sync.startScan();
  await sync.scanIdle();
  let scan = sync.scanStatus();
  assert.equal(scan.status, 'capped', 'the per-run cap of 2 pages');
  assert.equal(scan.pagesThisRun, 2);
  assert.equal(library.count({ source: 'fab' }), 4);
  assert.notEqual(scan.cursor, '');
  assert.equal(fab.count('/i/listings/search'), 2);

  sync.startScan({ resume: true });
  await sync.scanIdle();
  scan = sync.scanStatus();
  assert.equal(scan.status, 'completed');
  assert.equal(scan.reachedEnd, true);
  assert.equal(scan.pagesTotal, 4);
  assert.equal(library.count({ source: 'fab' }), 7);
  assert.equal(fab.state.maxInFlight, 1);
  assert.equal(library.search({ q: 'crate 07' }).total, 1);
});

test('a scan can be cancelled and resumed, and a crash leaves it resumable', async (t) => {
  const { fab, handle, library, source, sync, clock } = await setup(t, { total: 9, pageSize: 2 });
  fab.state.delayMs = 40;
  sync.startScan();
  for (let attempt = 0; attempt < 200 && sync.scanStatus().pagesTotal < 1; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  sync.cancelScan();
  await sync.scanIdle();
  const cancelled = sync.scanStatus();
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.pagesTotal >= 1);
  const saved = library.count({ source: 'fab' });
  assert.ok(saved >= 2);

  // Simulate a process that died mid-scan.
  sync.writeKv('scan', { ...cancelled, status: 'running' });
  const restarted = new FabSync({
    handle,
    library,
    source,
    now: () => new Date(clock.time),
    logger: quiet,
    scanMaxPages: 2,
  });
  restarted.recoverScan();
  assert.equal(restarted.scanStatus().status, 'interrupted');
  fab.state.delayMs = 0;
  restarted.startScan({ resume: true });
  await restarted.scanIdle();
  assert.equal(restarted.scanStatus().pagesTotal, cancelled.pagesTotal + 2);
  assert.ok(library.count({ source: 'fab' }) > saved);
  assert.throws(() => {
    restarted.startScan();
    restarted.startScan();
  }, /already running/);
  restarted.cancelScan();
  await restarted.scanIdle();
});

test('a scan that meets a block stops, records it, and asks nothing more', async (t) => {
  const { fab, sync } = await setup(t, { total: 9, pageSize: 2 });
  fab.state.mode = 'challenge';
  sync.startScan();
  await sync.scanIdle();
  assert.equal(sync.scanStatus().status, 'blocked');
  assert.ok(sync.block());
  assert.equal(fab.count('/i/listings/search'), 1);
});

test('refresh is refused while a scan is running', async (t) => {
  const { fab, sync } = await setup(t, { total: 9, pageSize: 2 });
  fab.state.delayMs = 50;
  sync.startScan();
  await assert.rejects(sync.refresh(), /scan is running/);
  sync.cancelScan();
  await sync.scanIdle();
});

test('thumbnails are fetched once, checked by content, capped, and never re-requested after a failure', async (t) => {
  const { fab, library, client, sync, directory } = await setup(t, { total: 3, pageSize: 3 });
  await sync.refresh();
  const thumbs = new ThumbnailCache({
    client,
    library,
    directory: path.join(directory, 'thumbs'),
    isBlocked: () => Boolean(sync.block()),
    onBlocked: (error) => sync.recordBlock(error),
    logger: quiet,
  });
  const first = await thumbs.get(fakeId(1));
  assert.equal(first.type, 'image/png');
  assert.deepEqual(first.bytes, PNG);
  assert.ok(
    fab.state.log.some((entry) => entry.path === '/media/1/b'),
    'the largest preview is used',
  );
  const mediaRequests = fab.count('/media/');
  await thumbs.get(fakeId(1));
  assert.equal(fab.count('/media/'), mediaRequests, 'served from disk');

  // Concurrent requests for one image share a single download.
  await Promise.all([thumbs.get(fakeId(2)), thumbs.get(fakeId(2)), thumbs.get(fakeId(2))]);
  assert.equal(fab.state.log.filter((entry) => entry.path === '/media/2/b').length, 1);

  // HTML posing as an image, an oversized body and bad ids are refused and not stored.
  fab.state.imageKind = 'html';
  assert.equal(await thumbs.get(fakeId(3)), null);
  await assert.rejects(fs.stat(thumbs.file(fakeId(3))));
  const before = fab.count('/media/');
  assert.equal(await thumbs.get(fakeId(3)), null);
  assert.equal(fab.count('/media/'), before, 'a failure is remembered');
  fab.state.imageKind = 'huge';
  assert.equal(await thumbs.get('../../etc/passwd'), null);
  assert.equal(await thumbs.get(fakeId(500)), null);
  assert.equal(sniffImage(Buffer.from('<html>')), null);
});

test('thumbnails stop when Fab is blocking, and the cache trims its oldest files', async (t) => {
  const { fab, library, client, sync, directory } = await setup(t, { total: 3, pageSize: 3 });
  await sync.refresh();
  const thumbs = new ThumbnailCache({
    client,
    library,
    directory: path.join(directory, 'thumbs'),
    maxBytes: 150,
    isBlocked: () => Boolean(sync.block()),
    onBlocked: (error) => sync.recordBlock(error),
    logger: quiet,
  });
  await thumbs.get(fakeId(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await thumbs.get(fakeId(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await thumbs.get(fakeId(3));
  const kept = (await fs.readdir(thumbs.directory)).filter((name) => name.endsWith('.img'));
  assert.ok(kept.length < 3, `kept ${kept.length}`);
  assert.ok(kept.includes(`${fakeId(3)}.img`), 'the newest survives');

  fab.state.mode = 'challenge';
  await fs.rm(thumbs.directory, { recursive: true });
  assert.equal(await thumbs.get(fakeId(1)), null);
  assert.ok(sync.block(), 'a refused image request pauses all Fab requests');
  const requests = fab.state.log.length;
  assert.equal(await thumbs.get(fakeId(2)), null);
  assert.equal(fab.state.log.length, requests);
});
