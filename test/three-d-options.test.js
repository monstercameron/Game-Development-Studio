import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JobQueue } from '../runtime/jobs.js';
import { hunyuanShapeRequest } from '../src/hunyuan-settings.js';
import { describeSettings, reusePlan } from '../src/generation-details.js';
import { estimateFromNearbyHistory } from '../runtime/queue-timing.js';
import {
  HUNYUAN_TEXTURE_EXTRA_VIEWS_MIB,
  HUNYUAN_TEXTURE_GPU_BUDGET_MIB,
  createHunyuanRenderPreparation,
} from '../runtime/hunyuan-preparation.js';
import {
  TRELLIS_RENDER_BUDGETS,
  createTrellisRenderPreparation,
  trellisRenderBudget,
} from '../runtime/trellis-preparation.js';
import { installedTrellisPipelines } from '../runtime/trellis-pipelines.js';
import { inspectService } from '../runtime/catalog.js';

const ref = `${randomUUID()}.png`;

test('Hunyuan painter options are advanced, validated and left out at their defaults', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-paint-'));
  const projects = path.join(dir, 'projects');
  const projectId = randomUUID();
  await fs.mkdir(path.join(projects, 'P'), { recursive: true });
  await fs.writeFile(
    path.join(projects, 'P', '.forge-project.json'),
    JSON.stringify({ id: projectId }),
  );
  const queue = new JobQueue({ directory: path.join(dir, 'state'), projects, autoStart: false });
  t.after(async () => {
    queue.stop();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = { references: [ref], texture: true };
  const queued = (request) =>
    queue.enqueue({ type: '3d', projectId, request: { ...base, ...request } });
  const plain = queued({});
  assert.equal('texture_views' in plain.request, false);
  assert.equal('texture_view_size' in plain.request, false);
  const sameAsDefault = queued({ texture_views: 6, texture_view_size: 512 });
  assert.equal('texture_views' in sameAsDefault.request, false);
  const large = queued({ texture_views: 8, texture_view_size: 768 });
  assert.equal(large.request.texture_views, 8);
  assert.equal(large.request.texture_view_size, 768);
  for (const bad of [{ texture_views: 5 }, { texture_views: '8' }, { texture_view_size: 1024 }]) {
    assert.throws(() => queued(bad), /Painted views/);
  }
  // They only mean something when painting.
  assert.throws(
    () =>
      queue.enqueue({ type: '3d', projectId, request: { references: [ref], texture_views: 8 } }),
    /only apply with texture on/,
  );
  // A larger painter never borrows the default's timing history.
  const insertCompletedJob = (request, seconds) => {
    queue.db
      .prepare(
        "INSERT INTO jobs(id,type,project_id,request,status,created_at,updated_at,started_at,finished_at) VALUES(?,?,?,?,'completed','a','a',?,?)",
      )
      .run(
        randomUUID(),
        '3d',
        projectId,
        JSON.stringify({
          ...base,
          model: 'hunyuan',
          resolution: 128,
          steps: 30,
          texture_size: 2048,
          ...request,
        }),
        '2026-01-01T00:00:00.000Z',
        new Date(Date.parse('2026-01-01T00:00:00.000Z') + seconds * 1000).toISOString(),
      );
  };
  insertCompletedJob({}, 300);
  const estimate = (request) =>
    queue.estimate({ type: '3d', projectId, request: { ...base, ...request } });
  assert.equal(estimate({}).typicalSeconds, 300);
  assert.equal(estimate({ texture_views: 8 }).available, false);
  assert.equal(estimate({ texture_view_size: 768 }).available, false);
  const jobs = [
    {
      type: '3d',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:05:00Z',
      request: { ...base, resolution: 128, steps: 30, texture_size: 2048 },
    },
  ];
  const target = { ...base, resolution: 128, steps: 30, texture_size: 2048 };
  assert.ok(estimateFromNearbyHistory('3d', target, jobs));
  assert.equal(estimateFromNearbyHistory('3d', { ...target, texture_views: 9 }, jobs), null);
  assert.equal(estimateFromNearbyHistory('3d', { ...target, texture_view_size: 768 }, jobs), null);
});

test('the Hunyuan painter settings map to the request and back to the page', () => {
  const draft = { texture: true, textureSize: 2048, textureViews: '8', textureViewSize: 768 };
  const request = hunyuanShapeRequest(draft, [ref]);
  assert.equal(request.texture_views, 8);
  assert.equal(request.texture_view_size, 768);
  assert.equal('texture_views' in hunyuanShapeRequest({ texture: true }, [ref]), false);
  // Without painting they are ignored rather than sent.
  assert.equal('texture_views' in hunyuanShapeRequest({ textureViews: 9 }, [ref]), false);
  assert.throws(
    () => hunyuanShapeRequest({ texture: true, textureViews: 5 }, [ref]),
    /Painted views/,
  );
  assert.throws(
    () => hunyuanShapeRequest({ texture: true, textureViewSize: 640 }, [ref]),
    /Painted views/,
  );

  // Generation details list them and Reuse settings restores them.
  const meta = {
    job: { type: '3d' },
    prompt: {},
    settings: { ...request, steps: 30 },
  };
  const labels = describeSettings({ type: '3d', settings: meta.settings }).map(
    (item) => item.label,
  );
  assert.ok(labels.includes('Painted views'));
  assert.ok(labels.includes('Painted view size (px)'));
  const plan = reusePlan(meta);
  assert.equal(plan.draft.textureViews, '8');
  assert.equal(plan.draft.textureViewSize, '768');
  assert.equal(
    reusePlan({ ...meta, settings: { texture: true, texture_size: 1024 } }).draft.textureViews,
    '6',
  );
});

test('larger painter settings wait for the extra GPU memory measured for them', async () => {
  const gpuMiB = (extra) =>
    HUNYUAN_TEXTURE_GPU_BUDGET_MIB + (extra ? HUNYUAN_TEXTURE_EXTRA_VIEWS_MIB : 0) + 2048;
  let free = gpuMiB(false);
  const prepare = createHunyuanRenderPreparation({
    hardware: async () => ({ devices: [{ freeMiB: free }] }),
    services: async () => [],
    freeMemory: () => 64 * 1024 ** 3,
  });
  assert.equal(await prepare({ resolution: 128, texture: true }), null);
  assert.equal(
    (await prepare({ resolution: 128, texture: true, texture_views: 8, texture_view_size: 768 }))
      .status,
    'waiting_memory',
  );
  free = gpuMiB(true);
  assert.equal(
    await prepare({ resolution: 128, texture: true, texture_views: 8, texture_view_size: 768 }),
    null,
  );
});

test('TRELLIS.2 render budgets grow with the pipeline and the worker asks for the right one', async () => {
  const gpu = (pipeline) => TRELLIS_RENDER_BUDGETS[pipeline].gpuMiB;
  assert.ok(gpu('512') < gpu('1024') && gpu('1024') < gpu('1024_cascade'));
  assert.ok(gpu('1024_cascade') < gpu('1536_cascade'));
  assert.equal(trellisRenderBudget({}).gpuMiB, gpu('512'));
  assert.equal(trellisRenderBudget({ pipeline: 'unknown' }).gpuMiB, gpu('512'));
  // GPU memory is large here (96 GB); the biggest budget must still fit it, host RAM is soft.
  assert.ok(gpu('1536_cascade') <= 80 * 1024);
  let free = gpu('512') + 2048;
  const prepare = createTrellisRenderPreparation({
    hardware: async () => ({ devices: [{ freeMiB: free }] }),
    services: async () => [],
    freeMemory: () => 64 * 1024 ** 3,
  });
  assert.equal(await prepare({}), null);
  assert.equal(await prepare({ pipeline: '512' }), null);
  assert.equal((await prepare({ pipeline: '1536_cascade' })).status, 'waiting_memory');
  free = gpu('1536_cascade') + 2048;
  assert.equal(await prepare({ pipeline: '1536_cascade' }), null);
  // A short host-memory floor still blocks, with a message that names the shortage.
  const starved = createTrellisRenderPreparation({
    hardware: async () => ({ devices: [{ freeMiB: 90000 }] }),
    services: async () => [],
    freeMemory: () => 1024,
  });
  assert.equal((await starved({ pipeline: '1024' })).details.code, 'insufficient_host_memory');
});

test('installed TRELLIS.2 pipelines are read from the checkpoint files', async (t) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-trellis-models-'));
  t.after(() => fs.rm(models, { recursive: true, force: true }));
  const folder = path.join(models, 'TRELLIS.2-4B', 'ckpts');
  await fs.mkdir(folder, { recursive: true });
  assert.deepEqual(installedTrellisPipelines(models), ['512']);
  const names = [
    'slat_flow_img2shape_dit_1_3B_1024_bf16',
    'slat_flow_imgshape2tex_dit_1_3B_1024_bf16',
  ];
  for (const name of names) {
    await fs.writeFile(path.join(folder, `${name}.json`), '{}');
  }
  await fs.writeFile(path.join(folder, `${names[0]}.safetensors`), 'x');
  assert.deepEqual(installedTrellisPipelines(models), ['512']);
  await fs.writeFile(path.join(folder, `${names[1]}.safetensors`), 'x');
  assert.deepEqual(installedTrellisPipelines(models), [
    '512',
    '1024',
    '1024_cascade',
    '1536_cascade',
  ]);
  // An empty checkpoint file does not count.
  await fs.writeFile(path.join(folder, `${names[1]}.safetensors`), '');
  assert.deepEqual(installedTrellisPipelines(models), ['512']);

  // The service list carries the pipelines, even when the worker is not running.
  const state = await inspectService({
    id: '3d-trellis',
    name: 'TRELLIS.2',
    kind: 'trellis',
    port: 1,
    endpoint: '/api/status',
  });
  assert.equal(state.status, 'unavailable');
  assert.ok(Array.isArray(state.pipelines) && state.pipelines.includes('512'));
  const other = await inspectService({
    id: '3d-hunyuan',
    name: 'Hunyuan',
    kind: 'hunyuan',
    port: 1,
    endpoint: '/api/status',
  });
  assert.equal('pipelines' in other, false);
});
