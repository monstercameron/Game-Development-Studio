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
  let params = new URLSearchParams('project=abc&type=Images&asset=old');
  let options;
  const set = (fn, opts) => {
    params = fn(params);
    options = opts;
  };
  updateSearch(set, { q: 'magic item', asset: null }, { replace: true });
  assert.equal(params.get('project'), 'abc');
  assert.equal(params.get('q'), 'magic item');
  assert.equal(params.has('asset'), false);
  assert.equal(options.replace, true);
  updateSearch(set, { q: null, type: null });
  assert.equal(params.toString(), 'project=abc');
  assert.equal(options.replace, false);
});
