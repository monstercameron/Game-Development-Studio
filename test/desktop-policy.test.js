import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedPermission, isExternalWebUrl, isStudioUrl } from '../desktop/policy.js';

test('desktop renderer stays on the verified local Studio and only opens web links externally', () => {
  const origin = 'http://127.0.0.1:5173';
  assert.equal(isStudioUrl(`${origin}/images?project=1`, origin), true);
  for (const url of [
    'http://localhost:5173/',
    'http://127.0.0.1:5174/',
    'http://127.0.0.1.evil.test:5173/',
    'file:///secret',
    'javascript:alert(1)',
  ]) {
    assert.equal(isStudioUrl(url, origin), false);
  }
  assert.equal(isExternalWebUrl('https://example.com/docs'), true);
  assert.equal(isExternalWebUrl('file:///secret'), false);
  assert.equal(isExternalWebUrl('https://user:secret@example.com/'), false);
});

test('desktop permissions require the trusted origin and a narrow feature allowlist', () => {
  const origin = 'http://127.0.0.1:5173';
  assert.equal(isAllowedPermission('media', origin, origin), true);
  assert.equal(isAllowedPermission('notifications', origin, origin), true);
  assert.equal(isAllowedPermission('geolocation', origin, origin), false);
  assert.equal(isAllowedPermission('media', 'https://example.com', origin), false);
});
