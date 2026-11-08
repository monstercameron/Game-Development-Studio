import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readGlbStats } from '../runtime/glb-stats.js';
import {
  buildSchema,
  generateVegetation,
  loadSeedThree,
  pickLevel,
} from '../runtime/vegetation-adapter.js';
import {
  generateVegetationAsset,
  loadSchemaSync,
  quickCheckoutStatus,
} from '../runtime/vegetation-runner.js';
import { makeFakeSeedThree } from './fixtures/fake-seedthree-setup.js';

test('the Forge schema is built from SeedThree schema and hides controls that do nothing', async () => {
  const fake = await makeFakeSeedThree();
  try {
    const api = await loadSeedThree(fake.directory);
    const schema = buildSchema(api, { version: '0.0.0-test', commit: fake.commit });
    assert.equal(schema.seedthree.commit, fake.commit);
    const tree = schema.species.find((item) => item.key === 'fakeTree');
    const ids = tree.controls.map((control) => control.id);
    assert.deepEqual(ids, [
      'height',
      'branches',
      'crown',
      'showLeaves',
      'leafAngle',
      'paramOverrides.angle.1',
    ]);
    assert.equal(tree.controls.find((control) => control.id === 'branches').type, 'integer');
    assert.equal(tree.controls.find((control) => control.id === 'height').type, 'number');
    assert.equal(tree.controls.find((control) => control.id === 'showLeaves').type, 'boolean');
    assert.deepEqual(tree.controls.find((control) => control.id === 'crown').options, [
      { label: 'Conical', value: 0 },
      { label: 'Spherical', value: 1 },
    ]);
    assert.equal(tree.controls.find((control) => control.id === 'leafAngle').group, 'leaves');
    assert.deepEqual(
      schema.budgets.map((budget) => budget.id),
      ['low', 'medium', 'high'],
    );
  } finally {
    await fake.remove();
  }
});

test('budgets pick levels by triangle count, even when the levels are not in order', () => {
  const stats = { perLod: [{ triangles: 56000 }, { triangles: 32000 }, { triangles: 52000 }] };
  assert.equal(pickLevel(stats, 'high'), 0);
  assert.equal(pickLevel(stats, 'medium'), 2);
  assert.equal(pickLevel(stats, 'low'), 1);
  const two = { perLod: [{ triangles: 10 }, { triangles: 5 }] };
  assert.equal(pickLevel(two, 'low'), 1);
  assert.equal(pickLevel(two, 'medium'), 1);
  assert.equal(pickLevel(two, 'high'), 0);
});

test('generation is validated again in the child and refuses plants over the limits', async () => {
  const fake = await makeFakeSeedThree();
  try {
    const api = await loadSeedThree(fake.directory);
    const schema = buildSchema(api);
    const ok = await generateVegetation(api, schema, {
      species: 'fakeTree',
      seed: 3,
      budget: 'high',
      params: { branches: 10 },
    });
    assert.equal(ok.result.triangles, 10 * 100 * 1);
    assert.equal(ok.preset.format, 'seedthree-preset/1');
    assert.ok(readGlbBytes(ok.glb));
    await assert.rejects(
      generateVegetation(api, schema, { species: 'fakeTree', params: { branches: 99 } }),
      /from 1 to 20/,
    );
    await assert.rejects(
      generateVegetation(api, schema, { species: 'huge', budget: 'high' }),
      /limit is 1,500,000/,
    );
    await assert.rejects(
      generateVegetation(
        api,
        { ...schema, limits: { ...schema.limits, maxGlbBytes: 100 } },
        {
          species: 'fakeTree',
        },
      ),
      /MiB; the limit is/,
    );
  } finally {
    await fake.remove();
  }
});

function readGlbBytes(buffer) {
  return buffer.readUInt32LE(0) === 0x46546c67 && buffer.readUInt32LE(4) === 2;
}

