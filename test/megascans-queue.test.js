import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openMegascansDb } from '../runtime/megascans-db.js';
import { LibraryError, MegascansLibrary, parseFabListing } from '../runtime/megascans-library.js';
import {
  ImportQueue,
  MAX_CONCURRENT_IMPORTS,
  MAX_WAITING_IMPORTS,
  QueueError,
  RESTART_MESSAGE,
} from '../runtime/megascans-queue.js';
import { ImportRunner, stagingDirectory, uploadFile } from '../runtime/megascans-runner.js';

const FAB = 'https://www.fab.com/listings';
const ids = [
  '854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
  '2ff093a2-3380-4b64-bfb7-719600367b20',
  '7add130d-69bd-4d61-85a4-91845757e070',
];

async function openTemporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-db-'));
  const handle = openMegascansDb(directory);
  t.after(async () => {
    handle.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, handle };
}

function importRow(index, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    projectId: '11111111-1111-4111-8111-111111111111',
    filename: `file${index}.zip`,
    kind: 'archive',
    uploadBytes: 100,
    ...overrides,
  };
}

test('parseFabListing reads only genuine Fab listing addresses', () => {
  const expected = { id: ids[0], url: `${FAB}/${ids[0]}` };
  assert.deepEqual(parseFabListing(`${FAB}/${ids[0]}`), expected);
  assert.deepEqual(parseFabListing(`https://fab.com/listings/${ids[0].toUpperCase()}/`), expected);
  assert.deepEqual(parseFabListing(`${FAB}/${ids[0]}?utm_source=x#top`), expected);
  assert.deepEqual(parseFabListing(`  ${ids[0]}  `), expected);
  for (const bad of [
    `http://www.fab.com/listings/${ids[0]}`,
    `https://fab.com.evil.example/listings/${ids[0]}`,
    `https://evil.example/www.fab.com/listings/${ids[0]}`,
    `https://user:pw@evil.example/listings/${ids[0]}`,
    'https://www.fab.com/sellers/Quixel%20Megascans',
    'https://www.fab.com/listings/not-a-uuid',
    'javascript:alert(1)',
    '',
    null,
    {},
    'x'.repeat(600),
  ]) {
    assert.equal(parseFabListing(bad), null, String(bad));
  }
});

