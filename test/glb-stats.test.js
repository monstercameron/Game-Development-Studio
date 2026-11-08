import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readGlbStats, statsFromGltf } from '../runtime/glb-stats.js';

function glb(json, binaryBytes = 8) {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const binary = Buffer.alloc(binaryBytes);
  const total = 12 + 8 + padded.length + 8 + binary.length;
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binaryHeader, binary]);
}

const gltf = {
  accessors: [{ count: 100 }, { count: 300 }, { count: 60 }],
  meshes: [
    {
      primitives: [
        { attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1 },
        { attributes: { POSITION: 0 }, mode: 5, indices: 1 },
      ],
    },
  ],
  materials: [{}],
  images: [{}, {}],
};

test('statsFromGltf counts triangles, vertices, materials and textures', () => {
  assert.deepEqual(statsFromGltf(gltf), {
    triangles: 100 + 298,
    vertices: 200,
    primitives: 2,
    materials: 1,
    textures: 2,
    hasUvs: true,
  });
  // Without indices the vertex count is the draw count.
  const plainStats = statsFromGltf({
    accessors: [{ count: 9 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  });
  assert.equal(plainStats.triangles, 3);
  assert.equal(plainStats.hasUvs, false);
  assert.equal(statsFromGltf({}).triangles, 0);
});

test('readGlbStats reads a GLB header and rejects other files', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-glb-'));
  try {
    const file = path.join(folder, 'a.glb');
    const bytes = glb(gltf);
    fs.writeFileSync(file, bytes);
    const stats = readGlbStats(file);
    assert.equal(stats.bytes, bytes.length);
    assert.equal(stats.triangles, 398);
    const textFile = path.join(folder, 'b.glb');
    fs.writeFileSync(textFile, 'not a glb at all, just text that is long enough to read');
    assert.equal(readGlbStats(textFile), null);
    assert.equal(readGlbStats(path.join(folder, 'missing.glb')), null);
    const truncated = path.join(folder, 'c.glb');
    fs.writeFileSync(truncated, bytes.subarray(0, 40));
    assert.equal(readGlbStats(truncated), null);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
