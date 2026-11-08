// Panorama shells: a WorldGen mesh built from a 360-degree panorama is a closed shell that is
// meant to be seen from inside. This module holds the pure logic (detection, look angles and
// field of view) with no three.js or DOM, so it can be unit tested. The engine applies it.

import { clamp } from './viewer-core.js';

// Field of view in degrees. Outside keeps the viewer default; inside is wider so the room
// around the camera reads as a panorama.
export const PANORAMA_OUTSIDE_FOV = 38;
export const PANORAMA_INSIDE_FOV = 75;
export const PANORAMA_FOV_RANGE = [30, 100];

// Geometric fallback, used only when the stored generation details do not identify the
// asset. A panorama shell is about as tall as it is wide, and nearly every triangle faces the
// same way relative to the shell's centre (the mean of its triangles), as a surface seen from
// inside does. Closed, roughly convex objects also pass, so the viewer's toggle stays available.
export const SHELL_MIN_TRIANGLES = 200;
export const SHELL_MIN_ASPECT = 0.25;
export const SHELL_FACING_SHARE = 0.9;
export const SHELL_SAMPLE_LIMIT = 20000;

// Pitch is kept just short of straight up or down so the view basis never degenerates.
const PITCH_LIMIT = Math.PI / 2 - 0.01;
// Radians of turn per pixel of drag; one full screen width is about a half turn.
const DRAG_RADIANS_PER_PIXEL = 0.005;
// Scroll units (deltaY) to degrees of field of view.
const WHEEL_DEGREES_PER_UNIT = 0.05;

// Decides from triangle corners whether the surface is a panorama shell.
// `triangles` holds nine numbers per triangle (three world-space corners) in any order.
// Returns { isShell, reason } so callers and tests can see why a mesh was not classed.
export function detectPanoramaShell(triangles, { sampleLimit = SHELL_SAMPLE_LIMIT } = {}) {
  const triangleCount = Math.floor(triangles.length / 9);
  if (triangleCount < SHELL_MIN_TRIANGLES) {
    return { isShell: false, reason: 'too-few-triangles' };
  }
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < triangles.length; index++) {
    const axis = index % 3;
    const value = triangles[index];
    if (value < minimum[axis]) {
      minimum[axis] = value;
    }
    if (value > maximum[axis]) {
      maximum[axis] = value;
    }
  }
  const extents = [0, 1, 2].map((axis) => maximum[axis] - minimum[axis]);
  const largest = Math.max(...extents);
  if (!(largest > 0) || !Number.isFinite(largest)) {
    return { isShell: false, reason: 'no-extent' };
  }
  if (Math.min(...extents) / largest < SHELL_MIN_ASPECT) {
    return { isShell: false, reason: 'not-cubic' };
  }

  const stride = Math.max(1, Math.ceil(triangleCount / sampleLimit));
  // The centre is the mean of the sampled triangle centroids. The bounding-box centre sits
  // noticeably off a depth-lifted panorama, while the mean stays near its capture point.
  const centroids = [];
  for (let triangle = 0; triangle < triangleCount; triangle += stride) {
    const offset = triangle * 9;
    centroids.push([
      (triangles[offset] + triangles[offset + 3] + triangles[offset + 6]) / 3,
      (triangles[offset + 1] + triangles[offset + 4] + triangles[offset + 7]) / 3,
      (triangles[offset + 2] + triangles[offset + 5] + triangles[offset + 8]) / 3,
    ]);
  }
  const centre = [0, 1, 2].map(
    (axis) => centroids.reduce((total, point) => total + point[axis], 0) / centroids.length,
  );

  let counted = 0;
  let positive = 0;
  let negative = 0;
  for (let triangle = 0; triangle < triangleCount; triangle += stride) {
    const offset = triangle * 9;
    const a = triangles.slice(offset, offset + 3);
    const b = triangles.slice(offset + 3, offset + 6);
    const c = triangles.slice(offset + 6, offset + 9);
    const normal = cross(subtract(b, a), subtract(c, a));
    const toCentre = subtract(
      centre,
      [0, 1, 2].map((axis) => (a[axis] + b[axis] + c[axis]) / 3),
    );
    if (length(normal) < 1e-12 || length(toCentre) < 1e-9) {
      continue;
    }
    counted += 1;
    const facing = dot(normal, toCentre);
    if (facing > 0) {
      positive += 1;
    } else if (facing < 0) {
      negative += 1;
    }
  }
  if (counted === 0) {
    return { isShell: false, reason: 'degenerate' };
  }
  if (Math.max(positive, negative) / counted < SHELL_FACING_SHARE) {
    return { isShell: false, reason: 'mixed-facing' };
  }
  return { isShell: true, reason: 'closed-around-centre', centre };
}

// Look direction for a camera that stands at the origin. `yaw` turns left or right and
// `pitch` tilts up (positive) or down; both are radians.
export function lookFromDirection(direction) {
  const [x, y, z] = direction;
  const total = Math.hypot(x, y, z);
  if (!(total > 1e-12)) {
    return { yaw: 0, pitch: 0 };
  }
  return {
    yaw: Math.atan2(x, z),
    pitch: clampPitch(Math.asin(clamp(-y / total, -1, 1))),
  };
}

// Unit vector the camera looks along for a look angle (matches a YXZ Euler rotation).
export function lookForward({ yaw, pitch }) {
  const horizontal = Math.cos(pitch);
  return [-Math.sin(yaw) * horizontal, Math.sin(pitch), -Math.cos(yaw) * horizontal];
}

export function clampPitch(pitch) {
  return clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

// Dragging moves the scene with the pointer: right turns the view left, down looks up.
export function dragLook(look, deltaX, deltaY) {
  return {
    yaw: look.yaw + deltaX * DRAG_RADIANS_PER_PIXEL,
    pitch: clampPitch(look.pitch + deltaY * DRAG_RADIANS_PER_PIXEL),
  };
}

// Keyboard turns in fixed steps, with the same sign convention as a drag.
export function turnLook(look, yawRadians, pitchRadians) {
  return { yaw: look.yaw + yawRadians, pitch: clampPitch(look.pitch + pitchRadians) };
}

// Zoom inside a panorama is a field-of-view change: a factor below one narrows the lens.
export function zoomFieldOfView(fovDegrees, factor) {
  return clamp(fovDegrees * factor, PANORAMA_FOV_RANGE[0], PANORAMA_FOV_RANGE[1]);
}

export function wheelFieldOfView(fovDegrees, deltaY) {
  if (!Number.isFinite(deltaY)) {
    return fovDegrees;
  }
  return clamp(
    fovDegrees + deltaY * WHEEL_DEGREES_PER_UNIT,
    PANORAMA_FOV_RANGE[0],
    PANORAMA_FOV_RANGE[1],
  );
}

// The note shown over the stage. A shape-based detection says so, because it is a guess
// from geometry rather than a stored fact.
export function describePanoramaView({ inside, source }) {
  const note = inside
    ? 'Panorama mesh, viewed from inside. Drag to look around; scroll or plus and minus change the field of view.'
    : 'Panorama mesh, viewed from outside. Use View from inside to stand in the scene.';
  return source === 'geometry' ? `${note} Detected from the mesh shape.` : note;
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

function length(value) {
  return Math.hypot(value[0], value[1], value[2]);
}
