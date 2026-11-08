import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { stageReference } from '../runtime/references.js';
import { readAssetMeta } from '../runtime/asset-metadata.js';
import { reusePlan, describeSettings } from '../src/generation-details.js';

async function projectFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-world-options-')),
    projects = path.join(root, 'projects'),
    folder = path.join(projects, 'game'),
    projectId = randomUUID();
  await fs.mkdir(path.join(folder, '3d'), { recursive: true });
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id: projectId }));
  const image = await stageReference(folder, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  return { root, projects, folder, projectId, image };
}

test('world options are validated, default ones stay out of the request, and seeds are recorded', async () => {
  const { root, projects, projectId, image } = await projectFixture();
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, intervalMs: 100 });
  const enqueue = (request) => queue.enqueue({ type: 'world', projectId, request });
  const text = { model: 'worldgen', mode: 'text', prompt: 'a harbour', resolution: 1024 };
  const views = { model: 'hy-world', mode: 'image', resolution: 518, references: [image.id] };
  try {
    // A blank seed becomes a recorded random one; the same request never repeats by accident.
    const first = enqueue({ ...text, references: [], seed: null });
    const second = enqueue({ ...text, references: [] });
    for (const job of [first, second]) {
      assert.ok(Number.isInteger(job.request.seed) && job.request.seed >= 0);
      assert.equal(job.request.steps, 50);
      assert.equal('guidance' in job.request, false);
      assert.equal('save_panorama' in job.request, false);
    }
    assert.equal(enqueue({ ...text, references: [], seed: 7 }).request.seed, 7);

    // Seed and steps mean nothing without a FLUX panorama, so they are not recorded.
    const reconstruction = enqueue({ ...views, output: 'splat' });
    assert.deepEqual(reconstruction.request, {
      model: 'hy-world',
      mode: 'image',
      prompt: '',
      output: 'splat',
      resolution: 518,
      references: [image.id],
    });
    const panorama = enqueue({
      model: 'worldgen',
      mode: 'panorama',
      output: 'glb',
      resolution: 2048,
      references: [image.id],
    });
    assert.equal('seed' in panorama.request, false);
    assert.equal(panorama.request.output, 'glb');

    const tuned = enqueue({
      ...text,
      references: [],
      guidance: 3.5,
      save_panorama: true,
      output: 'mesh',
    });
    assert.equal(tuned.request.guidance, 3.5);
    assert.equal(tuned.request.save_panorama, true);
    const splats = enqueue({
      ...views,
      resolution: 952,
      splat_limit: 250000,
      remove_sky: true,
      confidence_percentile: 0,
    });
    assert.equal(splats.request.resolution, 952);
    assert.equal(splats.request.splat_limit, 250000);
    assert.equal(splats.request.remove_sky, true);
    assert.equal(splats.request.confidence_percentile, 0);

    const rejected = (request, pattern) => assert.throws(() => enqueue(request), pattern);
    rejected({ ...text, references: [], guidance: 0.5 }, /Guidance/);
    rejected({ ...text, references: [], guidance: 51 }, /Guidance/);
    rejected({ ...views, guidance: 7 }, /Guidance/);
    rejected(
      {
        model: 'worldgen',
        mode: 'panorama',
        resolution: 1024,
        references: [image.id],
        save_panorama: true,
      },
      /panorama/,
    );
    rejected({ ...views, splat_limit: 50000 }, /splat limit/);
    rejected({ ...views, splat_limit: 6000000 }, /splat limit/);
    rejected({ ...views, confidence_percentile: 51 }, /confidence/);
    rejected({ ...text, references: [], remove_sky: true }, /splat limit/);
    rejected({ ...text, references: [], splat_limit: 250000 }, /splat limit/);
    // HY-World can also start from one 360 panorama, which it cuts into views itself.
    const cut = enqueue({ ...views, mode: 'panorama' });
    assert.equal(cut.request.mode, 'panorama');
    rejected({ ...views, mode: 'panorama', references: [image.id, image.id] }, /HY-World/);
    rejected({ ...views, mode: 'text', references: [] }, /HY-World/);
    rejected({ ...views, output: 'glb' }, /HY-World/);
    rejected({ ...views, resolution: 1024 }, /HY-World/);
    rejected({ ...text, references: [], resolution: 952 }, /WorldGen/);
    rejected({ ...text, references: [], seed: 2147483648 }, /seed/);
    rejected({ ...text, references: [], output: 'obj' }, /Invalid world/);
  } finally {
    queue.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a GLB mesh and the generated panorama are saved and described in the project', async () => {
  const { root, projects, folder, projectId } = await projectFixture();
  const requests = [];
  const server = createServer(async (req, res) => {
    const json = (value) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (req.url === '/api/status') {
      return json({ engine: 'forge-world-v1', ready: true, busy: false });
    }
    if (req.url === '/api/generate') {
      let body = '';
      for await (const part of req) {
        body += part;
      }
      requests.push(JSON.parse(body));
      return json({ id: 'a'.repeat(32) });
    }
    if (req.url.endsWith('/world')) {
      res.end('glTF-binary-stand-in');
      return;
    }
    if (req.url.endsWith('/panorama')) {
      res.end('png-stand-in');
      return;
    }
    if (req.url.startsWith('/api/jobs/')) {
      return json({ status: 'completed' });
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const old = process.env.FORGE_WORLD_URL;
  process.env.FORGE_WORLD_URL = `http://127.0.0.1:${server.address().port}`;
  const queue = new JobQueue({ directory: path.join(root, 'runtime'), projects, intervalMs: 100 });
  try {
    const job = queue.enqueue({
      type: 'world',
      projectId,
      request: {
        model: 'worldgen',
        mode: 'text',
        prompt: 'a harbour',
        output: 'glb',
        resolution: 1024,
        references: [],
        guidance: 4,
        save_panorama: true,
      },
    });
    const deadline = Date.now() + 20000;
    while (
      Date.now() < deadline &&
      !['completed', 'failed', 'interrupted'].includes(queue.get(job.id).status)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const done = queue.get(job.id);
    assert.equal(done.status, 'completed', done.error || done.stage);
    assert.equal(done.output, `3d/forge-${job.id}.glb`);
    assert.equal(
      await fs.readFile(path.join(folder, '3d', `forge-${job.id}.glb`), 'utf8'),
      'glTF-binary-stand-in',
    );
    const panoramaPath = `images/forge-${job.id}-panorama.png`;
    assert.equal(await fs.readFile(path.join(folder, panoramaPath), 'utf8'), 'png-stand-in');
    // The extra image carries the same details as the world it came from.
    const recorded = readAssetMeta(folder, panoramaPath);
    assert.equal(recorded.model.name, 'WorldGen');
    assert.equal(recorded.job.id, job.id);
    assert.equal(requests[0].guidance, 4);
    assert.equal(requests[0].output, 'glb');
    assert.equal(requests[0].save_panorama, true);
    assert.equal(typeof requests[0].seed, 'number');
    // Seed, guidance and the rest come back as reusable settings; the engine id is not a setting.
    const meta = readAssetMeta(folder, done.output);
    const plan = reusePlan(meta);
    assert.equal(plan.section, 'world');
    assert.equal(plan.world.prompt, 'a harbour');
    assert.equal(plan.world.output, 'glb');
    assert.equal(plan.world.guidance, 4);
    assert.equal(plan.world.save_panorama, true);
    assert.equal(plan.world.seed, requests[0].seed);
    const labels = describeSettings(meta).map((row) => row.label);
    assert.ok(!labels.includes('Engine option'));
    assert.ok(labels.includes('Guidance') && labels.includes('Panorama image saved'));
  } finally {
    queue.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (old === undefined) {
      delete process.env.FORGE_WORLD_URL;
    } else {
      process.env.FORGE_WORLD_URL = old;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
