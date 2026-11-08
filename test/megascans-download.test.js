import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAssetMeta } from '../runtime/asset-metadata.js';
import { FabClient, FabError } from '../runtime/megascans-fab.js';
import { describeFiles, pickFile } from '../runtime/megascans-files.js';
import { megascansService } from '../runtime/megascans-service.js';
import { FILE_UIDS, SECRET_TOKEN, fakeId, startFakeFab } from './fixtures/fake-fab.js';

const PROJECT_ID = '0f6bd0a2-5d35-4ef9-a6a0-6a6a3f6d1f11';
const LISTING = fakeId(1);

async function setup(t, { fab: fabOptions, service: serviceOptions = {}, confirmed = true } = {}) {
  const fab = await startFakeFab({ total: 3, pageSize: 3, ...fabOptions });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-dl-'));
  const projectsRoot = path.join(root, 'projects');
  const folder = path.join(projectsRoot, 'My Game');
  await fs.mkdir(path.join(folder, '3d'), { recursive: true });
  await fs.writeFile(
    path.join(folder, '.forge-project.json'),
    JSON.stringify({ id: PROJECT_ID, name: 'My Game', createdAt: new Date().toISOString() }),
  );
  const logged = [];
  const logger = {
    info: (...args) => logged.push(args.join(' ')),
    warn: (...args) => logged.push(args.join(' ')),
    error: (...args) => logged.push(args.join(' ')),
  };
  const service = megascansService({
    directory: path.join(root, 'runtime'),
    projectsRoot,
    thumbsDirectory: path.join(root, 'thumbs'),
    fabBaseUrl: fab.base,
    cdnHosts: ['127.0.0.1'],
    allowInsecureCdn: true,
    fabMinIntervalMs: 5,
    fabImageIntervalMs: 5,
    logger,
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
    await fab.close();
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
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  };
  const waitFor = async (id, statuses) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const { data } = await call('GET', `/imports/${id}`);
      if (statuses.includes(data.import.status)) {
        return data.import;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the download.');
  };
  await call('POST', '/refresh', {});
  if (confirmed) {
    await call('POST', '/downloads/confirm', { accepted: true });
  }
  const download = (choice = { fileUid: FILE_UIDS.glbMid }) =>
    call('POST', '/downloads', { project: PROJECT_ID, listing: LISTING, ...choice });
  return { fab, call, download, waitFor, folder, logged, service, origin };
}

test('files are grouped GLB first, with a recommended mid-quality GLB and the extras hidden', async () => {
  const formats = [
    {
      assetFormatType: { code: 'fbx' },
      files: [
        { name: 'm_raw.zip', uid: 'aaaaaaaa-0000-4000-8000-0000000000a1', fileSize: 393280290 },
        { name: 'm_low.zip', uid: 'aaaaaaaa-0000-4000-8000-0000000000a2', fileSize: 7246865 },
      ],
    },
    {
      assetFormatType: { code: 'converted-files' },
      files: [
        { name: 'm_mid.glb', uid: 'aaaaaaaa-0000-4000-8000-0000000000b1', fileSize: 11421444 },
        { name: 'm_low.glb', uid: 'aaaaaaaa-0000-4000-8000-0000000000b2', fileSize: 3214116 },
        { name: 'm_gltf_mid.zip', uid: 'aaaaaaaa-0000-4000-8000-0000000000b3', fileSize: 11425720 },
        { name: 'm_low.usdz', uid: 'aaaaaaaa-0000-4000-8000-0000000000b4', fileSize: 1888007 },
      ],
    },
    {
      assetFormatType: { code: 'additional-files' },
      files: [
        {
          name: 'm_exr_raw.zip',
          uid: 'aaaaaaaa-0000-4000-8000-0000000000c1',
          fileSize: 1907253724,
        },
      ],
    },
    { assetFormatType: { code: 'fbx' }, files: [{ name: 'bad', uid: 'not-a-uid', fileSize: 1 }] },
  ];
  const files = describeFiles(formats);
  assert.deepEqual(
    files.groups.map((group) => group.id),
    ['glb', 'gltf', 'fbx', 'usdz', 'extra'],
  );
  assert.equal(files.recommendedUid, 'aaaaaaaa-0000-4000-8000-0000000000b1');
  assert.deepEqual(
    files.groups[0].files.map((file) => file.quality),
    ['low', 'mid'],
  );
  const raw = files.groups.find((group) => group.id === 'fbx').files.at(-1);
  assert.equal(raw.quality, 'raw');
  assert.equal(raw.isLarge, true);
  const extra = files.groups.find((group) => group.id === 'extra');
  assert.equal(extra.advanced, true);
  assert.equal(extra.files[0].importable, false);
  assert.equal(files.groups.find((group) => group.id === 'usdz').files[0].importable, false);
  assert.equal(pickFile(files, { format: 'glb', quality: 'low' }).size, 3214116);
  assert.equal(pickFile(files, { fileUid: 'AAAAAAAA-0000-4000-8000-0000000000A2' }).quality, 'low');
  assert.equal(pickFile(files, { format: 'glb', quality: 'raw' }), null);
  assert.equal(pickFile(files, {}), null);
});

test('only HTTPS addresses on Epic delivery hosts are accepted for downloads', () => {
  const client = new FabClient();
  for (const good of [
    'https://content-download-emp.distro.on.epicgames.com/Builds/Org/x/model.glb?cf_token=a',
    'https://emp-fastly-stitched.epicgamescdn.com/Builds/Org/x/model.zip?f_token=b',
  ]) {
    assert.equal(client.assertCdnUrl(good).protocol, 'https:');
  }
  for (const bad of [
    'http://content-download-emp.distro.on.epicgames.com/x',
    'https://epicgames.com.evil.example/x',
    'https://evil.example/epicgames.com/x',
    'https://notepicgames.com/x',
    'https://user:pw@a.epicgames.com/x',
    'ftp://a.epicgames.com/x',
    'not a url',
  ]) {
    assert.throws(() => client.assertCdnUrl(bad), FabError, bad);
  }
});

test('downloading is refused until the user confirms the license agreement, and nothing is asked of Fab', async (t) => {
  const { fab, call, download } = await setup(t, { confirmed: false });
  const before = fab.state.log.length;
  const refused = await download();
  assert.equal(refused.status, 403);
  assert.equal(refused.data.needsConfirmation, true);
  assert.match(refused.data.error, /accept the Fab license agreement/);
  assert.equal(fab.state.log.length, before, 'not even a file list was requested');
  assert.equal(fab.state.infoLog.length, 0);

  assert.equal((await call('GET', '/status')).data.fab.downloads.confirmed, false);
  assert.equal(
    (await call('POST', '/downloads/confirm', {})).status,
    400,
    'a body without accepted:true',
  );
  assert.equal((await call('POST', '/downloads/confirm', { accepted: 'yes' })).status, 400);
  const confirmed = await call('POST', '/downloads/confirm', { accepted: true });
  assert.equal(confirmed.data.downloads.confirmed, true);
  assert.match(confirmed.data.downloads.acceptedAt, /^20\d\d-/);
  assert.equal(confirmed.data.downloads.eulaUrl, 'https://www.fab.com/eula');
  assert.equal((await call('GET', '/status')).data.automatedDownload, true);
  assert.equal((await call('POST', '/downloads/revoke', {})).data.downloads.confirmed, false);
  assert.equal((await download()).status, 403);
});

test('confirmation and downloads need the studio origin and request header', async (t) => {
  const { origin } = await setup(t, { confirmed: false });
  for (const route of ['/downloads/confirm', '/downloads/revoke', '/downloads']) {
    const response = await fetch(`${origin}/api/megascans${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accepted: true }),
    });
    assert.equal(response.status, 403, route);
  }
});

test('a GLB is downloaded, size-checked and saved with its source recorded', async (t) => {
  const { fab, download, waitFor, folder, logged } = await setup(t);
  const queued = await download({ format: 'glb', quality: 'mid' });
  assert.equal(queued.status, 201);
  assert.equal(queued.data.import.source, 'fab');
  assert.equal(queued.data.import.fileUid, FILE_UIDS.glbMid);
  const done = await waitFor(queued.data.import.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  const relativePath = done.output.files[0];
  assert.match(relativePath, /^3d\/historic-crate-01-[0-9a-f]{8}\.glb$/);
  const saved = await fs.readFile(path.join(folder, ...relativePath.split('/')));
  assert.deepEqual(saved, fab.state.files[FILE_UIDS.glbMid].bytes);
  assert.deepEqual(await fs.readdir(path.join(folder, '.forge-staging', 'megascans')), []);

  // The signed address was requested once, right before the transfer, and never persisted.
  assert.equal(fab.state.infoLog.length, 1);
  assert.equal(fab.state.cdnLog.length, 1);
  const headers = fab.state.cdnLog[0].headers;
  assert.match(headers['user-agent'], /^Forge-Studio\//);
  for (const name of ['cookie', 'authorization', 'referer', 'origin']) {
    assert.equal(headers[name], undefined, name);
  }
  assert.equal(JSON.stringify(done).includes('SECRET-SIGNED-TOKEN'), false);
  assert.equal(logged.join('\n').includes('SECRET-SIGNED-TOKEN'), false);

  const meta = readAssetMeta(await fs.realpath(folder), relativePath);
  assert.equal(meta.source, 'import');
  assert.equal(meta.prompt.title, 'Historic Crate 01');
  assert.equal(meta.settings.seller, 'Quixel Megascans');
  assert.equal(meta.settings.license, 'Fab Standard License');
  assert.equal(meta.settings.fab_listing_id, LISTING);
  assert.equal(meta.settings.fab_file_uid, FILE_UIDS.glbMid);
  assert.equal(meta.settings.original_file, 'crate_xyz_mid.glb');
  assert.match(meta.settings.downloaded_at, /^20\d\d-/);
  assert.match(meta.settings.attribution, /Historic Crate 01 by Quixel Megascans/);
});

test('an FBX archive is downloaded and extracted with the same safety checks as an import', async (t) => {
  const { download, waitFor, folder } = await setup(t);
  const queued = await download({ fileUid: FILE_UIDS.fbxLow });
  const done = await waitFor(queued.data.import.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.match(done.output.folder, /^3d\/megascans-historic-crate-01-[0-9a-f]{8}$/);
  assert.equal(
    (await fs.stat(path.join(folder, ...done.output.files[0].split('/')))).isFile(),
    true,
  );
});

test('only importable files within the size limit can be queued', async (t) => {
  const { download, call } = await setup(t, { service: { maxUploadBytes: 100 } });
  const tooBig = await download({ fileUid: FILE_UIDS.glbMid });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.data.error, /larger than the import limit/);

  const open = await setup(t);
  assert.equal((await open.download({ fileUid: FILE_UIDS.usdzLow })).status, 400);
  assert.equal((await open.download({ fileUid: FILE_UIDS.exrRaw })).status, 400);
  assert.equal(
    (await open.download({ fileUid: 'bbbbbbbb-0000-4000-8000-000000000009' })).status,
    404,
  );
  assert.equal((await open.download({ format: 'glb', quality: 'raw' })).status, 404);
  assert.equal((await open.download({})).status, 404);
  assert.equal(
    (await open.call('POST', '/downloads', { project: 'x', listing: LISTING })).status,
    400,
  );
  assert.equal(
    (await open.call('POST', '/downloads', { project: PROJECT_ID, listing: fakeId(77) })).status,
    404,
  );
  assert.equal(open.fab.state.cdnLog.length, 0);
  assert.equal((await call('GET', '/imports')).data.imports.length, 0);
});

test('files over 100 MB need an explicit extra confirmation', async (t) => {
  const { download, call } = await setup(t, { service: { maxConcurrent: 0 } });
  const warned = await download({ fileUid: FILE_UIDS.fbxRaw });
  assert.equal(warned.status, 400);
  assert.equal(warned.data.needsLargeConfirmation, true);
  assert.match(warned.data.error, /150 MB/);
  assert.equal((await call('GET', '/imports')).data.imports.length, 0);
  const accepted = await download({ fileUid: FILE_UIDS.fbxRaw, confirmLarge: true });
  assert.equal(accepted.status, 201);
});

test('a second request for a file already waiting is refused', async (t) => {
  const { download, call, fab } = await setup(t, { service: { maxConcurrent: 0 } });
  assert.equal((await download()).status, 201);
  assert.equal((await download()).status, 409);
  assert.equal((await call('GET', '/imports')).data.imports.length, 1);
  assert.equal(fab.state.cdnLog.length, 0, 'queued, not started');
});

test('no more than two downloads run at once', async (t) => {
  const { fab, download, waitFor } = await setup(t);
  fab.state.cdnChunkDelayMs = 150;
  const ids = [];
  for (const choice of [
    { fileUid: FILE_UIDS.glbMid },
    { fileUid: FILE_UIDS.glbLow },
    { fileUid: FILE_UIDS.fbxLow },
  ]) {
    ids.push((await download(choice)).data.import.id);
  }
  for (const id of ids) {
    assert.equal((await waitFor(id, ['completed', 'failed'])).status, 'completed');
  }
  assert.equal(fab.state.cdnMax, 2);
});

test('an address on another host or without HTTPS is refused before any transfer', async (t) => {
  for (const mode of ['wrongHost', 'httpOnly']) {
    const { fab, download, waitFor, logged } = await setup(t, {
      service: { allowInsecureCdn: false },
    });
    fab.state.infoMode = mode;
    const queued = await download({ fileUid: FILE_UIDS.glbLow });
    const failed = await waitFor(queued.data.import.id, ['failed', 'completed']);
    assert.equal(failed.status, 'failed', mode);
    assert.match(failed.error, /unexpected host, so Forge refused it/);
    assert.equal(failed.error.includes('evil.example'), false);
    assert.equal(fab.state.cdnLog.length, 0, `${mode}: nothing was fetched`);
    assert.equal(logged.join(' ').includes('SECRET'), false);
  }
});

test('a refusal, an HTML page or a redirect from the download server stops with the blocked state', async (t) => {
  for (const mode of ['expired', 'html', 'redirect']) {
    const { fab, download, waitFor, call } = await setup(t);
    fab.state.cdnMode = mode;
    const queued = await download({ fileUid: FILE_UIDS.glbLow });
    const failed = await waitFor(queued.data.import.id, ['failed', 'completed']);
    assert.equal(failed.status, 'failed', mode);
    assert.match(failed.error, /Fab is blocking automated requests/);
    const status = (await call('GET', '/status')).data;
    assert.ok(status.fab.block, `${mode}: a pause was recorded`);
    // While paused nothing more is requested, and new downloads are refused.
    const requests = fab.state.cdnLog.length + fab.state.infoLog.length;
    assert.equal((await download({ fileUid: FILE_UIDS.glbMid })).status, 503);
    assert.equal(fab.state.cdnLog.length + fab.state.infoLog.length, requests);
  }
});

test('a download that ends early keeps its partial file and resumes with a Range request', async (t) => {
  const { fab, download, waitFor, call, folder } = await setup(t);
  fab.state.cdnMode = 'short';
  const queued = await download({ fileUid: FILE_UIDS.glbMid });
  const id = queued.data.import.id;
  const failed = await waitFor(id, ['failed', 'completed']);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ended early|interrupted/);
  const partPath = path.join(folder, '.forge-staging', 'megascans', id, 'upload.glb.part');
  const partialBytes = (await fs.stat(partPath)).size;
  assert.ok(partialBytes > 0 && partialBytes < fab.state.files[FILE_UIDS.glbMid].bytes.length);

  fab.state.cdnMode = 'ok';
  assert.equal((await call('POST', `/imports/${id}/retry`, {})).status, 200);
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(fab.state.infoLog.length, 2, 'a fresh signed address for the resume');
  assert.equal(fab.state.cdnLog[1].range, `bytes=${partialBytes}-`);
  const saved = await fs.readFile(path.join(folder, ...done.output.files[0].split('/')));
  assert.deepEqual(saved, fab.state.files[FILE_UIDS.glbMid].bytes);
});

test('a server that ignores Range makes the download start over instead of corrupting it', async (t) => {
  const { fab, download, waitFor, call, folder } = await setup(t);
  fab.state.cdnMode = 'short';
  const id = (await download({ fileUid: FILE_UIDS.glbMid })).data.import.id;
  await waitFor(id, ['failed']);
  fab.state.cdnMode = 'ok';
  fab.state.cdnRanges = false;
  await call('POST', `/imports/${id}/retry`, {});
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  const saved = await fs.readFile(path.join(folder, ...done.output.files[0].split('/')));
  assert.deepEqual(saved, fab.state.files[FILE_UIDS.glbMid].bytes);
});

test('a file larger than Fab listed is rejected and never saved', async (t) => {
  const { fab, download, waitFor, folder } = await setup(t);
  fab.state.cdnMode = 'oversize';
  const failed = await waitFor((await download({ fileUid: FILE_UIDS.glbLow })).data.import.id, [
    'failed',
    'completed',
  ]);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /not the size Fab listed|larger than Fab listed/);
  assert.deepEqual(await fs.readdir(path.join(folder, '3d')), []);
});

test('a running download can be cancelled; the partial file stays until it is dismissed', async (t) => {
  const { fab, download, waitFor, call, folder } = await setup(t);
  fab.state.cdnChunkDelayMs = 400;
  const id = (await download({ fileUid: FILE_UIDS.glbMid })).data.import.id;
  for (let attempt = 0; attempt < 200 && fab.state.cdnLog.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await call('POST', `/imports/${id}/cancel`, {})).status, 200);
  const cancelled = await waitFor(id, ['cancelled', 'completed', 'failed']);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await fs.readdir(path.join(folder, '3d')), []);
  assert.equal((await call('POST', `/imports/${id}/dismiss`, {})).status, 200);
  assert.deepEqual(await fs.readdir(path.join(folder, '.forge-staging', 'megascans')), []);
});

test('the signed address is never part of anything shown, stored or logged', async (t) => {
  const { fab, download, waitFor, call, logged, service } = await setup(t);
  fab.state.cdnMode = 'expired';
  const id = (await download({ fileUid: FILE_UIDS.glbLow })).data.import.id;
  await waitFor(id, ['failed']);
  const everything = JSON.stringify([
    (await call('GET', '/imports')).data,
    (await call('GET', '/status')).data,
    logged,
  ]);
  assert.equal(everything.includes('SECRET-SIGNED-TOKEN'), false);
  assert.equal(everything.includes(SECRET_TOKEN), false);
  const rows = service.state.handle.db.prepare('SELECT * FROM imports').all();
  assert.equal(JSON.stringify(rows).includes('SECRET-SIGNED-TOKEN'), false);
});
