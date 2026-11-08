import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const encoder = new TextEncoder();

// The viewer reads OBJ and STL (the formats the 3D converter now writes) as plain geometry.
test('the viewer parses OBJ and STL files and labels the formats', async () => {
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  });
  try {
    const { parseModelBytes, computeSceneStats } =
      await vite.ssrLoadModule('/src/viewer-assets.js');
    const { assetFormat } = await vite.ssrLoadModule('/src/viewer-core.js');

    const obj = 'mtllib x.mtl\no tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl m\nf 1 2 3\n';
    const parsedObj = await parseModelBytes(encoder.encode(obj).buffer, 'tri.obj');
    assert.equal(parsedObj.kind, 'mesh');
    assert.equal(computeSceneStats(parsedObj.root).triangles, 1);

    const ascii = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid t
`;
    const parsedAscii = await parseModelBytes(encoder.encode(ascii).buffer, 'tri.stl');
    assert.equal(computeSceneStats(parsedAscii.root).triangles, 1);

    // Binary STL: 80-byte header, triangle count, then 50 bytes per triangle.
    const binary = new DataView(new ArrayBuffer(84 + 50));
    binary.setUint32(80, 1, true);
    [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) =>
      binary.setFloat32(84 + index * 4, value, true),
    );
    const parsedBinary = await parseModelBytes(binary.buffer, 'tri.STL');
    assert.equal(parsedBinary.kind, 'mesh');
    const stats = computeSceneStats(parsedBinary.root);
    assert.equal(stats.triangles, 1);
    assert.equal(stats.vertices, 3);

    await assert.rejects(
      parseModelBytes(new ArrayBuffer(8), 'scene.dae'),
      /cannot be previewed here/,
    );
    assert.equal(assetFormat('a.obj').label, 'OBJ');
    assert.equal(assetFormat('a.stl').label, 'STL');
  } finally {
    await vite.close();
  }
});
