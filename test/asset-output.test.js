import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAssetOutputs } from '../runtime/asset-output.js';

test('completed jobs report renamed project assets without changing their original history', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-output-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Game'),
    id = randomUUID();
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id }));
  await fs.writeFile(path.join(folder, 'images', 'hero.png'), 'image');
  await fs.writeFile(
    path.join(folder, '.forge-assets.json'),
    JSON.stringify({
      version: 1,
      assets: {
        'images/hero.png': { sourceOutput: 'images/forge-original.png', rating: 5 },
        '../escape.png': { sourceOutput: 'images/escape.png' },
      },
    }),
  );
  const jobs = [
    { id: 'one', projectId: id, status: 'completed', output: 'images/forge-original.png' },
    { id: 'two', projectId: id, status: 'running', output: 'images/forge-original.png' },
    { id: 'three', projectId: id, status: 'completed', output: 'images/escape.png' },
  ];
  const resolved = await resolveAssetOutputs(jobs, { root });
  assert.equal(resolved[0].output, 'images/hero.png');
  assert.equal(resolved[0].originalOutput, 'images/forge-original.png');
  assert.equal(resolved[1].output, 'images/forge-original.png');
  assert.equal(resolved[2].output, 'images/escape.png');
  assert.equal(jobs[0].output, 'images/forge-original.png');
  await fs.unlink(path.join(folder, 'images', 'hero.png'));
  assert.equal(
    (await resolveAssetOutputs([jobs[0]], { root }))[0].output,
    'images/forge-original.png',
  );
});

test('ambiguous or linked rename destinations do not redirect job output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-output-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Game'),
    id = randomUUID();
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, '.forge-project.json'), JSON.stringify({ id }));
  for (const name of ['one.png', 'two.png']) {
    await fs.writeFile(path.join(folder, 'images', name), name);
  }
  await fs.writeFile(
    path.join(folder, '.forge-assets.json'),
    JSON.stringify({
      version: 1,
      assets: {
        'images/one.png': { sourceOutput: 'images/original.png' },
        'images/two.png': { sourceOutput: 'images/original.png' },
      },
    }),
  );
  const job = { projectId: id, status: 'completed', output: 'images/original.png' };
  assert.equal((await resolveAssetOutputs([job], { root }))[0].output, job.output);
});
