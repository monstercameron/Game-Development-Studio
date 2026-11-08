import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';
import { buildQueueGroups, jobAccessibleName } from '../src/queue-groups.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function job(id, status, extra = {}) {
  return {
    id,
    type: 'images',
    status,
    projectId: 'project-one',
    request: { prompt: `prompt for ${id}` },
    error: status === 'failed' ? `reason for ${id}` : undefined,
    ...extra,
  };
}

const failedIds = Array.from({ length: 7 }, (_, index) => `failed-${index + 1}`);
const queueJobs = [
  job('running-1', 'running'),
  job('interrupted-1', 'interrupted'),
  job('attention-1', 'needs_attention'),
  ...failedIds.map((id) => job(id, 'failed')),
  job('done-1', 'completed', { output: 'Images/forge-4be74c56-0000-4000-8000-000000000000.png' }),
  job('cancelled-1', 'cancelled'),
];

test('queue groups keep blocking renders apart from failed and finished ones', () => {
  const { groups } = buildQueueGroups(queueJobs, { expanded: false });
  const idsOf = (id) => groups.find((group) => group.id === id).items.map((item) => item.id);
  assert.deepEqual(idsOf('attention'), ['interrupted-1', 'attention-1']);
  assert.deepEqual(idsOf('failed'), failedIds);
  assert.deepEqual(idsOf('recent'), ['done-1', 'cancelled-1']);
  assert.equal(groups.find((group) => group.id === 'failed').limit, 3);
  assert.equal(buildQueueGroups(queueJobs, { expanded: true }).groups[3].limit, 5);
});

test('job names for buttons stay short and fall back to the kind of render', () => {
  assert.equal(jobAccessibleName(job('a', 'failed')), 'prompt for a');
  assert.equal(
    jobAccessibleName({ id: '12345678-aaaa', type: 'trellis', request: {} }),
    'TRELLIS.2 3D model',
  );
  assert.equal(
    jobAccessibleName({ id: '12345678-aaaa', type: 'sfx', request: {} }),
    'sfx render 12345678',
  );
  assert.ok(
    jobAccessibleName(job('b', 'failed', { request: { prompt: 'x'.repeat(200) } })).length <= 60,
  );
});

async function mountQueue(t, { expanded = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/queue',
  });
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    actEnvironment: Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  const requests = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET' });
      if (String(url) === '/api/runtime/jobs') {
        return { ok: true, json: async () => ({ jobs: queueJobs }) };
      }
      return { ok: true, json: async () => ({ available: false }) };
    },
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    // One router instance for the test and the components it renders.
    ssr: { noExternal: ['react-router'] },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  const mounted = { root: null };
  t.after(async () => {
    if (mounted.root) {
      await act(async () => mounted.root.unmount());
    }
    await vite.close();
    for (const [key, descriptor] of Object.entries({
      window: previous.window,
      document: previous.document,
      navigator: previous.navigator,
      localStorage: previous.localStorage,
      fetch: previous.fetch,
      IS_REACT_ACT_ENVIRONMENT: previous.actEnvironment,
    })) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router');
  const { default: RuntimeQueue } = await vite.ssrLoadModule('/src/RuntimeQueue.jsx');
  const { QueueTimingProvider } = await vite.ssrLoadModule('/src/QueueTiming.jsx');
  const container = document.querySelector('#root');
  mounted.root = createRoot(container);
  await act(async () => {
    mounted.root.render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(
          QueueTimingProvider,
          null,
          React.createElement(RuntimeQueue, { expanded, projects: [] }),
        ),
      ),
    );
  });
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  };
  return { container, dom, click, requests };
}

const groupRows = (container, id) => [
  ...container.querySelectorAll(`.queue-group-${id} .runtime-job`),
];

