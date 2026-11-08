import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';
import { planMove } from '../runtime/queue-order.js';
import { buildQueueGroups } from '../src/queue-groups.js';
import {
  applyWaitingOrder,
  moveAnnouncement,
  queueEntries,
  rowMoveState,
  sortByOrder,
  withWaitingOrder,
} from '../src/queue-reorder.js';

// The waiting line in jsdom: buttons, disabled reasons, keyboard pick-up, pointer dragging,
// optimistic updates and rollback, against a fake runtime that applies the real planner.
// No engine, model or GPU is involved.

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const ids = ['run', 'a', 'b', 'c', 'd'];

function job(id, status, extra = {}) {
  return {
    id,
    type: 'sfx',
    status,
    projectId: 'project-one',
    request: { prompt: `prompt ${id}` },
    queueRank: ids.indexOf(id) + 1,
    ...extra,
  };
}

const baseJobs = () => [
  job('run', 'running', { remoteId: 'engine-1', startedAt: new Date().toISOString() }),
  job('a', 'queued'),
  job('b', 'queued'),
  job('c', 'queued'),
  job('d', 'queued'),
];

test('the planner view helpers keep rows in the order the runtime reports', () => {
  const jobs = baseJobs();
  assert.deepEqual(
    applyWaitingOrder(jobs, ['c', 'a', 'd', 'b'], { c: 9 }).map((item) => item.id),
    ['run', 'c', 'a', 'd', 'b'],
  );
  assert.equal(applyWaitingOrder(jobs, ['c', 'a', 'd', 'b'], { c: 9 })[1].queueRank, 9);
  // Unknown ids and rows missing from the answer are tolerated.
  assert.deepEqual(
    applyWaitingOrder(jobs, ['zzz', 'b', 'a'], null).map((item) => item.id),
    ['run', 'b', 'a', 'c', 'd'],
  );
  const entries = queueEntries(jobs);
  assert.deepEqual(
    withWaitingOrder(entries, ['d', 'c']).map((entry) => entry.id),
    ['run', 'd', 'c', 'a', 'b'],
  );
  assert.deepEqual(
    sortByOrder(jobs.slice(1), ['d', 'a']).map((item) => item.id),
    ['d', 'b', 'c', 'a'],
    'rows missing from the order keep their place',
  );
  const state = rowMoveState(entries, 'a', { previousId: null, nextId: 'b' });
  assert.equal(state.position, 1);
  assert.equal(state.next.allowed, false);
  assert.equal(state.up.reason, 'Already first in line.');
  assert.equal(state.down.allowed, true);
  assert.equal(rowMoveState(entries, 'run').position, null);
  assert.match(rowMoveState(entries, 'run').up.reason, /engine job/);
  assert.equal(
    moveAnnouncement('Image: red fox', { moved: true, position: 2, count: 5 }),
    'Moved Image: red fox to position 2 of 5.',
  );
});

test('the waiting section lists renders in the order the runtime will start them', () => {
  const jobs = [
    job('p', 'queued'),
    job('x', 'queued'),
    job('child', 'queued', {
      dependsOn: 'p',
      request: { prompt: 'c', referenceFrom: { jobId: 'p' } },
    }),
  ];
  const { groups, nested } = buildQueueGroups(jobs);
  const waiting = groups.find((group) => group.id === 'waiting');
  assert.deepEqual(
    waiting.items.map((item) => item.id),
    ['p', 'x', 'child'],
    'a chained render is not pulled up under its source',
  );
  assert.equal(nested.has('child'), false);
  const adjacent = buildQueueGroups([jobs[0], jobs[2], jobs[1]]);
  assert.equal(adjacent.nested.has('child'), true);
});

