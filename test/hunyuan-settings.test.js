import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hunyuanGuidance,
  hunyuanShapeRequest,
  hunyuanSteps,
  hunyuanTriangles,
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

test('3D shape tuning is sent only when it differs from the defaults', () => {
  const id = '4d4ad065-ce7e-44e6-b4fc-c1c62d6d326e.png';
  const plain = hunyuanShapeRequest({ shapeGuidance: '5', shapeTriangles: '' }, [id]);
  assert.equal('guidance' in plain, false);
  assert.equal('target_faces' in plain, false);
  const tuned = hunyuanShapeRequest({ shapeGuidance: '7.5', shapeTriangles: '20000' }, [id]);
  assert.equal(tuned.guidance, 7.5);
  assert.equal(tuned.target_faces, 20000);
  assert.equal(hunyuanGuidance(undefined), 5);
  assert.equal(hunyuanTriangles(''), null);
  for (const shapeGuidance of [0.5, 21, '', 'x', null, NaN]) {
    assert.throws(() => hunyuanShapeRequest({ shapeGuidance }, [id]), /Guidance/);
  }
  for (const shapeTriangles of [999, 1000001, 2500.5, 'many', true]) {
    assert.throws(() => hunyuanShapeRequest({ shapeTriangles }, [id]), /Triangle target/);
  }
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

test('3D texture settings are added only when painting is on', () => {
  const id = '4d4ad065-ce7e-44e6-b4fc-c1c62d6d326e.png';
  assert.equal(
    'texture' in hunyuanShapeRequest({ texture: false, textureSize: 1024 }, [id]),
    false,
  );
  assert.deepEqual(hunyuanShapeRequest({ seed: 5, texture: true }, [id]), {
    model: 'hunyuan',
    references: [id],
    seed: 5,
    steps: 30,
    resolution: 128,
    texture: true,
    texture_size: 2048,
  });
  assert.equal(
    hunyuanShapeRequest({ texture: true, textureSize: '1024' }, [id]).texture_size,
    1024,
  );
  for (const textureSize of [0, 512, 4096, 'big']) {
    assert.throws(() => hunyuanShapeRequest({ texture: true, textureSize }, [id]), /texture/i);
  }
  for (const texture of ['yes', 1, null]) {
    assert.throws(() => hunyuanShapeRequest({ texture }, [id]), /Texture/);
  }
});
