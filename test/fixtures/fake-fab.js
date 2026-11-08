// A loopback stand-in for the parts of fab.com that Forge reads. Tests never contact fab.com.
import { once } from 'node:events';
import http from 'node:http';
import { buildZip, tinyGlb } from './zip-builder.js';

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

export const FILE_UIDS = {
  glbMid: 'aaaaaaaa-0000-4000-8000-000000000001',
  glbLow: 'aaaaaaaa-0000-4000-8000-000000000002',
  fbxLow: 'aaaaaaaa-0000-4000-8000-000000000003',
  usdzLow: 'aaaaaaaa-0000-4000-8000-000000000004',
  exrRaw: 'aaaaaaaa-0000-4000-8000-000000000005',
  fbxRaw: 'aaaaaaaa-0000-4000-8000-000000000006',
};
export const SECRET_TOKEN = 'cf_token=SECRET-SIGNED-TOKEN-123';

/** The files every fake listing offers, with real bytes the fake CDN can serve. */
function fakeFiles() {
  const model = Buffer.concat([tinyGlb(), Buffer.alloc(4096, 7)]);
  return {
    [FILE_UIDS.glbMid]: { name: 'crate_xyz_mid.glb', code: 'converted-files', bytes: model },
    [FILE_UIDS.glbLow]: { name: 'crate_xyz_low.glb', code: 'converted-files', bytes: tinyGlb() },
    [FILE_UIDS.fbxLow]: {
      name: 'crate_xyz_low.zip',
      code: 'fbx',
      bytes: buildZip([
        { name: 'crate/crate.fbx', data: 'Kaydara FBX Binary  \0data' },
        { name: 'crate/tex/albedo.png', data: Buffer.alloc(2048, 5) },
      ]),
    },
    [FILE_UIDS.fbxRaw]: {
      name: 'crate_xyz_raw.zip',
      code: 'fbx',
      bytes: Buffer.alloc(16, 2),
      claimedSize: 150 * 1024 * 1024,
    },
    [FILE_UIDS.usdzLow]: {
      name: 'crate_xyz_low.usdz',
      code: 'converted-files',
      bytes: Buffer.alloc(64, 9),
    },
    [FILE_UIDS.exrRaw]: {
      name: 'crate_xyz_exr_raw.zip',
      code: 'additional-files',
      bytes: Buffer.alloc(8, 1),
      claimedSize: 1_907_253_724,
    },
  };
}