async function mountQueue(t, { jobs = baseJobs(), expanded = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/queue',
  });
  const previous = {};
  const server = {
    jobs,
    moves: [],
    hold: null,
    failure: null,
    // Applies a move the way the runtime does, with the real planner.
    apply(id, body) {
      const entries = queueEntries(this.jobs);
      let spec = { kind: 'after', value: body.after };
      if (body.to) {
        spec = { kind: 'to', value: body.to };
      } else if (body.before) {
        spec = { kind: 'before', value: body.before };
      }
      const plan = planMove(entries, id, spec);
      if (plan.moved) {
        const movable = new Set(entries.filter((entry) => entry.movable).map((entry) => entry.id));
        const order = plan.order.filter((entry) => movable.has(entry));
        this.jobs = applyWaitingOrder(this.jobs, order).map((item, index) => ({
          ...item,
          queueRank: index + 1,
        }));
      }
      const waiting = this.jobs.filter((item) => item.status === 'queued' && !item.remoteId);
      return {
        moved: plan.moved,
        position: plan.to,
        count: plan.count,
        order: waiting.map((item) => item.id),
        ranks: Object.fromEntries(waiting.map((item) => [item.id, item.queueRank])),
        clamped: plan.clamped !== null,
        note: plan.note,
      };
    },
  };
  const requests = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options = {}) => {
      const path = String(url);
      requests.push({ url: path, method: options.method || 'GET' });
      if (path === '/api/runtime/jobs') {
        return { ok: true, json: async () => ({ jobs: server.jobs }) };
      }
      const match = /^\/api\/runtime\/jobs\/([^/]+)\/move$/.exec(path);
      if (match) {
        const body = JSON.parse(options.body);
        server.moves.push({ id: match[1], body, headers: options.headers });
        if (server.hold) {
          await server.hold;
        }
        if (server.failure) {
          const failure = server.failure;
          server.failure = null;
          if (failure.change) {
            server.jobs = failure.change(server.jobs);
          }
          return { ok: false, status: failure.status, json: async () => failure.body };
        }
        return { ok: true, status: 200, json: async () => server.apply(match[1], body) };
      }
      return {
        ok: true,
        // a takes 10 s, b 20 s and so on; the running render is expected to take 100 s.
        json: async () => {
          const prompt = JSON.parse(options.body || '{}').request?.prompt || '';
          const seconds = { 'prompt run': 100, 'prompt a': 10, 'prompt b': 20, 'prompt c': 30 };
          return { available: true, typicalSeconds: seconds[prompt] ?? 40, confidence: 'exact' };
        },
      };
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
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
    for (const [key, descriptor] of Object.entries(previous)) {
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
  const { window } = dom;
  const fire = async (element, event) => {
    await act(async () => {
      element.dispatchEvent(event);
    });
  };
  const ui = {
    container,
    server,
    requests,
    window,
    click: (element) => fire(element, new window.MouseEvent('click', { bubbles: true })),
    key: (element, key) =>
      fire(element, new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    pointer: (element, type, clientY = 0) =>
      fire(
        element,
        new window.MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 }),
      ),
    rows: () => [...container.querySelectorAll('.queue-group-waiting .runtime-job')],
    order: () => ui.rows().map((row) => row.dataset.jobId),
    live: () =>
      container.querySelector('.queue-reorder-live').textContent.replace(/\s/g, ' ').trim(),
    handle: (id) => container.querySelector(`[data-reorder-handle="${id}"]`),
    button: (label) => container.querySelector(`button[aria-label="${label}"]`),
    settle: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
  };
  return ui;
}

