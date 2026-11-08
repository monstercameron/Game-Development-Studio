import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ISSUE_LIMITS, buildIssueContent } from '../runtime/error-format.js';
import { createGitHubClient, parseGitHubRemote } from '../runtime/error-issues.js';
import { errorsService } from '../runtime/errors-service.js';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const ENVIRONMENT = {
  appVersion: '9.9.9',
  platform: 'win32',
  arch: 'arm64',
  nodeVersion: 'v24.0.0',
};

test('only github.com remotes are accepted and embedded credentials are dropped', () => {
  assert.deepEqual(
    parseGitHubRemote('https://github.com/monstercameron/Game-Development-Studio.git'),
    {
      owner: 'monstercameron',
      name: 'Game-Development-Studio',
      slug: 'monstercameron/Game-Development-Studio',
    },
  );
  assert.equal(parseGitHubRemote('git@github.com:owner/repo.git').slug, 'owner/repo');
  assert.equal(parseGitHubRemote('ssh://git@github.com/owner/repo').slug, 'owner/repo');
  assert.equal(
    parseGitHubRemote('https://user:token@github.com/owner/repo.git').slug,
    'owner/repo',
  );
  for (const remote of [
    'https://gitlab.com/owner/repo.git',
    'https://github.com.evil.example/owner/repo',
    'http://github.com/owner/repo',
    'git@example.com:owner/repo.git',
    '',
    'https://github.com/owner',
  ]) {
    assert.equal(parseGitHubRemote(remote), null, remote);
  }
});

