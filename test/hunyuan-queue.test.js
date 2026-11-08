import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { stageProjectAsset } from '../runtime/references.js';

async function waitFor(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fn()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw Error('Timed out');
}
test(
  '3D jobs use snapshotted images and recoverably save a GLB to older projects',
  { timeout: 15000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-hunyuan-test-')),
      projects = path.join(dir, 'projects'),
      project = path.join(projects, 'Game'),
      id = randomUUID();
    await fs.mkdir(path.join(project, 'images'), { recursive: true });
    await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id }));
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('snapshot')]);
    await fs.writeFile(path.join(project, 'images', 'source.png'), png);
    const ref = await stageProjectAsset(project, 'images/source.png');
    await fs.writeFile(path.join(project, 'images', 'source.png'), 'changed');
    let submissions = 0;
    const remoteId = 'a'.repeat(32);
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/status') {
        return res.end(
          JSON.stringify({
            engine: 'forge-hunyuan-shape-v1',
            phase: 'ready',
            loaded: true,
            model_downloaded: true,
          }),
        );
      }
      if (req.url === '/api/generate' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
        }
        const body = JSON.parse(raw);
        assert.equal(body.image, `data:image/png;base64,${png.toString('base64')}`);
        submissions++;
        return res.end(JSON.stringify({ id: remoteId }));
      }
      if (req.url === `/api/jobs/${remoteId}`) {
        return res.end(JSON.stringify({ status: 'completed' }));
      }
      if (req.url === `/api/jobs/${remoteId}/mesh`) {
        return res.end('glTF-fixture');
      }
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const previous = process.env.FORGE_HUNYUAN_URL;
    process.env.FORGE_HUNYUAN_URL = `http://127.0.0.1:${server.address().port}`;
    const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, intervalMs: 50 });
    try {
      const input = {
        type: '3d',
        projectId: id,
        request: { model: 'hunyuan', references: [ref.id], steps: 30, resolution: 128, seed: 42 },
      };
      assert.throws(
        () => queue.enqueue({ ...input, request: { ...input.request, model: 'trellis' } }),
        /Only Hunyuan/,
      );
      const first = queue.enqueue(input);
      await waitFor(() => queue.get(first.id)?.status === 'completed');
      assert.equal(submissions, 1);
      assert.equal(
        await fs.readFile(path.join(project, ...queue.get(first.id).output.split('/')), 'utf8'),
        'glTF-fixture',
      );
      assert.equal(queue.estimate(input).sampleCount, 1);
      await fs.unlink(path.join(project, '.forge-inputs', ref.id));
      const second = queue.enqueue(input);
      await waitFor(() => queue.get(second.id)?.status === 'failed');
      assert.match(queue.get(second.id).error, /reference/i);
      assert.equal(submissions, 1);
    } finally {
      queue.stop();
      if (previous === undefined) {
        delete process.env.FORGE_HUNYUAN_URL;
      } else {
        process.env.FORGE_HUNYUAN_URL = previous;
      }
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('3D texture options are validated and kept only when on', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-hunyuan-texture-')),
    projects = path.join(dir, 'projects'),
    project = path.join(projects, 'Game'),
    id = randomUUID();
  await fs.mkdir(path.join(project, 'images'), { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id }));
  await fs.writeFile(
    path.join(project, 'images', 'source.png'),
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('snapshot')]),
  );
  const ref = await stageProjectAsset(project, 'images/source.png');
  const queue = new JobQueue({
    directory: path.join(dir, 'state'),
    projects,
    intervalMs: 50,
    autoStart: false,
  });
  try {
    const base = { type: '3d', projectId: id, request: { references: [ref.id] } };
    for (const bad of [{ texture: 'yes' }, { texture: 1 }, { texture: true, texture_size: 512 }]) {
      assert.throws(
        () => queue.enqueue({ ...base, request: { ...base.request, ...bad } }),
        /texture/i,
      );
    }
    const shapeOnly = queue.enqueue({ ...base, request: { ...base.request, texture: false } });
    assert.equal('texture' in shapeOnly.request, false);
    assert.equal('texture_size' in shapeOnly.request, false);
    const painted = queue.enqueue({
      ...base,
      request: { ...base.request, texture: true, texture_size: 1024 },
    });
    assert.equal(painted.request.texture, true);
    assert.equal(painted.request.texture_size, 1024);
    const defaults = queue.enqueue({ ...base, request: { ...base.request, texture: true } });
    assert.equal(defaults.request.texture_size, 2048);
  } finally {
    queue.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
