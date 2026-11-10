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

async function mountQueue(
  t,
  { expanded = false, jobs = queueJobs, projects = [], routes = {} } = {},
) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/queue',
  });
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    actEnvironment: Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };
  const requests = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), method: options.method || 'GET', body: options.body });
      if (String(url) === '/api/runtime/jobs') {
        return { ok: true, json: async () => ({ jobs }) };
      }
      if (routes[String(url)]) {
        return { ok: true, json: async () => routes[String(url)] };
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
      sessionStorage: previous.sessionStorage,
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
          React.createElement(RuntimeQueue, { expanded, projects }),
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

// Queue decisions: filters, scoped clear, interrupted resolve and Stop this render.

const recent = new Date().toISOString();
const sized = {
  request: { prompt: 'a red banner', width: 1024, height: 768, num_inference_steps: 30 },
};

// Selects change through a DOM change event. Text inputs in jsdom do not reach React's onChange
// from a DOM event, so they are driven through the handler React attached to the node.
async function setValue(dom, element, value) {
  if (element.tagName === 'SELECT') {
    await act(async () => {
      element.value = value;
      element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    return;
  }
  const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps'));
  await act(async () => {
    element[propsKey].onChange({ target: { value } });
  });
}

// Requests the page made to change something. The queue also posts timing estimates, which change nothing.
function actionRequests(requests) {
  return requests.filter(
    (request) => request.method !== 'GET' && !request.url.endsWith('/estimate'),
  );
}

// Lets the page finish the reads and writes its handlers started.
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function chip(container, label) {
  return [...container.querySelectorAll('.queue-filter-chip')].find((button) =>
    button.textContent.startsWith(label),
  );
}

const castleAndHarbour = [
  { id: 'castle-1', name: 'Castle keep' },
  { id: 'harbour-1', name: 'Harbour town' },
];

test('each row gives a short id, project, age and size, and a long prompt expands', async (t) => {
  const longPrompt = 'a long prompt about the castle walls '.repeat(6);
  const { container, click } = await mountQueue(t, {
    projects: castleAndHarbour,
    jobs: [
      job('wait-1', 'queued', { projectId: 'castle-1', createdAt: recent, ...sized }),
      job('run-1', 'running', {
        projectId: 'harbour-1',
        createdAt: recent,
        request: { prompt: longPrompt },
      }),
    ],
  });

  const meta = container.querySelector('[data-job-id="wait-1"] .runtime-job-meta').textContent;
  assert.match(meta, /wait-1/);
  assert.match(meta, /Castle keep/);
  assert.match(meta, /just now/);
  assert.match(meta, /1024×768 · 30 steps/);

  const row = container.querySelector('[data-job-id="run-1"]');
  const toggle = row.querySelector('.runtime-job-prompt-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(row.querySelector('.runtime-job-prompt').textContent.endsWith('…'));
  await click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(row.querySelector('.runtime-job-prompt').textContent, longPrompt);
  assert.ok(!row.querySelector('.runtime-job-prompt').textContent.endsWith('…'));
});

test('cancel buttons name the short id and the project, not the prompt', async (t) => {
  const { container } = await mountQueue(t, {
    projects: castleAndHarbour,
    jobs: [job('wait-1', 'queued', { projectId: 'castle-1', ...sized })],
  });
  const cancel = container.querySelector(
    'button[aria-label="Cancel render wait-1 in Castle keep"]',
  );
  assert.ok(cancel, 'the cancel button is labelled with the id and project');
  assert.equal(cancel.textContent.trim(), 'Cancel');
});

test('filters narrow the list, count each status, and are remembered for the session', async (t) => {
  const { container, dom } = await mountQueue(t, {
    projects: castleAndHarbour,
    jobs: [
      job('wait-1', 'queued', { projectId: 'castle-1' }),
      job('run-1', 'running', { projectId: 'harbour-1' }),
      job('fail-1', 'failed', { projectId: 'castle-1' }),
    ],
  });
  const rowIds = () =>
    [...container.querySelectorAll('[data-job-id]')].map((row) => row.dataset.jobId);
  assert.deepEqual(rowIds().sort(), ['fail-1', 'run-1', 'wait-1']);
  assert.match(chip(container, 'Running').textContent, /Running\s*1/);

  await act(async () => chip(container, 'Running').click());
  assert.deepEqual(rowIds(), ['run-1']);
  assert.equal(chip(container, 'Running').getAttribute('aria-pressed'), 'true');

  await act(async () => chip(container, 'All').click());
  await setValue(dom, container.querySelector('.queue-filter-fields select'), 'harbour-1');
  assert.deepEqual(rowIds(), ['run-1']);
  assert.match(container.querySelector('.queue-filter-summary').textContent, /Showing 1 of 3/);
  assert.deepEqual(JSON.parse(sessionStorage.getItem('forge-queue-filters-v1')), {
    status: 'all',
    projectId: 'harbour-1',
    type: 'all',
    query: '',
  });

  const search = container.querySelector('.queue-filter-search input');
  await setValue(dom, search, 'nothing matches this');
  assert.match(container.querySelector('.runtime-queue-empty').textContent, /No renders match/);
  await act(async () => [...container.querySelectorAll('.runtime-queue-empty button')][0].click());
  assert.equal(container.querySelector('.queue-filter-search input').value, '');
  assert.equal(container.querySelector('.queue-filter-fields select').value, 'all');
});

test('Clear waiting renders cancels the view by default, names each render, and reports the result', async (t) => {
  const { container, click, requests, dom } = await mountQueue(t, {
    projects: castleAndHarbour,
    jobs: [
      job('wait-1', 'queued', { projectId: 'castle-1' }),
      job('wait-2', 'waiting_memory', { projectId: 'harbour-1' }),
    ],
  });
  await setValue(dom, container.querySelector('.queue-filter-fields select'), 'harbour-1');
  const clear = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Clear waiting renders…',
  );
  await click(clear);
  await settle();

  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Clear waiting renders\?/);
  assert.equal(
    dialog.querySelector('input[value="view"]').checked,
    true,
    'the current view is the default scope',
  );
  assert.match(dialog.textContent, /wait-2/);
  assert.doesNotMatch(dialog.textContent, /wait-1/);
  const confirm = dialog.querySelector('.studio-confirm-danger');
  assert.equal(confirm.textContent, 'Cancel 1 waiting render');
  assert.equal(confirm.disabled, true, 'clearing requires typed confirmation');
  await setValue(dom, dialog.querySelector('.queue-clear-confirmation input'), 'CLEAR');
  assert.equal(confirm.disabled, false);
  await click(dialog.querySelector('input[value="all"]'));
  assert.equal(confirm.disabled, true, 'changing scope requires a fresh confirmation');
  await click(dialog.querySelector('input[value="view"]'));
  await setValue(dom, dialog.querySelector('.queue-clear-confirmation input'), 'CLEAR');

  await click(confirm);
  await settle();
  assert.deepEqual(
    actionRequests(requests).map((request) => request.url),
    ['/api/runtime/jobs/wait-2/cancel'],
    'only the render in the view is cancelled, one request each',
  );
  assert.ok(!container.querySelector('[role="dialog"]'), 'the dialog closes when it succeeds');
  assert.match(
    container.querySelector('.queue-manage-note[role="status"]').textContent,
    /1 waiting render cancelled/,
  );
});

test('Mark cancelled after checking uses the studio dialog with the engine facts, never window.confirm', async (t) => {
  const { container, click, requests, dom } = await mountQueue(t, {
    jobs: [job('int-1', 'interrupted', { type: 'images', remoteId: 'remote-7' })],
    routes: {
      '/api/runtime/services': {
        services: [
          { id: 'images', status: 'reachable', busy: false, modelLoaded: true, managed: true },
        ],
      },
      '/api/runtime/hardware': {
        devices: [{ name: 'GPU', usedMiB: 2048, totalMiB: 8192 }],
      },
    },
  });
  let nativeConfirmCalls = 0;
  dom.window.confirm = () => {
    nativeConfirmCalls += 1;
    return false;
  };
  await click(
    container.querySelector('button[aria-label^="Mark cancelled after checking: render int-1"]'),
  );
  await settle();

  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Mark this render cancelled\?/);
  const facts = [...dialog.querySelectorAll('.studio-confirm-facts dd')].map(
    (item) => item.textContent,
  );
  assert.deepEqual(facts, ['Reachable', 'No', 'Yes', 'Yes', '2.0 of 8.0 GiB in use']);
  assert.ok(
    [...dialog.querySelectorAll('p')].some((paragraph) => /remote-7/.test(paragraph.textContent)),
  );
  assert.equal(
    actionRequests(requests).length,
    0,
    'nothing is sent before the dialog is confirmed',
  );

  await click(dialog.querySelector('.studio-confirm-danger'));
  await settle();
  const post = actionRequests(requests)[0];
  assert.equal(post.url, '/api/runtime/jobs/int-1/resolve');
  assert.deepEqual(JSON.parse(post.body), { confirmRemoteNotRunning: true });
  assert.equal(nativeConfirmCalls, 0);
});

test('Stop this render names the waiting renders for that engine and checks the engine first', async (t) => {
  const { container, click, requests } = await mountQueue(t, {
    projects: castleAndHarbour,
    jobs: [
      job('run-1', 'running', { type: 'images', projectId: 'castle-1' }),
      job('wait-1', 'queued', { type: 'images', projectId: 'castle-1' }),
      job('wait-2', 'queued', { type: 'video', projectId: 'harbour-1' }),
    ],
    routes: {
      '/api/runtime/services': {
        services: [
          {
            id: 'images',
            status: 'reachable',
            busy: true,
            modelLoaded: true,
            managed: true,
            canUnload: false,
          },
        ],
      },
      '/api/runtime/hardware': { devices: [] },
    },
  });
  await click(container.querySelector('.queue-stop-render'));
  await settle();
  const dialog = container.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Stop this render\?/);
  assert.match(dialog.textContent, /Stop service is unavailable until the render finishes/);
  const waitingList = dialog.querySelector('.force-stop-waiting-list').textContent;
  assert.match(waitingList, /wait-1/);
  assert.doesNotMatch(waitingList, /wait-2/);
  assert.match(dialog.textContent, /Closing this dialog keeps all of them/);
  assert.equal(
    [...dialog.querySelectorAll('.force-stop-facts dd')][1].textContent,
    'Yes',
    'the engine reports it is busy',
  );

  await click(dialog.querySelector('.force-stop-confirm'));
  await settle();
  const post = actionRequests(requests)[0];
  assert.equal(post.url, '/api/runtime/models/images/force-stop');
  assert.deepEqual(JSON.parse(post.body), { confirmation: 'force-stop-engine' });
});
