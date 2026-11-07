import test from 'node:test';
import assert from 'node:assert/strict';
import { panelLocation, updateSearch } from '../src/useNav.js';

test('panel navigation preserves project context and drops unrelated filters', () => {
  const current = new URLSearchParams('project=abc&type=Images&asset=images%2Fone.png');
  assert.deepEqual(panelLocation('music', current), { pathname: '/music', search: '?project=abc' });
  assert.deepEqual(panelLocation('overview', current, { project: null }), {
    pathname: '/',
    search: '',
  });
  assert.deepEqual(panelLocation('3d', current, { model: 'TRELLIS.2' }), {
    pathname: '/3d',
    search: '?project=abc&model=TRELLIS.2',
  });
});
test('URL parameter changes retain unrelated state and remove cleared values', () => {
  let value = new URLSearchParams('project=abc&type=Images&asset=old');
  let options;
  const set = (fn, opts) => {
    value = fn(value);
    options = opts;
  };
  updateSearch(set, { q: 'magic item', asset: null }, { replace: true });
  assert.equal(value.get('project'), 'abc');
  assert.equal(value.get('q'), 'magic item');
  assert.equal(value.has('asset'), false);
  assert.equal(options.replace, true);
  updateSearch(set, { q: null, type: null });
  assert.equal(value.toString(), 'project=abc');
  assert.equal(options.replace, false);
});
