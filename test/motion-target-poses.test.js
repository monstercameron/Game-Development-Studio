import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { stagePose } from '../runtime/references.js';
import { hyMotionVariationCount } from '../src/hymotion-settings.js';
import { motionBricksRequest } from '../src/motionbricks-settings.js';

const fixture = Buffer.from(
  'HIERARCHY\nROOT Hips\n{\n}\nMOTION\nFrames: 1\nFrame Time: 0.033333333\n0\n',
);

test('HY-Motion variation count is a whole number from 1 to 4 and defaults to one', () => {
  assert.equal(hyMotionVariationCount({}), 1);
  assert.equal(hyMotionVariationCount({ motionVariations: '' }), 1);
  assert.equal(hyMotionVariationCount({ motionVariations: '3' }), 3);
  for (const motionVariations of ['0', '5', '1.5', 'many']) {
    assert.throws(() => hyMotionVariationCount({ motionVariations }), /between 1 and 4/);
  }
});

test('MotionBricks target poses default to four and are omitted from the request', () => {
  const base = { contextFrame: '0', targetFrame: '20', minTokens: '8', maxTokens: '14' };
  const pose = '00000000-0000-0000-0000-000000000001.bvh';
  assert.deepEqual(motionBricksRequest({ ...base }, pose), {
    pose,
    context_frame: 0,
    target_frame: 20,
    min_tokens: 8,
    max_tokens: 14,
  });
  assert.deepEqual(motionBricksRequest({ ...base, targetPoses: '' }, pose), {
    pose,
    context_frame: 0,
    target_frame: 20,
    min_tokens: 8,
    max_tokens: 14,
  });
  assert.equal(motionBricksRequest({ ...base, targetPoses: '2' }, pose).num_target_poses, 2);
  for (const targetPoses of ['0', '5', '2.5', 'two']) {
    assert.throws(() => motionBricksRequest({ ...base, targetPoses }, pose), /1 to 4 target poses/);
  }
});

test('durable queue validates and keeps the MotionBricks target pose count', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-target-poses-')),
    projects = path.join(dir, 'projects'),
    project = path.join(projects, 'Game'),
    id = randomUUID();
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, '.forge-project.json'), JSON.stringify({ id }));
  const pose = await stagePose(project, fixture);
  const previous = process.env.FORGE_MOTIONBRICKS_URL;
  // Nothing listens here, so an accepted job stays queued while the test checks its request.
  process.env.FORGE_MOTIONBRICKS_URL = 'http://127.0.0.1:9';
  const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, intervalMs: 50 });
  try {
    const base = {
      type: 'motion-bricks',
      projectId: id,
      request: { pose: pose.id, context_frame: 0, target_frame: 20 },
    };
    for (const numTargetPoses of [0, 5, 2.5, '2', true]) {
      assert.throws(
        () =>
          queue.enqueue({
            ...base,
            request: { ...base.request, num_target_poses: numTargetPoses },
          }),
        /1 to 4/,
        `rejects ${String(numTargetPoses)}`,
      );
    }
    const defaulted = queue.enqueue(base);
    assert.equal(defaulted.request.num_target_poses, undefined);
    const two = queue.enqueue({ ...base, request: { ...base.request, num_target_poses: 2 } });
    assert.equal(two.request.num_target_poses, 2);
  } finally {
    queue.stop();
    if (previous === undefined) {
      delete process.env.FORGE_MOTIONBRICKS_URL;
    } else {
      process.env.FORGE_MOTIONBRICKS_URL = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
