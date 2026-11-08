// Test double for SeedThree's headless API (src/api/seedthree.js): the same exports Forge's
// adapter uses, with no three.js. Special species let tests exercise failure paths:
//   crash  exits the process while growing   hang  never returns   slow  takes about 1.5 s
//   huge   reports two million triangles      badglb  exports bytes that are not a GLB
const SPECIES = {
  fakeTree: { name: 'Fake Tree', latin: 'Arbor falsa', biome: 'temperate', foliageType: 'leaves' },
  fakeShrub: {
    name: 'Fake Shrub',
    latin: 'Frutex falsus',
    biome: 'desert',
    foliageType: 'sprayClusters',
  },
  crash: { name: 'Crash Test', latin: null, biome: 'temperate', foliageType: 'leaves' },
  hang: { name: 'Hang Test', latin: null, biome: 'temperate', foliageType: 'leaves' },
  slow: { name: 'Slow Test', latin: null, biome: 'temperate', foliageType: 'leaves' },
  huge: { name: 'Huge Test', latin: null, biome: 'temperate', foliageType: 'leaves' },
  badglb: { name: 'Bad GLB Test', latin: null, biome: 'temperate', foliageType: 'leaves' },
};

export function listSpecies() {
  return Object.entries(SPECIES).map(([key, species]) => ({
    key,
    name: species.name,
    latin: species.latin,
    biome: species.biome,
    foliageType: species.foliageType,
    cactus: false,
    generator: 'weber-penn',
  }));
}

export function getSchema(key) {
  const species = SPECIES[key];
  if (!species) {
    throw new Error(`unknown species "${key}"`);
  }
  return {
    species: key,
    name: species.name,
    latin: species.latin,
    biome: species.biome,
    foliageType: species.foliageType,
    cactus: false,
    generator: 'weber-penn',
    shape: [
      {
        key: 'height',
        name: 'Height (m)',
        group: 'shape',
        default: 10,
        min: 2,
        max: 30,
        step: 0.5,
      },
      { key: 'branches', name: 'Branches', group: 'shape', default: 4, min: 1, max: 20, step: 1 },
      {
        key: 'crown',
        name: 'Crown shape',
        group: 'shape',
        default: 1,
        options: { Conical: 0, Spherical: 1 },
      },
    ],
    advanced: [
      {
        path: 'paramOverrides.angle.1',
        name: 'Angle - L1',
        group: 'advanced',
        min: 0,
        max: 90,
        step: 1,
        default: 40,
      },
    ],
    global: [
      { key: 'seed', name: 'Seed', group: 'global', min: 1, max: 9999, step: 1, default: 1 },
      { key: 'showLeaves', name: 'Show leaves', group: 'global', type: 'bool', default: true },
      {
        key: 'tileWorldSize',
        name: 'Bark tiling (m)',
        group: 'global',
        min: 0.6,
        max: 3,
        step: 0.05,
        default: 1.5,
      },
      { key: 'barkTint', name: 'Bark tint', group: 'material', type: 'color', default: 0xffffff },
      {
        key: 'leafAngle',
        name: 'Leaf angle',
        group: 'material',
        min: 0,
        max: 100,
        step: 1,
        default: 52,
      },
    ],
    lod: [],
  };
}

export function defaultControls(key) {
  const schema = getSchema(key);
  return {
    seed: 1,
    paramOverrides: {},
    ...Object.fromEntries(schema.shape.map((control) => [control.key, control.default])),
  };
}

export function toPreset({ species, seed = 1, controls = {} }) {
  return {
    format: 'seedthree-preset/1',
    species,
    controls: { ...defaultControls(species), ...controls, seed },
  };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function generate({ species, seed = 1, controls = {} }) {
  // Forge measures every species at seed 1 with default controls; the failure species stay quiet then.
  const isMeasurement = seed === 1 && Object.keys(controls).length === 0;
  if (species === 'crash' && !isMeasurement) {
    process.exit(3);
  }
  if (species === 'hang' && !isMeasurement) {
    for (;;) {
      // Spin until the host's timeout ends this process.
    }
  }
  if (species === 'slow' && !isMeasurement) {
    sleep(1500);
  }
  const branches = controls.branches ?? 4;
  const high = species === 'huge' ? 2_000_000 : branches * 100 * ((seed % 3) + 1);
  const levels = [high, Math.round(high / 2), Math.round(high / 6)].map((triangles, index) => ({
    object: { species, triangles, userData: { lodName: `LOD${index}` } },
    distance: index * 35,
  }));
  const stats = {
    summary: {
      lodCount: 3,
      widthMeters: 4,
      heightMeters: controls.height ?? 10,
      depthMeters: 4,
      lod0Triangles: high,
    },
    perLod: levels.map((level, index) => ({
      name: `LOD${index}`,
      distance: level.distance,
      meshes: 2,
      instances: 0,
      triangles: level.object.triangles,
      verts: level.object.triangles + 2,
    })),
    boundingBox: null,
  };
  return { group: { levels }, stats, preset: toPreset({ species, seed, controls }), shaped: {} };
}

export function statsOf(group) {
  return {
    summary: {},
    perLod: group.levels.map((level) => ({
      name: level.object.userData.lodName,
      triangles: level.object.triangles,
      verts: 0,
      meshes: 1,
      instances: 0,
    })),
  };
}

function glbOf(triangleCount) {
  const count = Math.max(1, Math.min(triangleCount, 3000));
  const vertexCount = count + 2;
  const positions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index++) {
    positions.set([index, index % 2, 0], index * 3);
  }
  const indices = new Uint32Array(count * 3);
  for (let triangle = 0; triangle < count; triangle++) {
    indices.set([triangle, triangle + 1, triangle + 2], triangle * 3);
  }
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const gltf = {
    asset: { version: '2.0', generator: 'fake-seedthree' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.4, 0.5, 0.3, 1] } }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [vertexCount, 1, 0],
      },
      { bufferView: 1, componentType: 5125, count: count * 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}

export async function exportGLB(object) {
  if (object.species === 'badglb') {
    return new TextEncoder().encode('this is not a glb').buffer;
  }
  const glb = glbOf(object.triangles);
  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
}