test('the library saves, searches, filters, sorts and pages listings', async (t) => {
  const { handle } = await openTemporary(t);
  let tick = 0;
  const library = new MegascansLibrary(handle, {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  assert.equal(library.count(), 0);
  library.upsert({
    url: `${FAB}/${ids[0]}`,
    title: 'Old Wooden Crate',
    tags: 'Wood, Prop, wood',
    notes: 'Nice for taverns',
  });
  library.upsert({
    url: `${FAB}/${ids[1]}`,
    title: 'Stone Gemstone Jasper',
    tags: ['stone', 'Gem Stone'],
  });
  library.upsert({ url: ids[2], title: 'Alder Bowl', tags: ['wood'] });

  assert.equal(library.count(), 3);
  assert.deepEqual(library.get(ids[0]).tags, ['wood', 'prop']);
  assert.equal(library.get(ids[0]).license, 'Fab Standard License');
  assert.equal(library.get(ids[0]).seller, 'Quixel Megascans');
  assert.match(
    library.get(ids[0]).attribution,
    /Old Wooden Crate by Quixel Megascans \(Epic Games\), via Fab: https:\/\/www\.fab\.com\/listings\//,
  );

  assert.deepEqual(
    library.search({ q: 'wood' }).listings.map((item) => item.title),
    ['Alder Bowl', 'Old Wooden Crate'],
  );
  assert.deepEqual(
    library.search({ q: 'tav' }).listings.map((item) => item.title),
    ['Old Wooden Crate'],
  );
  assert.deepEqual(
    library.search({ q: 'gemstone jasp' }).listings.map((item) => item.title),
    ['Stone Gemstone Jasper'],
  );
  assert.deepEqual(library.search({ q: '"; DROP TABLE listings; --' }).listings, []);
  assert.equal(library.search({ q: 'NEAR( AND OR *' }).total, 0);
  assert.deepEqual(
    library.search({ tag: 'wood', sort: 'title' }).listings.map((item) => item.title),
    ['Alder Bowl', 'Old Wooden Crate'],
  );
  assert.deepEqual(
    library.search({ sort: 'recent' }).listings.map((item) => item.title),
    ['Alder Bowl', 'Stone Gemstone Jasper', 'Old Wooden Crate'],
  );
  const page = library.search({ pageSize: 2, page: 99 });
  assert.equal(page.page, 2);
  assert.equal(page.pageCount, 2);
  assert.equal(page.listings.length, 1);
  assert.deepEqual(library.tagCounts()[0], { tag: 'wood', count: 2 });

  // An edit refreshes the full-text index and keeps the original address.
  library.upsert({ url: `${FAB}/${ids[2]}`, title: 'Alder Cup', tags: [] });
  assert.equal(library.search({ q: 'bowl' }).total, 0);
  assert.equal(library.search({ q: 'cup' }).total, 1);
  assert.equal(library.count(), 3);

  assert.equal(library.remove(ids[2]), true);
  assert.equal(library.remove(ids[2]), false);
  assert.equal(library.search({ q: 'cup' }).total, 0);
});

test('the library validates input and falls back to LIKE without FTS5', async (t) => {
  const { handle } = await openTemporary(t);
  const library = new MegascansLibrary(handle);
  assert.throws(() => library.upsert({ url: 'https://example.com/x', title: 'x' }), LibraryError);
  assert.throws(() => library.upsert({ url: `${FAB}/${ids[0]}`, title: '   ' }), /title/);
  library.upsert({
    url: `${FAB}/${ids[0]}`,
    title: 'Plain Crate',
    notes: 'x'.repeat(5000),
    tags: Array.from({ length: 30 }, (_, i) => `tag${i}`),
  });
  assert.equal(library.get(ids[0]).notes.length, 2000);
  assert.equal(library.get(ids[0]).tags.length, 12);
  const noFts = new MegascansLibrary({ db: handle.db, hasFts: false });
  assert.equal(noFts.search({ q: 'crate' }).total, 1);
  assert.equal(noFts.search({ q: '100%' }).total, 0);
});

test('the queue claims in order and never exceeds the concurrency cap', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  assert.equal(MAX_CONCURRENT_IMPORTS, 2);
  for (let index = 1; index <= 5; index++) {
    queue.enqueue(importRow(index));
  }
  const first = queue.claimNext();
  const second = queue.claimNext();
  assert.equal(first.id, importRow(1).id);
  assert.equal(second.id, importRow(2).id);
  assert.equal(queue.claimNext(), null);
  assert.deepEqual(queue.summary(), {
    running: 2,
    queued: 3,
    failed: 0,
    completed: 0,
    maxConcurrent: 2,
  });
  assert.equal(queue.complete(first.id, { files: [] }), true);
  assert.equal(queue.claimNext().id, importRow(3).id);
  assert.equal(queue.claimNext(), null);
});

test('racing claimers in separate connections cannot start more than two imports', async (t) => {
  const { directory, handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  for (let index = 1; index <= 12; index++) {
    queue.enqueue(importRow(index));
  }
  const source = `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.module).then(async ({ openMegascansDb }) => {
      const queueModule = await import(workerData.queue);
      const own = openMegascansDb(workerData.directory);
      const racer = new queueModule.ImportQueue(own);
      const claimed = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        const row = racer.claimNext();
        if (row) claimed.push(row.id);
      }
      own.close();
      parentPort.postMessage(claimed);
    });
  `;
  const workers = Array.from(
    { length: 6 },
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: {
            directory,
            module: pathToFileURL(path.resolve('runtime/megascans-db.js')).href,
            queue: pathToFileURL(path.resolve('runtime/megascans-queue.js')).href,
          },
        });
        worker.once('message', resolve);
        worker.once('error', reject);
      }),
  );
  const claimed = (await Promise.all(workers)).flat();
  assert.equal(claimed.length, 2, `claimed ${claimed.length}`);
  assert.equal(new Set(claimed).size, 2);
  assert.equal(queue.summary().running, 2);
  assert.equal(queue.summary().queued, 10);
});