export function fakeId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function rawListing(index, base, overrides = {}) {
  return {
    uid: fakeId(index),
    title: `Historic Crate ${String(index).padStart(2, '0')}`,
    listingType: '3d-model',
    firstPublishedAt: new Date(Date.UTC(2026, 0, 1) + (1000 - index) * 86400000).toISOString(),
    startingPrice: { price: 0.0, offerId: 'x' },
    isFree: false,
    user: { sellerName: 'Quixel Megascans' },
    category: { name: index % 2 ? 'Furniture & Fixtures' : 'Nature & Plants' },
    tags: [{ name: index % 2 ? 'Wood' : 'Stone' }, { name: 'Photogrammetry' }],
    licenses: [{ name: 'Personal', isCc: false }],
    assetFormats: [
      {
        assetFormatType: { code: 'fbx', name: 'FBX', extensions: ['fbx'] },
        fileSizesRange: { lower: 1000 * index, upper: 5_000_000 + index },
      },
    ],
    thumbnails: [
      {
        mediaUrl: `${base}/media/${index}/d`,
        images: [
          { url: `${base}/media/${index}/3`, width: 144, height: 81 },
          { url: `${base}/media/${index}/b`, width: 320, height: 180 },
        ],
      },
    ],
    ...overrides,
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.total] How many free models the fake seller has.
 * @param {number} [options.pageSize]
 */
export async function startFakeFab({ total = 5, pageSize = 2 } = {}) {
  const state = {
    log: [],
    // When true the JSON and image endpoints send an ETag and answer If-None-Match with 304.
    etags: false,
    revision: 1,
    mode: 'ok',
    inFlight: 0,
    maxInFlight: 0,
    delayMs: 0,
    total,
    pageSize,
    retryAfter: '0',
    failuresLeft: 0,
    imageKind: 'png',
    files: fakeFiles(),
    cdnMode: 'ok',
    cdnRanges: true,
    cdnChunkDelayMs: 0,
    infoMode: 'ok',
    cdnLog: [],
    cdnInFlight: 0,
    cdnMax: 0,
    infoLog: [],
  };
  let base = '';
  const server = http.createServer(async (req, res) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    const url = new URL(req.url, 'http://127.0.0.1');
    state.log.push({
      at: Date.now(),
      path: url.pathname,
      search: url.search,
      headers: { ...req.headers },
    });
    try {
      if (state.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }
      if (state.failuresLeft > 0) {
        state.failuresLeft--;
        res.writeHead(state.mode === 'flaky500' ? 503 : 429, { 'Retry-After': state.retryAfter });
        return res.end('slow down');
      }
      if (state.mode === 'challenge') {
        res.writeHead(403, { 'Content-Type': 'text/html', 'cf-mitigated': 'challenge' });
        return res.end('<html><title>Just a moment...</title></html>');
      }
      if (state.mode === 'html200') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html><body>cf-chl captcha</body></html>');
      }
      if (state.mode === 'redirect') {
        res.writeHead(302, { Location: 'https://elsewhere.example/' });
        return res.end();
      }
      if (state.mode === 'limited') {
        res.writeHead(429, { 'Retry-After': '99999' });
        return res.end();
      }
      const validator = `"rev-${state.revision}"`;
      const notModified = () =>
        state.etags && req.headers['if-none-match'] === validator
          ? (res.writeHead(304, { ETag: validator }), res.end(), true)
          : false;
      const json = (status, body) => {
        if (status === 200 && state.etags) {
          if (notModified()) {
            return;
          }
          res.writeHead(status, { 'Content-Type': 'application/json', ETag: validator });
        } else {
          res.writeHead(status, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/i/listings/search') {
        const start = Number(
          Buffer.from(url.searchParams.get('cursor') || '', 'base64').toString() || 0,
        );
        const wanted = (url.searchParams.get('q') || '').toLowerCase();
        const all = Array.from({ length: state.total }, (_, index) => index + 1)
          .map((index) => rawListing(index, base))
          .filter((item) => !wanted || item.title.toLowerCase().includes(wanted));
        const end = start + state.pageSize;
        const results = all.slice(start, end);
        // Distractors Forge must drop: another seller, a paid listing, a different type.
        if (start === 0) {
          results.push(
            rawListing(900, base, { user: { sellerName: 'Someone Else' } }),
            rawListing(901, base, { startingPrice: { price: 9.99 } }),
            rawListing(902, base, { listingType: 'material' }),
          );
        }
        return json(200, {
          results,
          cursors: { next: end < all.length ? Buffer.from(String(end)).toString('base64') : null },
        });
      }
      const detail = /^\/i\/listings\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (detail) {
        return json(200, {
          uid: detail[1],
          description: '<p>Rustic crate &amp; barrel.</p><p>Texel density: <b>5941</b> px/m</p>',
          licenses: [{ group: 'standard', isCc: false, name: 'Personal' }],
          assetFormats: [
            { assetFormatType: { code: 'fbx', name: 'FBX' } },
            { assetFormatType: { code: 'additional-files', name: 'Additional files' } },
          ],
        });
      }
      const allFormats = /^\/i\/listings\/([0-9a-f-]{36})\/asset-formats$/.exec(url.pathname);
      if (allFormats) {
        const byCode = new Map();
        for (const [uid, file] of Object.entries(state.files)) {
          if (!byCode.has(file.code)) {
            byCode.set(file.code, []);
          }
          byCode.get(file.code).push({
            fileSize: file.claimedSize ?? file.bytes.length,
            name: file.name,
            uid,
          });
        }
        return json(
          200,
          [...byCode].map(([code, files]) => ({
            assetFormatType: { code, extensions: [code], name: code.toUpperCase() },
            files,
          })),
        );
      }
      const info =
        /^\/i\/listings\/([0-9a-f-]{36})\/asset-formats\/([\w-]+)\/files\/([0-9a-f-]{36})\/download-info$/.exec(
          url.pathname,
        );
      if (info) {
        state.infoLog.push({ at: Date.now(), uid: info[3] });
        const file = state.files[info[3]];
        if (!file) {
          return json(404, {});
        }
        const host = state.infoMode === 'wrongHost' ? 'https://evil.example' : base;
        const address =
          state.infoMode === 'httpOnly'
            ? `http://cdn.example/${info[3]}/${file.name}?${SECRET_TOKEN}`
            : `${host}/cdn/${info[3]}/${file.name}?${SECRET_TOKEN}`;
        return json(200, {
          downloadInfo: [
            {
              assetFormat: `asset-format/${info[2]}`,
              downloadUrl: address,
              expires: new Date(Date.now() + 300000).toISOString(),
              type: 'binary',
            },
          ],
        });
      }
      const cdn = /^\/cdn\/([0-9a-f-]{36})\/(.+)$/.exec(url.pathname);
      if (cdn) {
        const file = state.files[cdn[1]];
        state.cdnInFlight++;
        state.cdnMax = Math.max(state.cdnMax, state.cdnInFlight);
        res.on('close', () => {
          state.cdnInFlight--;
        });
        state.cdnLog.push({
          at: Date.now(),
          range: req.headers.range || null,
          query: url.search,
          headers: { ...req.headers },
        });
        if (!file || url.search.slice(1) !== SECRET_TOKEN) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          return res.end('expired');
        }
        if (state.cdnMode === 'expired') {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          return res.end('<html>Access denied</html>');
        }
        if (state.cdnMode === 'html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html>challenge</html>');
        }
        if (state.cdnMode === 'redirect') {
          res.writeHead(302, { Location: 'https://elsewhere.example/file' });
          return res.end();
        }
        let bytes = file.bytes;
        if (state.cdnMode === 'oversize') {
          bytes = Buffer.concat([bytes, Buffer.alloc(1024, 1)]);
        }
        let status = 200;
        let start = 0;
        const headers = { 'Content-Type': 'application/octet-stream' };
        const wanted = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        if (wanted && state.cdnRanges) {
          start = Number(wanted[1]);
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${bytes.length - 1}/${bytes.length}`;
        }
        if (state.cdnRanges) {
          headers['Accept-Ranges'] = 'bytes';
        }
        let body = bytes.subarray(start);
        if (state.cdnMode === 'short') {
          body = body.subarray(0, Math.floor(body.length / 2));
          headers['Content-Length'] = bytes.length - start;
        } else {
          headers['Content-Length'] = body.length;
        }
        res.writeHead(status, headers);
        if (state.cdnChunkDelayMs) {
          const half = Math.ceil(body.length / 2);
          res.write(body.subarray(0, half));
          await new Promise((resolve) => setTimeout(resolve, state.cdnChunkDelayMs));
          return res.end(body.subarray(half));
        }
        return res.end(body);
      }
      const format = /^\/i\/listings\/([0-9a-f-]{36})\/asset-formats\/(\w[\w-]*)$/.exec(
        url.pathname,
      );
      if (format) {
        return json(200, {
          assetFormatType: { code: format[2], name: 'FBX' },
          files: [
            { name: 'crate_high.zip', size: 108107779, faceCount: 20000, vertexCount: 9994 },
            { name: 'crate_low.zip', size: 7246865, faceCount: 2510, vertexCount: 1249 },
          ],
          techDetails: {
            threeDModel: {
              texturesCount: 9,
              materialsCount: 1,
              textureResolutionRange: { lower: 1024, upper: 8193 },
              totalTrianglesCountRange: { lower: 2510, upper: 1000013 },
            },
          },
        });
      }
      if (url.pathname.startsWith('/media/')) {
        const kind = state.imageKind;
        if (state.etags && notModified()) {
          return;
        }
        if (kind === 'html') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end('<html>not an image</html>');
        }
        if (kind === 'huge') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          return res.end(Buffer.concat([PNG, Buffer.alloc(600 * 1024, 3)]));
        }
        res.writeHead(200, {
          'Content-Type': kind === 'jpeg' ? 'image/jpeg' : 'image/png',
          ...(state.etags ? { ETag: validator } : {}),
        });
        return res.end(kind === 'jpeg' ? JPEG : PNG);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{}');
    } finally {
      state.inFlight--;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    count: (prefix) => state.log.filter((entry) => entry.path.startsWith(prefix)).length,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
