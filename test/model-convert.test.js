import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { convertAsset } from '../runtime/transcode.js';
import {
  MODEL_FORMATS,
  convertModelAsset,
  isModelAsset,
  modelExtension,
} from '../runtime/model-convert.js';
import { readAssetMeta, recordJobOutput } from '../runtime/asset-metadata.js';

// 3D conversion: file-naming, safety and provenance with a substitute helper, plus one test that
// runs the real trimesh helper on a three-vertex model when the Hunyuan3D environment exists.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperPython = path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe');

// A valid GLB 2.0 holding one triangle.
function triangleGlb() {
  const positions = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(8);
  [0, 1, 2].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const binary = Buffer.concat([positions, indices]);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: binary.length }],
  };
  let json = Buffer.from(JSON.stringify(document));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = (length, type) => {
    const part = Buffer.alloc(8);
    part.writeUInt32LE(length, 0);
    part.writeUInt32LE(type, 4);
    return part;
  };
  const body = Buffer.concat([
    header(json.length, 0x4e4f534a),
    json,
    header(binary.length, 0x004e4942),
    binary,
  ]);
  const top = Buffer.alloc(12);
  top.writeUInt32LE(0x46546c67, 0);
  top.writeUInt32LE(2, 4);
  top.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([top, body]);
}

async function makeProject(t, files = { '3d/forge-1111.glb': triangleGlb() }) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-model-convert-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await fs.mkdir(path.join(folder, '3d'));
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(folder, ...name.split('/')), data);
  }
  return {
    id: randomUUID(),
    folder,
    assets: Object.keys(files).map((id) => ({ id, category: '3D' })),
  };
}

// Writes what model_convert.py would: a main file and optional companions named from the stem.
function fakeHelper(extras = []) {
  const calls = [];
  const run = async (input) => {
    calls.push(input);
    const files = [{ name: `${input.stem}.${input.format}`, role: 'main' }];
    await fs.writeFile(path.join(input.directory, files[0].name), 'converted model');
    for (const [suffix, role] of extras) {
      const name = `${input.stem}${suffix}`;
      await fs.writeFile(path.join(input.directory, name), `companion ${role}`);
      files.push({ name, role });
    }
    return { backend: 'substitute', files, notes: ['A note.'] };
  };
  return { run, calls };
}

test('only recognised 3D model files are convertible', () => {
  assert.deepEqual(MODEL_FORMATS, ['glb', 'gltf', 'obj', 'ply', 'stl']);
  assert.equal(modelExtension('3d/Thing.GLB'), 'glb');
  assert.equal(modelExtension('3d/clip.bvh'), null);
  assert.equal(isModelAsset({ id: '3d/a.stl', category: '3D' }), true);
  assert.equal(isModelAsset({ id: '3d/a.fbx', category: '3D' }), false);
  assert.equal(isModelAsset({ id: 'images/a.png', category: 'Images' }), false);
});

test('a converted model is named forge-<id>-converted and keeps the original', async (t) => {
  const project = await makeProject(t);
  const { run, calls } = fakeHelper();
  const asset = project.assets[0];
  const result = await convertModelAsset(project, asset, { format: 'stl' }, { run });
  assert.equal(result.path, '3d/forge-1111-converted.stl');
  assert.equal(result.name, 'forge-1111-converted.stl');
  assert.equal(result.backend, 'substitute');
  assert.deepEqual(result.extraFiles, []);
  assert.deepEqual(result.notes, ['A note.']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].format, 'stl');
  assert.equal(calls[0].stem, 'forge-1111-converted');
  // The helper writes into a hidden temporary folder that is removed afterwards.
  assert.match(path.basename(calls[0].directory), /^\.forge-convert-/);
  assert.equal(existsSync(calls[0].directory), false);
  assert.deepEqual((await fs.readdir(path.join(project.folder, '3d'))).sort(), [
    'forge-1111-converted.stl',
    'forge-1111.glb',
  ]);
  // A second conversion never overwrites the first.
  const again = await convertModelAsset(project, asset, { format: 'stl' }, { run });
  assert.equal(again.path, '3d/forge-1111-converted-2.stl');
});

test('OBJ conversions publish the material and texture beside the model', async (t) => {
  const project = await makeProject(t);
  const { run } = fakeHelper([
    ['.mtl', 'material'],
    ['-texture-0.png', 'texture'],
  ]);
  const result = await convertModelAsset(project, project.assets[0], { format: 'obj' }, { run });
  assert.equal(result.path, '3d/forge-1111-converted.obj');
  assert.deepEqual(
    result.extraFiles.map((file) => [file.name, file.role, file.path]),
    [
      ['forge-1111-converted.mtl', 'material', '3d/forge-1111-converted.mtl'],
      ['forge-1111-converted-texture-0.png', 'texture', '3d/forge-1111-converted-texture-0.png'],
    ],
  );
  const names = await fs.readdir(path.join(project.folder, '3d'));
  assert.ok(names.includes('forge-1111-converted.mtl'));
  assert.ok(names.includes('forge-1111-converted-texture-0.png'));
  // Every copy records that it was converted from the original.
  for (const copy of [result, ...result.extraFiles]) {
    const meta = readAssetMeta(project.folder, copy.path);
    assert.equal(meta.source, 'conversion');
    assert.equal(meta.parent.path, '3d/forge-1111.glb');
    assert.equal(meta.settings.conversion_format, 'obj');
  }
});

