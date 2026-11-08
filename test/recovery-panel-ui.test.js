import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const JOB_UNKNOWN = '11111111-1111-4111-8111-111111111111';
const JOB_PREPARED = '22222222-2222-4222-8222-222222222222';

function report(overrides = {}) {
  return {
    version: 1,
    unclean: true,
    needsAttention: true,
    dismissed: false,
    fingerprint: 'f',
    previous: { state: 'unclean', lastAliveAt: '2026-01-02T12:00:00.000Z' },
    recoveryNeeded: null,
    jobs: {
      available: true,
      items: [
        {
          id: JOB_UNKNOWN,
          type: 'images',
          status: 'interrupted',
          kind: 'unknown_outcome',
          safeToRetry: false,
          hasRemoteId: false,
          stage: 'Submitting',
          error: 'Submission may have reached the engine.',
          project: 'Alpha',
          savedOutput: 'valid',
          savedOutputPath: 'images/forge-x.png',
        },
        {
          id: JOB_PREPARED,
          type: '3d',
          status: 'needs_attention',
          kind: 'needs_attention',
          safeToRetry: true,
          hasRemoteId: false,
          stage: 'Engine missing.',
          error: '',
          project: 'Alpha',
          savedOutput: 'missing',
        },
      ],
    },
    orphans: {
      items: [
        {
          id: '0123456789abcdef',
          scope: 'project',
          project: { name: 'Alpha' },
          path: 'images/.forge-x.png.conflict',
          kind: 'output_conflict',
          bytes: 2048,
          ageHours: 30,
        },
      ],
      deleted: 0,
      deletedBytes: 0,
      projectProblems: [],
      stagedImports: 0,
    },
    databases: [{ name: 'settings', state: 'started_fresh', backups: 0 }],
    engines: [{ id: 'images', name: 'Qwen', status: 'unavailable', reason: 'timeout' }],
    events: [],
    ...overrides,
  };
}

