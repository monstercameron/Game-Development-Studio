import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  isPanoramaShellRecord,
  readMetaIndex,
  recordJobOutput,
  resetBackfillCache,
} from '../runtime/asset-metadata.js';
import {
  PANORAMA_FOV_RANGE,
  PANORAMA_INSIDE_FOV,
  SHELL_MIN_TRIANGLES,
  clampPitch,
  describePanoramaView,
  detectPanoramaShell,
  dragLook,
  lookForward,
  lookFromDirection,
  turnLook,
  wheelFieldOfView,
  zoomFieldOfView,
} from '../src/viewer-panorama.js';

// A closed UV sphere with outward-facing triangles, as nine numbers per triangle.
function sphereTriangles({ radius = 1, rings = 24, sectors = 48, scale = [1, 1, 1] } = {}) {
  const point = (ring, sector) => {
    const polar = (Math.PI * ring) / rings;
    const azimuth = (2 * Math.PI * sector) / sectors;
    return [
      Math.sin(polar) * Math.cos(azimuth) * radius * scale[0],
      Math.cos(polar) * radius * scale[1],
      Math.sin(polar) * Math.sin(azimuth) * radius * scale[2],
    ];
  };
  const values = [];
  const push = (a, b, c) => {
    const normal = cross(subtract(b, a), subtract(c, a));
    const centroid = [0, 1, 2].map((axis) => (a[axis] + b[axis] + c[axis]) / 3);
    // Wind each triangle so its normal points away from the sphere centre.
    const [p, q] = dot(normal, centroid) < 0 ? [c, b] : [b, c];
    values.push(...a, ...p, ...q);
  };
  for (let ring = 0; ring < rings; ring++) {
    for (let sector = 0; sector < sectors; sector++) {
      const a = point(ring, sector);
      const b = point(ring + 1, sector);
      const c = point(ring + 1, sector + 1);
      const d = point(ring, sector + 1);
      if (ring > 0) {
        push(a, b, d);
      }
      if (ring < rings - 1) {
        push(d, b, c);
      }
    }
  }
  return values;
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Deterministic pseudo-random numbers so failures reproduce.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const near = (actual, expected, tolerance = 1e-9, message = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} != ${expected}`);

test('a closed panorama-like shell is detected from its triangles', () => {
  const sphere = detectPanoramaShell(sphereTriangles());
  assert.equal(sphere.isShell, true, sphere.reason);
  assert.equal(sphere.reason, 'closed-around-centre');
  // A shell that is half as tall as it is wide still counts; a room is rarely a cube.
  assert.equal(detectPanoramaShell(sphereTriangles({ scale: [1, 0.5, 1] })).isShell, true);
});

test('flat sheets, tall pillars and tiny meshes are not panorama shells', () => {
  const sheet = [];
  for (let index = 0; index < 400; index++) {
    const x = index % 20;
    const y = Math.floor(index / 20);
    sheet.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
  }
  assert.deepEqual(
    { isShell: false, reason: detectPanoramaShell(sheet).reason },
    { isShell: false, reason: 'not-cubic' },
  );

  const pillar = sphereTriangles({ scale: [0.05, 5, 0.05] });
  assert.equal(detectPanoramaShell(pillar).reason, 'not-cubic');

  const tiny = sphereTriangles({ rings: 4, sectors: 4 });
  assert.ok(tiny.length / 9 < SHELL_MIN_TRIANGLES);
  assert.equal(detectPanoramaShell(tiny).reason, 'too-few-triangles');
});

test('a closed shell whose faces point in mixed directions is not a panorama', () => {
  const values = sphereTriangles();
  // Flip every other triangle so the winding is inconsistent, as a damaged export can be.
  for (let triangle = 0; triangle * 9 < values.length; triangle += 2) {
    const offset = triangle * 9;
    for (let corner = 0; corner < 3; corner++) {
      const first = offset + 3 + corner;
      const second = offset + 6 + corner;
      [values[first], values[second]] = [values[second], values[first]];
    }
  }
  assert.equal(detectPanoramaShell(values).reason, 'mixed-facing');
});

test('random triangles inside a cube are not treated as a closed shell', () => {
  const random = seededRandom(7);
  const values = [];
  for (let index = 0; index < 600 * 9; index++) {
    values.push(random() * 2 - 1);
  }
  assert.equal(detectPanoramaShell(values).reason, 'mixed-facing');
});

test('a sampled shell keeps its verdict on a dense mesh', () => {
  const dense = sphereTriangles({ rings: 80, sectors: 120 });
  assert.equal(detectPanoramaShell(dense, { sampleLimit: 500 }).isShell, true);
});

test('look angles point the camera along the expected direction from the centre', () => {
  const forward = (direction) => lookForward(lookFromDirection(direction));
  // A camera on +Z looking back at the centre faces -Z, the front view.
  const front = forward([0, 0, 1]);
  near(front[2], -1, 1e-9, 'front z');
  near(front[0], 0, 1e-9, 'front x');
  // A camera on +X looks toward -X.
  near(forward([1, 0, 0])[0], -1, 1e-9, 'right view');
  // The top preset looks down, clamped just short of straight down.
  assert.ok(forward([0, 1, 0])[1] < -0.99);
  // Arbitrary directions are recovered as the reverse of the camera offset.
  const direction = [0.3, -0.2, 0.9];
  const length = Math.hypot(...direction);
  const expected = direction.map((value) => -value / length);
  const actual = forward(direction);
  for (let axis = 0; axis < 3; axis++) {
    near(actual[axis], expected[axis], 1e-9, `axis ${axis}`);
  }
});

test('dragging turns the view with the pointer and pitch never flips over', () => {
  const start = { yaw: 0, pitch: 0 };
  assert.ok(dragLook(start, 100, 0).yaw > 0, 'drag right turns the view left');
  assert.ok(dragLook(start, 0, 40).pitch > 0, 'drag down looks up');
  assert.equal(dragLook(start, 0, -1e9).pitch, clampPitch(-1e9));
  assert.ok(Math.abs(clampPitch(10)) < Math.PI / 2);
  const turned = turnLook(start, 0.25, -0.5);
  near(turned.yaw, 0.25, 1e-12);
  near(turned.pitch, -0.5, 1e-12);
});

test('zoom inside a panorama changes the field of view within its range', () => {
  const [minimum, maximum] = PANORAMA_FOV_RANGE;
  assert.ok(zoomFieldOfView(PANORAMA_INSIDE_FOV, 0.8) < PANORAMA_INSIDE_FOV, 'zoom in narrows');
  assert.ok(zoomFieldOfView(PANORAMA_INSIDE_FOV, 1.25) > PANORAMA_INSIDE_FOV, 'zoom out widens');
  assert.equal(zoomFieldOfView(minimum, 0.1), minimum);
  assert.equal(zoomFieldOfView(maximum, 10), maximum);
  assert.ok(wheelFieldOfView(PANORAMA_INSIDE_FOV, 100) > PANORAMA_INSIDE_FOV);
  assert.ok(wheelFieldOfView(PANORAMA_INSIDE_FOV, -100) < PANORAMA_INSIDE_FOV);
  assert.equal(wheelFieldOfView(PANORAMA_INSIDE_FOV, Number.NaN), PANORAMA_INSIDE_FOV);
  assert.equal(wheelFieldOfView(PANORAMA_INSIDE_FOV, 1e6), maximum);
});

test('the note says which side is shown and when the shape was only inferred', () => {
  assert.match(describePanoramaView({ inside: true, source: 'metadata' }), /viewed from inside/);
  assert.match(describePanoramaView({ inside: false, source: 'metadata' }), /viewed from outside/);
  assert.doesNotMatch(describePanoramaView({ inside: true, source: 'metadata' }), /shape/);
  assert.match(
    describePanoramaView({ inside: true, source: 'geometry' }),
    /Detected from the mesh shape\.$/,
  );
});

test('only WorldGen GLB outputs are flagged as panorama shells in the details index', async (t) => {
  assert.equal(isPanoramaShellRecord('worldgen', { output: 'glb' }), true);
  assert.equal(isPanoramaShellRecord('worldgen', { output: 'splat' }), false);
  assert.equal(isPanoramaShellRecord('hy-world', { output: 'glb' }), false);
  assert.equal(isPanoramaShellRecord(null, undefined), false);

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-panorama-index-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  resetBackfillCache();
  const id = randomUUID();
  const world = {
    id,
    type: 'world',
    projectId: randomUUID(),
    status: 'completed',
    request: {
      model: 'worldgen',
      mode: 'text',
      output: 'glb',
      prompt: 'a quiet courtyard',
      resolution: 512,
      seed: 5,
      steps: 10,
    },
    output: `3d/forge-${id}.glb`,
    startedAt: '2026-11-08T10:00:00.000Z',
    finishedAt: '2026-11-08T10:03:00.000Z',
  };
  const other = {
    ...world,
    id: randomUUID(),
    request: { ...world.request, output: 'splat' },
  };
  other.output = `3d/forge-${other.id}.ply`;
  recordJobOutput(world, folder);
  recordJobOutput(other, folder);
  const index = readMetaIndex(folder);
  assert.equal(index[world.output].panorama, true);
  assert.equal(index[other.output].panorama, undefined);
});