test('a companion file that already exists moves the copy to the next name', async (t) => {
  const project = await makeProject(t, {
    '3d/forge-1111.glb': triangleGlb(),
    '3d/forge-1111-converted.mtl': 'user file',
  });
  const { run, calls } = fakeHelper([['.mtl', 'material']]);
  const result = await convertModelAsset(project, project.assets[0], { format: 'obj' }, { run });
  assert.equal(result.path, '3d/forge-1111-converted-2.obj');
  assert.equal(calls.length, 2);
  assert.equal(
    await fs.readFile(path.join(project.folder, '3d', 'forge-1111-converted.mtl'), 'utf8'),
    'user file',
  );
  // The first attempt left nothing behind: no stray obj under the first name.
  assert.equal(existsSync(path.join(project.folder, '3d', 'forge-1111-converted.obj')), false);
});

test('conversion inherits the generation details of a generated model', async (t) => {
  const project = await makeProject(t);
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'trellis',
    status: 'completed',
    request: { model: 'trellis', steps: 12, texture_size: 1024, seed: 9, pipeline: '1024' },
    output: '3d/forge-1111.glb',
    finishedAt: new Date().toISOString(),
  };
  assert.equal(recordJobOutput(job, project.folder), true);
  const { run } = fakeHelper();
  const result = await convertModelAsset(project, project.assets[0], { format: 'ply' }, { run });
  const meta = readAssetMeta(project.folder, result.path);
  assert.equal(meta.source, 'conversion');
  assert.equal(meta.seed, 9);
  assert.equal(meta.settings.pipeline, '1024');
  assert.equal(meta.settings.conversion_format, 'ply');
  assert.equal(meta.job.id, job.id);
});

test('3D conversion rejects bad requests before running anything', async (t) => {
  const project = await makeProject(t);
  const { run, calls } = fakeHelper();
  const asset = project.assets[0];
  await assert.rejects(
    convertModelAsset(project, asset, { format: 'glb' }, { run }),
    /different 3D format/,
  );
  await assert.rejects(
    convertModelAsset(project, asset, { format: 'fbx' }, { run }),
    /different 3D format/,
  );
  await assert.rejects(convertModelAsset(project, asset, {}, { run }), /different 3D format/);
  // A helper that produces nothing, or only unsafe names, publishes nothing.
  await assert.rejects(
    convertModelAsset(project, asset, { format: 'obj' }, { run: async () => ({ files: [] }) }),
    /did not produce a file/,
  );
  const hostile = async (input) => {
    await fs.writeFile(path.join(input.directory, `${input.stem}.obj`), 'x');
    return {
      files: [
        { name: '../escape.obj', role: 'main' },
        { name: `${input.stem}.obj`, role: 'main' },
        { name: 'other-file.png', role: 'texture' },
      ],
    };
  };
  const result = await convertModelAsset(project, asset, { format: 'obj' }, { run: hostile });
  assert.equal(result.extraFiles.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(path.join(project.folder, 'escape.obj')), false);
  assert.equal(existsSync(path.join(project.folder, '3d', 'other-file.png')), false);
});

test('a 3D asset outside the project is refused', async (t) => {
  const project = await makeProject(t);
  const outside = path.join(path.dirname(project.folder), 'outside-model.glb');
  await fs.writeFile(outside, triangleGlb());
  t.after(() => fs.rm(outside, { force: true }));
  const { run, calls } = fakeHelper();
  await assert.rejects(
    convertModelAsset(
      project,
      { id: '../outside-model.glb', category: '3D' },
      { format: 'obj' },
      { run },
    ),
    /Asset not found/,
  );
  assert.equal(calls.length, 0);
});

test('convertAsset sends 3D models to the model converter, not the image one', async (t) => {
  const project = await makeProject(t);
  // Not an image, audio or video format: the generic path would reject it as unsupported.
  await assert.rejects(
    convertAsset(project, { path: '3d/forge-1111.glb', format: 'glb' }),
    /different 3D format/,
  );
  await assert.rejects(
    convertAsset(project, { path: '3d/forge-1111.glb', format: 'png' }),
    /different 3D format/,
  );
});

test(
  'the real helper converts a GLB to every other format and back',
  { skip: !existsSync(helperPython) && 'The Hunyuan3D environment is not installed.' },
  async (t) => {
    const project = await makeProject(t);
    const original = await fs.readFile(path.join(project.folder, '3d', 'forge-1111.glb'));
    const results = {};
    for (const format of ['gltf', 'obj', 'ply', 'stl']) {
      results[format] = await convertAsset(project, { path: '3d/forge-1111.glb', format });
      assert.equal(results[format].path, `3d/forge-1111-converted.${format}`);
      assert.ok((await fs.stat(path.join(project.folder, results[format].path))).size > 0);
    }
    assert.match(results.obj.backend, /trimesh/);
    assert.match(await fs.readFile(path.join(project.folder, results.obj.path), 'utf8'), /^f /m);
    // The original is untouched and nothing temporary is left in the folder.
    assert.deepEqual(
      await fs.readFile(path.join(project.folder, '3d', 'forge-1111.glb')),
      original,
    );
    assert.equal(
      (await fs.readdir(path.join(project.folder, '3d'))).some((n) => n.startsWith('.')),
      false,
    );
    // glTF, OBJ and STL copies convert back to GLB.
    for (const format of ['gltf', 'obj', 'stl']) {
      const back = await convertAsset(
        { ...project, assets: [{ id: results[format].path, category: '3D' }] },
        { path: results[format].path, format: 'glb' },
      );
      assert.match(back.name, /-converted-converted(-\d+)?\.glb$/);
      const bytes = await fs.readFile(path.join(project.folder, back.path));
      assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
    }
    // A model that is not a triangle mesh reports a readable reason.
    await fs.writeFile(path.join(project.folder, '3d', 'broken.glb'), 'not a model');
    await assert.rejects(
      convertAsset(
        { ...project, assets: [{ id: '3d/broken.glb', category: '3D' }] },
        { path: '3d/broken.glb', format: 'obj' },
      ),
      /GLB|convert|mesh/i,
    );
  },
);