async function setup(t, initialReport, { postError = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const calls = [];
  let current = initialReport;
  globalThis.fetch = async (url, init = {}) => {
    // Browser log batches are not part of the recovery exchange this test checks.
    if (url !== '/api/logs/ingest') {
      calls.push({ url, method: init.method || 'GET', headers: init.headers, body: init.body });
    }
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST') {
      return postError ? json(409, { error: postError }) : json(200, {});
    }
    return json(200, current);
  };
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/.forge-runtime/**'] } },
  });
  const { default: RecoveryPanel } = await vite.ssrLoadModule('/src/RecoveryPanel.jsx');
  const root = createRoot(document.querySelector('#root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.getComputedStyle = previous.getComputedStyle;
    if (previous.navigator) {
      Object.defineProperty(globalThis, 'navigator', previous.navigator);
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    dom.window.close();
  });
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  await act(async () => root.render(React.createElement(RecoveryPanel)));
  await flush();
  return {
    calls,
    flush,
    setReport: (next) => {
      current = next;
    },
    click: async (element) => {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      await flush();
    },
    button: (name) =>
      [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === name),
    posts: () => calls.filter((call) => call.method === 'POST'),
  };
}

test('nothing is shown when the report needs no attention', async (t) => {
  const view = await setup(t, report({ needsAttention: false }));
  assert.equal(document.querySelector('.recovery-panel'), null);
  assert.equal(view.calls[0].url, '/api/recovery');
});

test('interrupted renders say the outcome is unknown and offer no retry', async (t) => {
  await setup(t, report());
  const region = document.querySelector('section.recovery-panel');
  assert.equal(region.getAttribute('aria-labelledby'), 'recovery-title');
  assert.equal(document.querySelector('#recovery-title').textContent, 'Recovery needed');
  const items = [...document.querySelectorAll('.recovery-job')];
  assert.equal(items.length, 2);
  const [unknown, prepared] = items;
  assert.match(unknown.textContent, /Whether the engine accepted it is unknown/);
  assert.match(unknown.textContent, /stays there whatever you decide/);
  assert.match(unknown.textContent, /cannot be queued again/);
  assert.ok(
    ![...unknown.querySelectorAll('button')].some((b) => /Queue again/.test(b.textContent)),
  );
  assert.match(prepared.textContent, /before anything was submitted/);
  assert.ok([...prepared.querySelectorAll('button')].some((b) => b.textContent === 'Queue again'));
  assert.equal(prepared.querySelector('input[type="checkbox"]'), null);
  const text = region.textContent;
  assert.match(text, /not running|may be hung/);
  assert.match(text, /started empty/);
  assert.ok(!/delet/i.test(text), 'no wording that suggests erasing files');
});

test('marking an interrupted job cancelled needs the checkbox and sends the exact request', async (t) => {
  const view = await setup(t, report());
  const unknown = document.querySelectorAll('.recovery-job')[0];
  const resolve = [...unknown.querySelectorAll('button')].find(
    (b) => b.textContent === 'Mark as cancelled',
  );
  assert.equal(resolve.disabled, true);
  await view.click(resolve);
  assert.equal(view.posts().length, 0, 'a disabled button sends nothing');
  const checkbox = unknown.querySelector('input[type="checkbox"]');
  assert.ok(
    unknown.querySelector(`label[for="${checkbox.id}"]`),
    'the checkbox has a visible label',
  );
  await view.click(checkbox);
  assert.equal(resolve.disabled, false);
  await view.click(resolve);
  const [post] = view.posts();
  assert.equal(post.url, '/api/recovery');
  assert.equal(post.headers['X-Forge-Request'], 'recovery');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), {
    action: 'resolve-job',
    jobId: JOB_UNKNOWN,
    confirm: 'engine-job-not-running',
  });
  assert.match(document.querySelector('.recovery-feedback').textContent, /marked as cancelled/);
});

test('only a provably safe job can be queued again', async (t) => {
  const view = await setup(t, report());
  const retry = view.button('Queue again');
  assert.equal(document.querySelectorAll('.recovery-job button').length > 0, true);
  assert.equal(
    [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Queue again').length,
    1,
  );
  await view.click(retry);
  assert.deepEqual(JSON.parse(view.posts()[0].body), { action: 'retry-job', jobId: JOB_PREPARED });
});

test('orphaned files are moved to quarantine with a confirmation, never deleted', async (t) => {
  const view = await setup(t, report());
  assert.match(document.querySelector('.recovery-panel').textContent, /2\.0 KiB, 30 h old/);
  await view.click(view.button('Move to quarantine'));
  assert.deepEqual(JSON.parse(view.posts()[0].body), {
    action: 'quarantine-orphans',
    ids: ['0123456789abcdef'],
    confirm: 'quarantine-orphans',
  });
});

test('dismissing sends the action and the panel goes away once the report is quiet', async (t) => {
  const view = await setup(t, report());
  view.setReport(report({ needsAttention: false, dismissed: true }));
  await view.click(view.button('Dismiss'));
  assert.deepEqual(JSON.parse(view.posts()[0].body), { action: 'dismiss' });
  assert.equal(document.querySelector('.recovery-panel'), null);
});

test('an API error is shown in an alert and nothing is hidden', async (t) => {
  const view = await setup(t, report(), {
    postError: 'Retrying this job could repeat work the engine already accepted.',
  });
  await view.click(view.button('Queue again'));
  const alert = document.querySelector('.recovery-error[role="alert"]');
  assert.match(alert.textContent, /could repeat work/);
  assert.ok([...alert.querySelectorAll('button')].some((b) => /Copy error/.test(b.textContent)));
  assert.ok(document.querySelector('.recovery-panel'), 'the panel stays');
});

test('a crash loop stop is announced as an alert', async (t) => {
  await setup(
    t,
    report({
      unclean: false,
      recoveryNeeded: { component: 'host', count: 5, windowMs: 600000 },
      jobs: { available: true, items: [] },
      orphans: { items: [], projectProblems: [] },
      databases: [],
      engines: null,
    }),
  );
  const alert = document.querySelector('.recovery-alert[role="alert"]');
  assert.match(alert.textContent, /host crashed 5 times in 10 minutes/);
});
