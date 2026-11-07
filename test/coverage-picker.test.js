import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleAssets, readLibraryFiles } from '../src/asset-picker.js';

test('picker handles empty lists, extension boundaries, and case insensitive search', () => {
  const assets = [
    { name: 'portrait.PNG', id: 'Images/Hero.PNG' },
    { name: '.png', id: 'hidden/.png' },
    { name: 'portrait.png.backup', id: 'Images/portrait.png.backup' },
    { name: 'no-extension', id: 'Images/no-extension' },
  ];

  assert.deepEqual(compatibleAssets(null, ['png']), []);
  assert.deepEqual(compatibleAssets(assets, ['.PNG'], '  HERO  '), [assets[0]]);
  assert.deepEqual(compatibleAssets(assets, ['png'], 'PORTRAIT'), [assets[0]]);
  assert.deepEqual(compatibleAssets(assets, ['png'], 'missing'), []);
});

test('picker applies byte limits at exact boundaries using the downloaded blob size', async () => {
  const assets = [
    { name: 'first.bin', id: 'folder/first.bin', size: 1 },
    { name: 'second.bin', id: 'folder/second.bin', size: 2 },
  ];
  let requestCount = 0;
  const fetchImpl = async () => {
    requestCount += 1;
    return new Response(new Uint8Array([1, 2]), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };

  const files = await readLibraryFiles({ id: 'project' }, assets, {
    maxBytes: 2,
    totalBytes: 4,
    fetchImpl,
  });
  assert.equal(files.length, 2);
  assert.equal(requestCount, 2);

  await assert.rejects(
    readLibraryFiles({ id: 'project' }, assets, {
      maxBytes: 2,
      totalBytes: 3,
      fetchImpl,
    }),
    /combined size limit/i,
  );
  assert.equal(requestCount, 4);

  requestCount = 0;
  assert.deepEqual(
    await readLibraryFiles({ id: 'project' }, [], {
      maxBytes: 0,
      totalBytes: 0,
      fetchImpl,
    }),
    [],
  );
  assert.equal(requestCount, 0);
});

test('picker fetches each selected asset from its own encoded project and asset path', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(new Uint8Array([requests.length]));
  };
  const asset = { name: 'same.png', id: 'folder/same & file.png' };

  await readLibraryFiles({ id: 'project one/α' }, [asset], { fetchImpl });
  await readLibraryFiles({ id: 'project-two' }, [asset], { fetchImpl });

  assert.deepEqual(requests, [
    '/api/projects/project%20one%2F%CE%B1/asset?path=folder%2Fsame%20%26%20file.png',
    '/api/projects/project-two/asset?path=folder%2Fsame%20%26%20file.png',
  ]);
});

test('picker forwards abort signals and preserves cancellation errors', async () => {
  const controller = new AbortController();
  const abortError = new DOMException('The operation was aborted', 'AbortError');
  let receivedSignal;

  await assert.rejects(
    readLibraryFiles({ id: 'project' }, [{ name: 'cancel.png', id: 'cancel.png' }], {
      signal: controller.signal,
      fetchImpl: async (_url, options) => {
        receivedSignal = options.signal;
        throw abortError;
      },
    }),
    (error) => error === abortError,
  );
  assert.equal(receivedSignal, controller.signal);
});

test('picker wraps network and response body failures with an actionable asset name', async () => {
  const networkError = Error('socket disconnected');
  await assert.rejects(
    readLibraryFiles({ id: 'project' }, [{ name: 'broken.png', id: 'broken.png' }], {
      fetchImpl: async () => Promise.reject(networkError),
    }),
    (error) => {
      assert.match(error.message, /Could not read broken\.png/);
      assert.equal(error.cause, networkError);
      return true;
    },
  );

  await assert.rejects(
    readLibraryFiles({ id: 'project' }, [{ name: 'unavailable.png', id: 'unavailable.png' }], {
      fetchImpl: async () => new Response('', { status: 503 }),
    }),
    /Could not read unavailable\.png/,
  );
});