// The next tests run SeedThree itself (CPU only, a second or two). They are skipped when
// external/SeedThree has not been fetched, so a source checkout still passes.
const real = quickCheckoutStatus();
const realOptions = { skip: real.ready ? false : `SeedThree is not fetched (${real.code})` };

test(
  'the real SeedThree describes twenty species with schema-driven controls',
  realOptions,
  async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-real-schema-'));
    try {
      const schema = loadSchemaSync({ env: { ...process.env, FORGE_RUNTIME_DIR: runtime } });
      assert.equal(schema.species.length, 20);
      assert.equal(schema.seedthree.commit, real.commit);
      for (const species of schema.species) {
        assert.ok(species.controls.length >= 10, `${species.key} has controls`);
        assert.ok(species.controls.every((control) => control.type !== 'color'));
        assert.ok(
          species.controls.every(
            (control) => !/Tint|tileWorldSize|leafAlpha|barkFlat/.test(control.id),
          ),
        );
      }
      const oak = schema.species.find((item) => item.key === 'whiteOak');
      assert.deepEqual(
        oak.controls.slice(0, 2).map((control) => [control.id, control.min, control.max]),
        [
          ['height', 4, 26],
          ['levels', 2, 4],
        ],
      );
    } finally {
      await fs.rm(runtime, { recursive: true, force: true });
    }
  },
);

test(
  'the real SeedThree grows valid GLBs at each budget, deterministically',
  { ...realOptions, timeout: 120000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-real-veg-'));
    const env = { ...process.env, FORGE_RUNTIME_DIR: path.join(root, 'runtime') };
    const project = path.join(root, 'project');
    await fs.mkdir(project, { recursive: true });
    try {
      const grow = (request) =>
        generateVegetationAsset({ projectFolder: project, jobId: randomUUID(), request, env });
      const triangles = {};
      for (const budget of ['low', 'medium', 'high']) {
        const started = Date.now();
        const made = await grow({ species: 'whiteOak', seed: 7, budget, params: {} });
        const file = path.join(project, ...made.output.split('/'));
        const stats = readGlbStats(file);
        assert.ok(stats && stats.primitives >= 2 && stats.triangles > 0, `${budget}: valid GLB`);
        assert.equal(stats.bytes, made.result.glbBytes);
        assert.ok(Date.now() - started < 30000, `${budget}: finished in under 30 s`);
        const preset = JSON.parse(
          await fs.readFile(path.join(project, ...made.presetOutput.split('/')), 'utf8'),
        );
        assert.equal(preset.format, 'seedthree-preset/1');
        assert.equal(preset.controls.seed, 7);
        triangles[budget] = made.result.triangles;
      }
      assert.ok(
        triangles.low < triangles.medium && triangles.medium < triangles.high,
        JSON.stringify(triangles),
      );
      // Different species use the other generator and cactus code paths.
      for (const species of ['saguaro', 'sagebrush', 'joshuaTree']) {
        const made = await grow({ species, seed: 3, budget: 'medium', params: {} });
        assert.ok(made.result.triangles > 100, `${species} has geometry`);
        assert.ok(readGlbStats(path.join(project, ...made.output.split('/'))).triangles > 0);
      }
      const first = await grow({
        species: 'whiteOak',
        seed: 11,
        budget: 'low',
        params: { height: 20 },
      });
      const second = await grow({
        species: 'whiteOak',
        seed: 11,
        budget: 'low',
        params: { height: 20 },
      });
      const other = await grow({
        species: 'whiteOak',
        seed: 12,
        budget: 'low',
        params: { height: 20 },
      });
      const read = (made) => fs.readFile(path.join(project, ...made.output.split('/')));
      assert.ok((await read(first)).equals(await read(second)), 'same seed, same bytes');
      assert.ok(!(await read(first)).equals(await read(other)), 'a different seed differs');
      // A taller design is a bigger plant.
      const shorter = await grow({
        species: 'whiteOak',
        seed: 11,
        budget: 'low',
        params: { height: 8 },
      });
      assert.ok(first.result.heightMeters > shorter.result.heightMeters);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