test('each waiting row shows its place and labelled controls with reasons when disabled', async (t) => {
  const ui = await mountQueue(t);
  assert.deepEqual(ui.order(), ['a', 'b', 'c', 'd']);
  const positions = ui.rows().map((row) => row.querySelector('.queue-position').textContent);
  assert.deepEqual(positions, ['#1', '#2', '#3', '#4']);
  assert.equal(
    ui.rows()[1].querySelector('.queue-position').getAttribute('aria-label'),
    'Position 2 of 4 in the waiting line',
  );
  assert.match(
    ui.container.querySelector('.queue-group-waiting h3').textContent,
    /Waiting in line\s*4/,
  );

  const first = ui.rows()[0];
  const up = first.querySelector('button[aria-label="Move prompt a up"]');
  assert.equal(up.getAttribute('aria-disabled'), 'true');
  assert.equal(up.title, 'Already first in line.');
  assert.equal(
    first.querySelector('button[aria-label="Run next: prompt a"]').getAttribute('aria-disabled'),
    'true',
  );
  assert.equal(
    first.querySelector('button[aria-label="Move prompt a down"]').getAttribute('aria-disabled'),
    null,
  );
  const last = ui.rows()[3];
  assert.equal(
    last.querySelector('button[aria-label="Move prompt d down"]').title,
    'Already last in line.',
  );
  assert.equal(
    last.querySelector('button[aria-label="Move prompt d up"]').getAttribute('aria-disabled'),
    null,
  );
  // The handle is a labelled button with instructions, and the running render has no controls.
  const handle = ui.handle('b');
  assert.equal(handle.tagName, 'BUTTON');
  assert.equal(handle.getAttribute('aria-label'), 'Reorder prompt b. Position 2 of 4.');
  assert.equal(handle.getAttribute('aria-pressed'), 'false');
  assert.match(
    document.getElementById(handle.getAttribute('aria-describedby')).textContent,
    /Space to pick the render up/,
  );
  assert.ok(!ui.container.querySelector('.queue-group-processing [data-reorder-handle]'));
  assert.equal(ui.container.querySelector('.queue-reorder-live').getAttribute('role'), 'status');
});

test('a render that uses an earlier one cannot be moved above it, and says why', async (t) => {
  const jobs = [
    job('p', 'queued'),
    job('child', 'queued', {
      dependsOn: 'p',
      request: { prompt: 'child', referenceFrom: { jobId: 'p' } },
    }),
    job('x', 'queued'),
  ];
  const ui = await mountQueue(t, { jobs });
  const up = ui.button('Move child up');
  assert.equal(up.getAttribute('aria-disabled'), 'true');
  assert.match(up.title, /uses the result of the render above it/);
  await ui.click(up);
  assert.equal(ui.server.moves.length, 0, 'a disabled control sends nothing');
  assert.equal(ui.button('Move child down').getAttribute('aria-disabled'), null);
});

test('Move down updates the list and the forecast at once, then confirms with the runtime', async (t) => {
  const ui = await mountQueue(t);
  // The running render has about 100 s left, so the first waiting render starts in ~1m 40s.
  assert.match(ui.rows()[0].textContent, /Starts in ~1m 40s/);
  let release;
  ui.server.hold = new Promise((resolve) => {
    release = resolve;
  });
  await ui.click(ui.button('Move prompt a down'));
  // The request is still waiting for the runtime, yet the rows and the forecast already moved.
  assert.deepEqual(ui.order(), ['b', 'a', 'c', 'd']);
  assert.match(ui.rows()[0].querySelector('.queue-position').textContent, /#1/);
  // b (20 s) now runs before a (10 s): a starts after b, and the first row's wait is unchanged.
  assert.match(ui.rows()[0].textContent, /prompt b.*Starts in ~1m 40s/);
  assert.match(ui.rows()[1].textContent, /prompt a.*Starts in ~2m/);
  assert.equal(
    ui.button('Move prompt b down').getAttribute('aria-disabled'),
    'true',
    'controls pause while the move is being saved',
  );
  await act(async () => {
    release();
    ui.server.hold = null;
  });
  await ui.settle();
  assert.deepEqual(ui.order(), ['b', 'a', 'c', 'd']);
  const [move] = ui.server.moves;
  assert.equal(move.id, 'a');
  assert.deepEqual(move.body, { after: 'b', expectedRank: 2, expectedAnchorRank: 3 });
  assert.equal(move.headers['X-Forge-Request'], 'runtime');
  assert.equal(ui.live(), 'Moved prompt a to position 2 of 4.');
  assert.ok(!ui.container.querySelector('.queue-reorder-error'));
});

test('Run next moves a render to the front of the waiting line', async (t) => {
  const ui = await mountQueue(t);
  await ui.click(ui.button('Run next: prompt c'));
  await ui.settle();
  assert.deepEqual(ui.order(), ['c', 'a', 'b', 'd']);
  assert.deepEqual(ui.server.moves[0].body, { to: 'next', expectedRank: 4 });
  assert.equal(ui.live(), 'Moved prompt c to position 1 of 4.');
  assert.match(ui.rows()[0].textContent, /prompt c.*Starts in ~1m 40s/);
  assert.match(ui.rows()[1].textContent, /prompt a.*Starts in ~2m 10s/);
  assert.equal(ui.button('Run next: prompt c').getAttribute('aria-disabled'), 'true');
});

test('a refused move goes back and shows an inline error', async (t) => {
  const ui = await mountQueue(t);
  ui.server.failure = { status: 500, body: { error: 'The runtime is restarting.' } };
  await ui.click(ui.button('Run next: prompt d'));
  await ui.settle();
  assert.deepEqual(ui.order(), ['a', 'b', 'c', 'd'], 'rolled back');
  const alert = ui.container.querySelector('.queue-reorder-error');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent, /The runtime is restarting\./);
  assert.match(ui.live(), /prompt d was not moved\. The runtime is restarting\./);
  await ui.click(alert.querySelector('button'));
  assert.ok(!ui.container.querySelector('.queue-reorder-error'));
});