test('issue content is capped and labels AI text as AI-generated', () => {
  const error = {
    source: 'engine:segmentation',
    message: `ValueError: ${'m'.repeat(400)}`,
    stack: 's'.repeat(100000),
    count: 3,
    fingerprint: 'a'.repeat(32),
    firstSeen: '2026-11-01T00:00:00.000Z',
    lastSeen: '2026-11-08T00:00:00.000Z',
    fixSource: 'both',
    fixNote: 'n'.repeat(10000),
    suggestion: 'Use ```code``` carefully',
    suggestionModel: 'gpt-6.1-sol',
    context: { jobType: 'segmentation' },
  };
  const { title, body } = buildIssueContent(error, ENVIRONMENT);
  assert.ok(title.length <= ISSUE_LIMITS.title);
  assert.ok(title.startsWith('[engine:segmentation] ValueError'));
  assert.ok(body.length <= ISSUE_LIMITS.body + 20);
  for (const section of [
    '## Summary',
    '## Environment',
    '## Error',
    '## Root cause / fix that worked',
    '## Fingerprint',
  ]) {
    assert.ok(body.includes(section), section);
  }
  assert.match(body, /AI-generated suggestion \(gpt-6\.1-sol/);
  assert.match(body, /Engine id: segmentation/);
  assert.match(body, /````markdown\nUse ```code```/, 'the fence is longer than any backtick run');
});

// Each test gets its own temporary repo and state folder. The fake gh and git append every
// argument array (and any --body-file contents) to state/calls.jsonl so assertions can check
// what would have been sent to GitHub, without a network call or a real gh login.
async function setup(t, scenario) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-errors-gh-'));
  const state = path.join(root, 'state');
  const tempRoot = path.join(root, 'tmp');
  const runtimeDir = path.join(root, 'runtime');
  await Promise.all([state, tempRoot, runtimeDir].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(state, 'scenario.json'), JSON.stringify(scenario));
  const github = createGitHubClient({
    repoRoot: root,
    gh: scenario.ghMissing
      ? [path.join(root, 'no-such-gh.exe')]
      : [process.execPath, FAKE_GH, state, 'gh'],
    git: [process.execPath, FAKE_GH, state, 'git'],
    tempRoot,
  });
  const app = express();
  const server = http.createServer(app);
  const service = errorsService({
    runtimeDir,
    repoRoot: root,
    roots: { repo: root, home: os.homedir(), user: 'forge-test-user' },
    credentials: { status: () => [], get: async () => '' },
    environment: ENVIRONMENT,
    scanIntervalMs: 0,
    github,
  });
  service.configureServer({ middlewares: app, httpServer: server, config: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (route, body) => {
    const response = await fetch(`${origin}/api/errors${route}`, {
      method: 'POST',
      headers: { Origin: origin, 'X-Forge-Request': 'errors', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const report = await call('/report', {
    kind: 'error',
    message: 'TypeError: boom for me@example.com',
    stack: `TypeError: boom\n    at run (${path.join(root, 'src', 'a.js')}:3:5)\n    key sk-proj-abcdefghijklmnopqrstuvwx`,
  });
  const id = report.data.id;
  const calls = async () =>
    // calls.jsonl is created by the first fake call, so a missing file means no calls yet.
    (await fs.readFile(path.join(state, 'calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { call, id, calls, tempRoot, root };
}

test('issues need a verified fix, show the exact redacted body, and post it via argument arrays', async (t) => {
  const { call, id, calls, tempRoot, root } = await setup(t, {
    remote: 'https://github.com/owner/forge.git',
    labels: ['bug', 'docs'],
  });
  assert.equal((await call(`/${id}/issue-preview`, {})).status, 409, 'not before the fix worked');
  await call(`/${id}/status`, {
    status: 'verified',
    fixSource: 'self',
    fixNote: 'Restarted the worker',
  });
  const preview = await call(`/${id}/issue-preview`, {});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.available, true);
  assert.equal(preview.data.repo, 'owner/forge');
  assert.equal(preview.data.notice, 'This will be posted publicly on GitHub as owner/forge.');
  assert.deepEqual(preview.data.labels, ['bug']);
  const { body, title } = preview.data;
  assert.ok(title.startsWith('[browser] TypeError: boom for <email>'));
  for (const leaked of ['me@example.com', 'sk-proj-abc', root]) {
    assert.ok(!body.includes(leaked) && !title.includes(leaked), leaked);
  }
  assert.match(body, /Restarted the worker/);
  assert.equal((await call(`/${id}/issue`, { mode: 'create', digest: 'old' })).status, 409);
  const created = await call(`/${id}/issue`, { mode: 'create', digest: preview.data.digest });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.deepEqual(created.data.issue, {
    url: 'https://github.com/owner/forge/issues/42',
    number: 42,
  });
  assert.equal(created.data.error.issueNumber, 42);
  const createCall = (await calls()).find(
    (entry) => entry.args[0] === 'issue' && entry.args[1] === 'create',
  );
  assert.deepEqual(createCall.args.slice(0, 6), [
    'issue',
    'create',
    '--repo',
    'owner/forge',
    '--title',
    title,
  ]);
  assert.deepEqual(createCall.args.slice(-2), ['--label', 'bug']);
  assert.equal(createCall.body, body, 'the posted body is the previewed body');
  const search = (await calls()).find(
    (entry) => entry.args[1] === 'list' && entry.args[0] === 'issue',
  );
  assert.deepEqual(search.args.slice(4, 8), [
    '--search',
    `${created.data.error.fingerprint} in:body`,
    '--state',
    'all',
  ]);
  assert.deepEqual(await fs.readdir(tempRoot), [], 'the private body file is deleted');
});

test('a matching issue is offered as a comment target instead of a duplicate', async (t) => {
  const { call, id, calls } = await setup(t, {
    remote: 'git@github.com:owner/forge.git',
    labels: [],
    duplicates: [
      {
        number: 7,
        title: 'Same crash',
        url: 'https://github.com/owner/forge/issues/7',
        state: 'OPEN',
      },
    ],
  });
  await call(`/${id}/status`, { status: 'verified', fixSource: 'ai' });
  const preview = await call(`/${id}/issue-preview`, {});
  assert.deepEqual(preview.data.labels, [], 'no labels when bug does not exist');
  assert.equal(preview.data.duplicates[0].number, 7);
  assert.equal(
    (await call(`/${id}/issue`, { mode: 'comment', number: 8, digest: preview.data.digest }))
      .status,
    400,
  );
  const commented = await call(`/${id}/issue`, {
    mode: 'comment',
    number: 7,
    digest: preview.data.digest,
  });
  assert.equal(commented.status, 200);
  assert.equal(commented.data.issue.number, 7);
  const comment = (await calls()).find((entry) => entry.args[1] === 'comment');
  assert.deepEqual(comment.args.slice(0, 5), ['issue', 'comment', '7', '--repo', 'owner/forge']);
  assert.equal(comment.body, preview.data.body);
  assert.ok(!(await calls()).some((entry) => entry.args[1] === 'create'));
});

test('missing gh, signed-out gh and non-GitHub remotes are reported, not attempted', async (t) => {
  const signedOut = await setup(t, {
    remote: 'https://github.com/owner/forge',
    unauthenticated: true,
  });
  await signedOut.call(`/${signedOut.id}/status`, { status: 'verified' });
  const preview = await signedOut.call(`/${signedOut.id}/issue-preview`, {});
  assert.equal(preview.data.available, false);
  assert.equal(preview.data.code, 'gh_unauthenticated');
  assert.match(preview.data.message, /Run gh auth login in a terminal/);
  assert.ok(preview.data.body.includes('## Summary'), 'the body is still shown for copying');
  assert.equal(
    (await signedOut.call(`/${signedOut.id}/issue`, { mode: 'create', digest: 'x' })).status,
    409,
  );

  const missing = await setup(t, { remote: 'https://github.com/owner/forge', ghMissing: true });
  await missing.call(`/${missing.id}/status`, { status: 'verified' });
  const missingPreview = await missing.call(`/${missing.id}/issue-preview`, {});
  assert.equal(missingPreview.data.code, 'gh_missing');
  assert.match(missingPreview.data.message, /gh auth login/);

  const gitlab = await setup(t, { remote: 'https://gitlab.com/owner/forge.git' });
  await gitlab.call(`/${gitlab.id}/status`, { status: 'verified' });
  const refused = await gitlab.call(`/${gitlab.id}/issue-preview`, {});
  assert.equal(refused.data.code, 'not_github');
  assert.ok(!(await gitlab.calls()).some((entry) => entry.tool === 'gh'), 'gh is never run');
});