test('a restart turns running imports into interrupted ones and never restarts them', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  for (let index = 1; index <= 3; index++) {
    queue.enqueue(importRow(index));
  }
  queue.claimNext();
  queue.claimNext();
  assert.equal(queue.recoverInterrupted(), 2);
  const interrupted = queue.get(importRow(1).id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.error, RESTART_MESSAGE);
  assert.equal(queue.get(importRow(3).id).status, 'queued');
  // The waiting import may start; the interrupted ones wait for an explicit retry.
  assert.equal(queue.claimNext().id, importRow(3).id);
  assert.equal(queue.claimNext(), null);
  assert.equal(queue.retry(importRow(1).id).status, 'queued');
  assert.throws(() => queue.retry(importRow(3).id), QueueError);
});

test('cancel, retry, dismiss and late results follow the state machine', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  queue.enqueue(importRow(1));
  queue.enqueue(importRow(2));
  queue.enqueue(importRow(3));
  const running = queue.claimNext();
  const waiting = queue.cancel(importRow(2).id);
  assert.equal(waiting.import.status, 'cancelled');
  assert.equal(waiting.wasRunning, false);
  const request = queue.cancel(running.id);
  assert.equal(request.wasRunning, true);
  assert.equal(request.import.cancelRequested, true);
  assert.equal(queue.isCancelRequested(running.id), true);
  assert.equal(queue.markCancelled(running.id), true);
  // A late completion cannot overwrite the cancelled state.
  assert.equal(queue.complete(running.id, { files: [] }), false);
  assert.equal(queue.get(running.id).status, 'cancelled');
  assert.throws(() => queue.cancel(running.id), /already finished/);
  assert.throws(() => queue.dismiss(importRow(3).id), /Cancel this import/);
  const retried = queue.retry(running.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.cancelRequested, false);
  queue.cancel(importRow(3).id);
  assert.equal(queue.dismiss(importRow(3).id).id, importRow(3).id);
  assert.equal(queue.get(importRow(3).id), null);
  assert.throws(
    () => queue.dismiss('missing'),
    (error) => error.status === 404,
  );
});

test('progress yields speed and an estimate only while an import runs', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  queue.enqueue(importRow(1));
  assert.equal(queue.get(importRow(1).id).secondsRemaining, null);
  const row = queue.claimNext();
  queue.setProgress(row.id, {
    bytesDone: 250,
    bytesTotal: 1000,
    bytesPerSecond: 50,
    stage: 'Extracting',
  });
  const item = queue.get(row.id);
  assert.equal(item.bytesDone, 250);
  assert.equal(item.bytesPerSecond, 50);
  assert.equal(item.secondsRemaining, 15);
  queue.complete(row.id, { files: ['3d/a.glb'] });
  const done = queue.get(row.id);
  assert.equal(done.bytesDone, 1000);
  assert.equal(done.secondsRemaining, null);
  queue.setProgress(row.id, { bytesDone: 1, bytesTotal: 2, bytesPerSecond: 1 });
  assert.equal(queue.get(row.id).bytesDone, 1000, 'a finished import ignores late progress');
});

test('the queue limits how many imports may wait', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle, { maxConcurrent: 0 });
  for (let index = 1; index <= MAX_WAITING_IMPORTS; index++) {
    queue.enqueue(importRow(index));
  }
  assert.throws(
    () => queue.enqueue(importRow(999)),
    (error) => error.status === 429,
  );
});

