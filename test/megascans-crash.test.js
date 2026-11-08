import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadFabFile } from '../runtime/megascans-download.js';

// A download resumed after a crash. The signed address is requested again and the transfer
// continues with a Range request; after an unclean exit it first repeats the end of the partial
// file, because the file size can be journaled before the data (zeros at the end after a power
// loss).
const CONTENT = Buffer.from('0123456789'.repeat(20));

function fakeClient(requests) {
  return {
    getDownloadInfo: async () => ({ url: 'https://cdn.example/file' }),
    openDownload: async (_url, { start }) => {
      requests.push(start);
      const body = CONTENT.subarray(start);
      return {
        status: start > 0 ? 206 : 200,
        rangeStart: start,
        contentLength: body.length,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(body));
            controller.close();
          },
        }),
      };
    },
  };
}

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-megascans-crash-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    partPath: path.join(directory, 'upload.zip.part'),
    finalPath: path.join(directory, 'upload.zip'),
  };
}

const file = { uid: 'u', formatCode: 'zip', size: CONTENT.length };

test('a partial download resumes from its size with a fresh request and ends identical', async (t) => {
  const { partPath, finalPath } = await setup(t);
  await fs.writeFile(partPath, CONTENT.subarray(0, 80));
  const requests = [];
  const result = await downloadFabFile({
    client: fakeClient(requests),
    listingId: 'l',
    file,
    partPath,
    finalPath,
    resumeOverlapBytes: 0,
  });
  assert.deepEqual(requests, [80]);
  assert.equal(result.resumed, true);
  assert.deepEqual(await fs.readFile(finalPath), CONTENT);
  await assert.rejects(fs.stat(partPath), { code: 'ENOENT' });
});

test('after an unclean exit a zero-filled tail of the partial file is downloaded again', async (t) => {
  const { partPath, finalPath } = await setup(t);
  // 100 bytes are on disk, but only the first 60 are real; the rest is the zero fill a power
  // loss leaves behind a journaled size.
  const torn = Buffer.concat([CONTENT.subarray(0, 60), Buffer.alloc(40)]);
  await fs.writeFile(partPath, torn);
  const requests = [];
  await downloadFabFile({
    client: fakeClient(requests),
    listingId: 'l',
    file,
    partPath,
    finalPath,
    resumeOverlapBytes: 50,
  });
  assert.deepEqual(requests, [50]);
  assert.deepEqual(await fs.readFile(finalPath), CONTENT);
});

test('a partial file that already has the full size is still re-checked after an unclean exit', async (t) => {
  const { partPath, finalPath } = await setup(t);
  const torn = Buffer.concat([CONTENT.subarray(0, 150), Buffer.alloc(50)]);
  await fs.writeFile(partPath, torn);
  const requests = [];
  await downloadFabFile({
    client: fakeClient(requests),
    listingId: 'l',
    file,
    partPath,
    finalPath,
    resumeOverlapBytes: 100,
  });
  assert.deepEqual(requests, [100]);
  assert.deepEqual(await fs.readFile(finalPath), CONTENT);
});

test('the overlap is on by default only when the studio says the previous session was unclean', async (t) => {
  const previous = process.env.FORGE_PREVIOUS_UNCLEAN;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FORGE_PREVIOUS_UNCLEAN;
    } else {
      process.env.FORGE_PREVIOUS_UNCLEAN = previous;
    }
  });
  const run = async (flag) => {
    if (flag) {
      process.env.FORGE_PREVIOUS_UNCLEAN = '1';
    } else {
      delete process.env.FORGE_PREVIOUS_UNCLEAN;
    }
    const { partPath, finalPath } = await setup(t);
    await fs.writeFile(partPath, CONTENT.subarray(0, 80));
    const requests = [];
    await downloadFabFile({
      client: fakeClient(requests),
      listingId: 'l',
      file,
      partPath,
      finalPath,
    });
    return requests;
  };
  assert.deepEqual(await run(false), [80]);
  assert.deepEqual(await run(true), [0], 'a short partial file restarts from the beginning');
});
