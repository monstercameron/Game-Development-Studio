import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandPlaceholders,
  fingerprintSource,
  normalizeForFingerprint,
  redactText,
  topFrames,
  truncateMiddle,
} from '../runtime/error-redaction.js';

const ROOTS = {
  repo: String.raw`C:\Users\alice\Desktop\Game Development Studio`,
  projects: String.raw`C:\Users\alice\Desktop\Game Development Studio\projects`,
  runtime: String.raw`C:\Users\alice\Desktop\Game Development Studio\.forge-runtime`,
  home: String.raw`C:\Users\alice`,
  user: 'alice',
};

test('local paths become placeholders and keep file:line', () => {
  const text = [
    String.raw`File "C:\Users\alice\Desktop\Game Development Studio\runtime\sam31_worker.py", line 118, in render_worker`,
    'at run (file:///C:/Users/alice/Desktop/Game%20Development%20Studio/runtime/jobs.js:12:5)',
    String.raw`path "C:\\Users\\alice\\Desktop\\Game Development Studio\\projects\\My Game\\a.png"`,
    String.raw`C:\Users\alice\Desktop\Game Development Studio\.forge-runtime\jobs.sqlite`,
    String.raw`c:\users\ALICE\Downloads\x.zip`,
  ].join('\n');
  const redacted = redactText(text, ROOTS);
  assert.match(redacted, /File "<repo>\\runtime\\sam31_worker\.py", line 118/);
  assert.match(redacted, /at run \(<repo>\/runtime\/jobs\.js:12:5\)/);
  assert.match(redacted, /<projects>\\\\My Game\\\\a\.png/);
  assert.match(redacted, /<runtime>\\jobs\.sqlite/);
  assert.match(redacted, /<home>\\Downloads\\x\.zip/);
  assert.doesNotMatch(redacted, /alice/i);
});

test('other absolute paths, user folders and loopback origins are shortened', () => {
  const redacted = redactText(
    [
      String.raw`File "C:\Program Files\Python312\Lib\site-packages\torch\nn\module.py", line 3`,
      String.raw`D:\Data\private stuff\file.txt was missing`,
      String.raw`C:\Users\bob\notes.txt`,
      '/home/carol/app.py and /Users/dave/x.js',
      'http://127.0.0.1:5173/src/main.jsx?t=1:4:5',
      'alice did it; malice is fine',
    ].join('\n'),
    ROOTS,
  );
  assert.match(redacted, /<site-packages>\\torch\\nn\\module\.py/);
  assert.match(redacted, /<path>\\private stuff\\file\.txt was missing/);
  assert.match(redacted, /<home>\\notes\.txt/);
  assert.match(redacted, /<home>\/app\.py and <home>\/x\.js/);
  assert.match(redacted, /<studio>\/src\/main\.jsx/);
  assert.match(redacted, /<user> did it; malice is fine/);
  assert.doesNotMatch(redacted, /bob|carol|dave|Data/);
});

test('keys, tokens, query secrets and emails are removed', () => {
  const secrets = [
    'sk-proj-abcdefghijklmnopqrstuvwx',
    'hf_abcdefghijklmnopqrstu',
    'ghp_abcdefghijklmnopqrstuvwxyz01',
    'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
  ];
  const text = [
    `key ${secrets[0]} and ${secrets[1]} and ${secrets[2]} jwt ${secrets[3]}`,
    'Authorization: Bearer abcdefghijklmnop',
    'GET /x?token=abc123&q=cats&api_key=zzz',
    'mail alice@example.com',
    'password=hunter2 "apiKey": "value123"',
    'contextTokens: 4096 max_tokens=10',
  ].join('\n');
  const redacted = redactText(text, {});
  for (const secret of [...secrets, 'abcdefghijklmnop', 'abc123', 'zzz', 'hunter2', 'value123']) {
    assert.ok(!redacted.includes(secret), secret);
  }
  assert.match(redacted, /q=cats/);
  assert.match(redacted, /<email>/);
  assert.match(redacted, /contextTokens: 4096 max_tokens=10/);
  // keepPaths still removes secrets.
  assert.ok(!redactText(text, ROOTS, { keepPaths: true }).includes(secrets[0]));
});

test('placeholders expand only for the opt-in local paths view', () => {
  const redacted = redactText(
    String.raw`C:\Users\alice\Desktop\Game Development Studio\src\a.js:3`,
    ROOTS,
  );
  assert.equal(redacted, String.raw`<repo>\src\a.js:3`);
  assert.equal(expandPlaceholders(redacted, ROOTS), String.raw`${ROOTS.repo}\src\a.js:3`);
});

test('huge values keep head and tail within the limit', () => {
  const value = `HEAD${'x'.repeat(100000)}TAIL`;
  const result = truncateMiddle(value, 2000);
  assert.ok(result.length <= 2000);
  assert.ok(result.startsWith('HEAD'));
  assert.ok(result.endsWith('TAIL'));
  assert.match(result, /characters truncated/);
});

test('fingerprints ignore ids, numbers, hashes and line numbers', () => {
  assert.equal(
    normalizeForFingerprint(
      'Job 1a2b3c4d-1111-2222-3333-444455556666 failed after 42.5s at 0xdeadbeef',
    ),
    'Job <id> failed after <n>s at <hex>',
  );
  const one = fingerprintSource({
    source: 'browser',
    message: 'TypeError: x is undefined (id 12)',
    stack:
      'TypeError\n    at render (<studio>/assets/index-AbC123xy.js:10:5)\n    at go (<studio>/assets/index-AbC123xy.js:1:1)',
  });
  const two = fingerprintSource({
    source: 'browser',
    message: 'TypeError: x is undefined (id 99)',
    stack:
      'TypeError\n    at render (<studio>/assets/index-ZZZ999qq.js:77:2)\n    at go (<studio>/assets/index-ZZZ999qq.js:5:9)',
  });
  assert.equal(one, two);
  assert.notEqual(
    one,
    fingerprintSource({ source: 'server', message: 'TypeError: x is undefined (id 1)' }),
  );
  const python = topFrames(
    'Traceback (most recent call last):\n  File "<repo>/a.py", line 1, in outer\n  File "<repo>/b.py", line 9, in inner\nValueError: x',
  );
  assert.deepEqual(python, ['<repo>/a.py:outer', '<repo>/b.py:inner']);
});
