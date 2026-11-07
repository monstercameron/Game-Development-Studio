import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function overlaps(first, second) {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

async function loadPlacementHelper() {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.field-help-'));
  try {
    const source = await readFile(path.join(repositoryRoot, 'src/tooltips/FieldHelp.jsx'), 'utf8');
    const start = source.indexOf('const HELP_TRIGGER_SIZE');
    const end = source.indexOf('function occupiedRects', start);
    assert.ok(start >= 0 && end > start, 'placement helper remains isolated for unit testing');
    const transformed = await transformWithEsbuild(source.slice(start, end), 'FieldHelp.js');
    const modulePath = path.join(temporaryDirectory, 'placement.mjs');
    await writeFile(modulePath, transformed.code, 'utf8');
    return {
      module: await import(pathToFileURL(modulePath).href),
      temporaryDirectory,
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

test('field help placement avoids nearby text and reserves the trigger rectangle', async () => {
  const { module: placement, temporaryDirectory } = await loadPlacementHelper();
  try {
    const anchor = { left: 100, top: 100, right: 200, bottom: 120, width: 100, height: 20 };
    const labelText = { left: 205, top: 96, right: 244, bottom: 124 };
    const result = placement.placeHelpTrigger(anchor, { width: 500, height: 300 }, [labelText]);

    const trigger = { ...result, right: result.left + 24, bottom: result.top + 24 };
    assert.ok(!overlaps(trigger, labelText));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('field help placement keeps a trigger off artwork and within a dialog at narrow zoom', async () => {
  const { module: placement, temporaryDirectory } = await loadPlacementHelper();
  try {
    const bounds = { left: 42, top: 34, width: 300, height: 220 };
    const artwork = { left: 75, top: 58, right: 300, bottom: 232, isArtwork: true };
    const anchor = { left: 260, top: 205, right: 288, bottom: 219, width: 28, height: 14 };
    const result = placement.placeHelpTrigger(anchor, bounds, [artwork]);
    const trigger = {
      ...result,
      right: result.left + 24,
      bottom: result.top + 24,
    };

    assert.ok(trigger.left >= bounds.left && trigger.right <= bounds.left + bounds.width);
    assert.ok(trigger.top >= bounds.top && trigger.bottom <= bounds.top + bounds.height);
    assert.ok(
      trigger.right <= artwork.left ||
        trigger.left >= artwork.right ||
        trigger.bottom <= artwork.top ||
        trigger.top >= artwork.bottom,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('field help can move to the viewport gutter when a dialog is full-bleed artwork', async () => {
  const { module: placement, temporaryDirectory } = await loadPlacementHelper();
  try {
    const dialogBounds = { left: 80, top: 60, width: 320, height: 240 };
    const artwork = { left: 80, top: 60, right: 400, bottom: 300, isArtwork: true };
    const anchor = { left: 180, top: 150, right: 220, bottom: 170, width: 40, height: 20 };
    const inDialog = placement.placeHelpTrigger(anchor, dialogBounds, [artwork]);
    const viewport = placement.placeHelpTrigger(anchor, { width: 640, height: 480 }, [artwork]);
    const trigger = {
      ...viewport,
      right: viewport.left + 24,
      bottom: viewport.top + 24,
    };

    assert.ok(
      overlaps({ ...inDialog, right: inDialog.left + 24, bottom: inDialog.top + 24 }, artwork),
    );
    assert.ok(!overlaps(trigger, artwork));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('field help placement searches the nearest clear location when a label is boxed in', async () => {
  const { module: placement, temporaryDirectory } = await loadPlacementHelper();
  try {
    const anchor = { left: 180, top: 90, right: 220, bottom: 110, width: 40, height: 20 };
    const obstacles = [
      { left: 220, top: 80, right: 260, bottom: 120 },
      { left: 150, top: 80, right: 176, bottom: 120 },
      { left: 170, top: 60, right: 230, bottom: 84 },
      { left: 170, top: 116, right: 230, bottom: 140 },
    ];
    const result = placement.placeHelpTrigger(anchor, { width: 400, height: 240 }, obstacles);
    const trigger = { ...result, right: result.left + 24, bottom: result.top + 24 };

    assert.ok(obstacles.every((obstacle) => !overlaps(trigger, obstacle)));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