test('a conflict shows the order the runtime reports instead of the guess', async (t) => {
  const ui = await mountQueue(t);
  ui.server.failure = {
    status: 409,
    body: {
      error: 'This render was moved somewhere else.',
      code: 'stale',
      order: ['d', 'a', 'b', 'c'],
      ranks: { d: 1, a: 2, b: 3, c: 4 },
    },
    change: (current) => applyWaitingOrder(current, ['d', 'a', 'b', 'c']),
  };
  await ui.click(ui.button('Run next: prompt c'));
  await ui.settle();
  assert.deepEqual(ui.order(), ['d', 'a', 'b', 'c']);
  assert.match(
    ui.container.querySelector('.queue-reorder-error').textContent,
    /changed somewhere else/,
  );
  assert.match(ui.live(), /prompt c was not moved/);
});

test('the keyboard picks a render up, moves it, drops it or cancels', async (t) => {
  const ui = await mountQueue(t);
  const handle = ui.handle('a');
  handle.focus();
  await ui.key(handle, ' ');
  assert.equal(ui.handle('a').getAttribute('aria-pressed'), 'true');
  assert.match(ui.live(), /^Picked up prompt a, position 1 of 4\./);
  await ui.key(ui.handle('a'), 'ArrowDown');
  assert.equal(ui.live(), 'prompt a, position 2 of 4.');
  await ui.key(ui.handle('a'), 'ArrowDown');
  assert.equal(ui.live(), 'prompt a, position 3 of 4.');
  assert.deepEqual(ui.order(), ['b', 'c', 'a', 'd'], 'the row moves while held');
  assert.equal(document.activeElement, ui.handle('a'), 'focus stays on the handle');
  assert.equal(ui.server.moves.length, 0, 'nothing is sent until the drop');

  await ui.key(ui.handle('a'), 'Escape');
  assert.deepEqual(ui.order(), ['a', 'b', 'c', 'd']);
  assert.equal(ui.live(), 'Move cancelled. prompt a is back at position 1 of 4.');
  assert.equal(ui.handle('a').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.server.moves.length, 0);

  await ui.key(ui.handle('a'), ' ');
  await ui.key(ui.handle('a'), 'ArrowUp');
  assert.match(ui.live(), /already first in line/);
  await ui.key(ui.handle('a'), 'End');
  assert.deepEqual(ui.order(), ['b', 'c', 'd', 'a']);
  await ui.key(ui.handle('a'), ' ');
  await ui.settle();
  assert.deepEqual(
    ui.server.moves.map((move) => move.body),
    [{ after: 'd', expectedRank: 2, expectedAnchorRank: 5 }],
  );
  assert.deepEqual(ui.order(), ['b', 'c', 'd', 'a']);
  assert.equal(ui.live(), 'Moved prompt a to position 4 of 4.');
  assert.equal(ui.handle('a').getAttribute('aria-pressed'), 'false');
});