test('failed renders are grouped, counted and collapsed behind Show more', async (t) => {
  const { container, click } = await mountQueue(t);

  const attention = container.querySelector('.queue-group-attention');
  assert.match(attention.querySelector('h3').textContent, /Needs attention\s*2/);
  assert.equal(groupRows(container, 'attention').length, 2);
  assert.equal(
    attention.querySelectorAll('[data-dismiss-for]').length,
    0,
    'rows that block the queue cannot be dismissed',
  );

  const failed = container.querySelector('.queue-group-failed');
  assert.match(failed.querySelector('h3').textContent, /Failed\s*7/);
  assert.equal(groupRows(container, 'failed').length, 3);
  assert.match(failed.textContent, /reason for failed-1/);
  assert.ok(failed.querySelector('button[aria-label="Retry prompt for failed-1"]'));
  assert.ok(failed.querySelector('button[aria-label="Dismiss prompt for failed-1"]'));
  assert.match(
    container.querySelector('.queue-summary').textContent,
    /2 need attention · 7 failed/,
  );
  assert.equal(container.querySelector('.queue-summary').getAttribute('role'), 'status');

  const more = failed.querySelector('.queue-group-more');
  assert.equal(more.textContent, 'Show 4 more failed renders');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await click(more);
  assert.equal(groupRows(container, 'failed').length, 7);
  const fewer = container.querySelector('.queue-group-failed .queue-group-more');
  assert.equal(fewer.textContent, 'Show fewer failed renders');
  assert.equal(fewer.getAttribute('aria-expanded'), 'true');
  await click(fewer);
  assert.equal(groupRows(container, 'failed').length, 3);
});

test('dismissing a failed render hides it without changing the queue, and can be undone', async (t) => {
  const { container, click, requests } = await mountQueue(t);

  const dismissFirst = container.querySelector('button[aria-label="Dismiss prompt for failed-1"]');
  dismissFirst.focus();
  await click(dismissFirst);

  assert.equal(groupRows(container, 'failed').length, 3, 'the next failed render takes its place');
  assert.ok(!container.querySelector('[data-job-id="failed-1"]'));
  assert.match(container.querySelector('.queue-group-failed h3').textContent, /Failed\s*6/);
  assert.match(
    container.querySelector('.queue-dismissal').textContent,
    /Dismissed “prompt for failed-1”/,
  );
  assert.equal(
    document.activeElement?.getAttribute('data-dismiss-for'),
    'failed-2',
    'focus moves to the next row instead of falling back to the page',
  );
  assert.deepEqual(JSON.parse(localStorage.getItem('forge-hidden-queue-ids-v1')), ['failed-1']);
  assert.deepEqual(
    requests.filter((request) => request.method !== 'GET' && !request.url.endsWith('/estimate')),
    [],
    'dismissing only changes this browser view',
  );

  const undo = [...container.querySelectorAll('.queue-dismissal button')].find(
    (button) => button.textContent === 'Undo',
  );
  await click(undo);
  assert.ok(container.querySelector('[data-job-id="failed-1"]'));
  assert.deepEqual(JSON.parse(localStorage.getItem('forge-hidden-queue-ids-v1')), []);
});

test('Dismiss all hides every failed render, keeps the rest, and Show hidden restores them', async (t) => {
  const { container, click } = await mountQueue(t);

  const dismissAll = container.querySelector('button[aria-label="Dismiss all 7 failed renders"]');
  await click(dismissAll);

  assert.ok(!container.querySelector('.queue-group-failed'), 'the empty section disappears');
  assert.equal(groupRows(container, 'attention').length, 2, 'blocking renders stay visible');
  assert.equal(groupRows(container, 'processing').length, 1);
  assert.match(
    container.querySelector('.queue-dismissal').textContent,
    /Dismissed 7 failed renders/,
  );
  assert.match(container.querySelector('.queue-hidden-note').textContent, /7 renders are hidden/);

  const showHidden = container.querySelector('.queue-hidden-note button');
  await click(showHidden);
  assert.equal(container.querySelectorAll('.queue-group-failed .runtime-job').length, 3);
  assert.ok(!container.querySelector('.queue-hidden-note'));
});

test('finished and cancelled renders can be dismissed one at a time', async (t) => {
  const { container, click } = await mountQueue(t);
  const dismiss = container.querySelector('button[aria-label="Dismiss prompt for cancelled-1"]');
  assert.ok(dismiss);
  await click(dismiss);
  assert.ok(!container.querySelector('[data-job-id="cancelled-1"]'));
  assert.equal(
    document.activeElement?.getAttribute('data-dismiss-for'),
    'done-1',
    'with no row after it, focus goes to the previous row',
  );
});