async function projectWithUploads(t, count) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'project');
  await fs.mkdir(folder);
  const realFolder = await fs.realpath(folder);
  const rows = [];
  for (let index = 1; index <= count; index++) {
    const row = importRow(index);
    await fs.mkdir(stagingDirectory(realFolder, row.id), { recursive: true });
    await fs.writeFile(uploadFile(realFolder, row.id, row.filename), 'zip');
    rows.push(row);
  }
  return { folder: realFolder, rows };
}

test('the runner starts at most two imports at once even when many are queued', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  const library = new MegascansLibrary(handle);
  const { folder, rows } = await projectWithUploads(t, 6);
  for (const row of rows) {
    queue.enqueue(row);
  }
  let active = 0;
  let peak = 0;
  const pendingReleases = [];
  const runner = new ImportRunner({
    queue,
    library,
    resolveProject: async () => ({ id: rows[0].projectId, name: 'p', folder }),
    logger: { error() {}, warn() {} },
    importFile: async (job) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => pendingReleases.push(resolve));
      active--;
      return { files: [`3d/${job.id}.glb`], folder: null, skipped: 0, bytes: 3 };
    },
  });
  runner.pump();
  runner.pump();
  for (let attempt = 0; attempt < 200 && active < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(active, 2);
  assert.equal(queue.summary().running, 2);
  while (queue.summary().completed < 6) {
    pendingReleases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await runner.idle();
  assert.equal(peak, 2);
  assert.equal(queue.summary().completed, 6);
});

test('the runner cancels a running import, keeps its upload and records failures plainly', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  const library = new MegascansLibrary(handle);
  const { folder, rows } = await projectWithUploads(t, 3);
  for (const row of rows) {
    queue.enqueue(row);
  }
  const started = [];
  const runner = new ImportRunner({
    queue,
    library,
    resolveProject: async () => ({ id: rows[0].projectId, name: 'p', folder }),
    logger: { error() {}, warn() {} },
    importFile: (job) => {
      started.push(job.id);
      if (job.id === rows[1].id) {
        throw new TypeError(`boom at ${folder}`);
      }
      return new Promise((_resolve, reject) => {
        job.signal.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });
  runner.pump();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const crashed = queue.get(rows[1].id);
  assert.equal(crashed.status, 'failed');
  assert.doesNotMatch(crashed.error, new RegExp(path.basename(folder)), 'no local paths in errors');
  // Slot freed by the crash lets the third import start.
  assert.ok(started.includes(rows[2].id));
  queue.cancel(rows[0].id);
  runner.cancel(rows[0].id);
  queue.cancel(rows[2].id);
  runner.cancel(rows[2].id);
  await runner.idle();
  assert.equal(queue.get(rows[0].id).status, 'cancelled');
  assert.equal(queue.get(rows[2].id).status, 'cancelled');
  await fs.access(uploadFile(folder, rows[0].id, rows[0].filename));
});

test('the runner fails an import whose upload or project is gone', async (t) => {
  const { handle } = await openTemporary(t);
  const queue = new ImportQueue(handle);
  const library = new MegascansLibrary(handle);
  const { folder, rows } = await projectWithUploads(t, 2);
  await fs.rm(uploadFile(folder, rows[0].id, rows[0].filename));
  rows[1].projectId = '22222222-2222-4222-8222-222222222222';
  queue.enqueue(rows[0]);
  queue.enqueue(rows[1]);
  const runner = new ImportRunner({
    queue,
    library,
    resolveProject: async (projectId) =>
      projectId === rows[1].projectId ? null : { id: projectId, name: 'p', folder },
    logger: { error() {}, warn() {} },
    importFile: async () => {
      throw new Error('should not run');
    },
  });
  runner.pump();
  await runner.idle();
  assert.match(queue.get(rows[0].id).error, /Choose the file again/);
  assert.match(queue.get(rows[1].id).error, /no longer exists/);
});