test('dropping a held render where it started sends nothing, and leaving the handle cancels', async (t) => {
  const ui = await mountQueue(t);
  ui.handle('b').focus();
  await ui.key(ui.handle('b'), ' ');
  await ui.key(ui.handle('b'), 'ArrowDown');
  await ui.key(ui.handle('b'), 'ArrowUp');
  await ui.key(ui.handle('b'), ' ');
  assert.equal(ui.live(), 'prompt b dropped where it was, position 2 of 4.');
  assert.equal(ui.server.moves.length, 0);

  await ui.key(ui.handle('b'), ' ');
  await ui.key(ui.handle('b'), 'ArrowDown');
  await act(async () => {
    ui.handle('b').blur();
  });
  assert.deepEqual(ui.order(), ['a', 'b', 'c', 'd']);
  assert.match(ui.live(), /Move cancelled/);
});

test('dragging the handle shows a drop line and moves the render on release', async (t) => {
  const ui = await mountQueue(t);
  ui.rows().forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 100, height: 80, bottom: index * 100 + 80 });
  });
  const handle = ui.handle('a');
  await ui.pointer(handle, 'pointerdown', 10);
  assert.ok(ui.rows()[0].classList.contains('queue-row-dragging'));
  assert.match(ui.live(), /^Dragging prompt a\./);
  // Over the upper half of the last row: the drop line goes before it.
  await ui.pointer(handle, 'pointermove', 280);
  const target = ui.rows()[3];
  assert.ok(target.classList.contains('queue-drop-before'));
  // Over the upper half of the second row: before it.
  await ui.pointer(handle, 'pointermove', 110);
  assert.ok(ui.rows()[1].classList.contains('queue-drop-before'));
  assert.ok(!target.classList.contains('queue-drop-before'));
  // Below every row: the drop line goes after the last one.
  await ui.pointer(handle, 'pointermove', 400);
  assert.ok(target.classList.contains('queue-drop-after'));
  await ui.pointer(handle, 'pointerup', 400);
  await ui.settle();
  assert.deepEqual(ui.server.moves[0].body.after, 'd');
  assert.deepEqual(ui.order(), ['b', 'c', 'd', 'a']);
  assert.ok(!ui.container.querySelector('.queue-row-dragging'));
  assert.ok(!ui.container.querySelector('[class*="queue-drop-"]'));
});

test('Escape cancels a drag and releasing nowhere sends nothing', async (t) => {
  const ui = await mountQueue(t);
  ui.rows().forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 100, height: 80, bottom: index * 100 + 80 });
  });
  const handle = ui.handle('c');
  await ui.pointer(handle, 'pointerdown', 210);
  await ui.pointer(handle, 'pointermove', 10);
  assert.ok(ui.rows()[0].classList.contains('queue-drop-before'));
  await act(async () => {
    document.dispatchEvent(
      new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  assert.ok(!ui.container.querySelector('.queue-row-dragging'));
  assert.match(ui.live(), /Move cancelled\. prompt c stays where it was\./);
  await ui.pointer(handle, 'pointerup', 10);
  assert.equal(ui.server.moves.length, 0);
  assert.deepEqual(ui.order(), ['a', 'b', 'c', 'd']);
});

test('a render with an engine job has no place to move and its handle is disabled', async (t) => {
  const jobs = [
    job('a', 'queued'),
    job('b', 'waiting_engine', { remoteId: 'engine-9' }),
    job('c', 'queued'),
  ];
  const ui = await mountQueue(t, { jobs });
  const row = ui.container.querySelector('[data-job-id="b"]');
  assert.ok(!row.querySelector('.queue-position'));
  assert.equal(ui.handle('b').getAttribute('aria-disabled'), 'true');
  assert.match(ui.handle('b').title, /engine job/);
  await ui.key(ui.handle('b'), ' ');
  assert.equal(ui.handle('b').getAttribute('aria-pressed'), 'false');
  assert.equal(ui.server.moves.length, 0);
  // The others still count only the renders that can move.
  assert.equal(ui.handle('c').getAttribute('aria-label'), 'Reorder prompt c. Position 2 of 2.');
});
