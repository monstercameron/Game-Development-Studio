import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hunyuanShapeRequest,
  hunyuanSteps,
  HUNYUAN_ESTIMATE_REFERENCE,
} from '../src/hunyuan-settings.js';

test('3D settings preserve all supported tuning for submissions and estimates', () => {
  const id = '4d4ad065-ce7e-44e6-b4fc-c1c62d6d326e.png';
  assert.deepEqual(hunyuanShapeRequest({ seed: '42', shapeSteps: '45', resolution: 256 }, [id]), {
    model: 'hunyuan',
    references: [id],
    seed: 42,
    steps: 45,
    resolution: 256,
  });
  assert.deepEqual(hunyuanShapeRequest({ seed: '' }), {
    model: 'hunyuan',
    references: [HUNYUAN_ESTIMATE_REFERENCE],
    seed: 123,
    steps: 30,
    resolution: 128,
  });
  assert.equal(hunyuanSteps(1), 1);
  assert.equal(hunyuanSteps('100'), 100);
});

test('3D settings reject malformed controls before uploading references', () => {
  for (const shapeSteps of ['', 0, 101, 1.5, NaN, true, null]) {
    assert.throws(() => hunyuanShapeRequest({ shapeSteps }), /Steps/);
  }
  for (const seed of [-1, 2147483648, 'abc', true]) {
    assert.throws(() => hunyuanShapeRequest({ seed }), /Seed/);
  }
  for (const resolution of [0, 129, 512, '', true]) {
    assert.throws(() => hunyuanShapeRequest({ resolution }), /resolution/i);
  }
  for (const refs of [[], ['../image.png'], ['a.png', 'b.png']]) {
    assert.throws(() => hunyuanShapeRequest({}, refs), /reference/);
  }
});
