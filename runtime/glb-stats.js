// Mesh statistics for a binary glTF (GLB) file, read from its JSON chunk only.
//
// Triangle and vertex counts come from the accessor counts, so the geometry itself is never
// loaded. The result describes the file as stored, not any later change in a viewer.
import fs from 'node:fs';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
// A GLB JSON chunk larger than this is not a mesh Forge made; refuse rather than read it all.
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

function trianglesFor(mode, count) {
  if (mode === TRIANGLES) {
    return Math.floor(count / 3);
  }
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) {
    return Math.max(0, count - 2);
  }
  return 0;
}

/** Counts from a parsed glTF JSON document. */
export function statsFromGltf(gltf) {
  const accessors = Array.isArray(gltf?.accessors) ? gltf.accessors : [];
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;
  let hasUvs = false;
  for (const mesh of Array.isArray(gltf?.meshes) ? gltf.meshes : []) {
    for (const primitive of mesh?.primitives || []) {
      primitives += 1;
      const position = accessors[primitive.attributes?.POSITION];
      const positions = Number.isSafeInteger(position?.count) ? position.count : 0;
      vertices += positions;
      hasUvs ||= primitive.attributes?.TEXCOORD_0 !== undefined;
      const indices = accessors[primitive.indices];
      const drawn =
        primitive.indices !== undefined && Number.isSafeInteger(indices?.count)
          ? indices.count
          : positions;
      triangles += trianglesFor(primitive.mode ?? TRIANGLES, drawn);
    }
  }
  return {
    triangles,
    vertices,
    primitives,
    materials: Array.isArray(gltf?.materials) ? gltf.materials.length : 0,
    textures: Array.isArray(gltf?.images) ? gltf.images.length : 0,
    hasUvs,
  };
}

/** Reads statistics from a GLB file. Returns null when the file is not a readable GLB. */
export function readGlbStats(file) {
  let handle;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const header = Buffer.alloc(20);
    if (fs.readSync(handle, header, 0, 20, 0) < 20 || header.readUInt32LE(0) !== GLB_MAGIC) {
      return null;
    }
    const length = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== JSON_CHUNK || length > MAX_JSON_BYTES || 20 + length > size) {
      return null;
    }
    const json = Buffer.alloc(length);
    if (fs.readSync(handle, json, 0, length, 20) < length) {
      return null;
    }
    return { bytes: size, ...statsFromGltf(JSON.parse(json.toString('utf8'))) };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
}
