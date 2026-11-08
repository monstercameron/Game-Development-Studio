import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeFields } from '../runtime/log-fields.js';

test('an extension field keeps its value with or without the leading dot', () => {
  assert.deepEqual(sanitizeFields({ extension: '.glb' }), {
    fields: { extension: 'glb' },
    dropped: [],
  });
  assert.deepEqual(sanitizeFields({ extension: 'glb' }), {
    fields: { extension: 'glb' },
    dropped: [],
  });
  assert.deepEqual(sanitizeFields({ extension: '.tar.gz' }).fields, { extension: 'tar.gz' });
});

test('only one leading dot is removed and other fields are not normalized', () => {
  assert.deepEqual(sanitizeFields({ extension: '..x' }), { fields: {}, dropped: ['extension'] });
  assert.deepEqual(sanitizeFields({ extension: '' }), { fields: {}, dropped: ['extension'] });
  assert.deepEqual(sanitizeFields({ format: '.glb' }), { fields: {}, dropped: ['format'] });
});
