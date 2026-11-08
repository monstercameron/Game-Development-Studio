// Studio log view on the Diagnostics page (src/StudioLogView.jsx) in jsdom against a fake
// /api/logs: rows, grouped duplicates, filters in the URL, detail drawer with trace link and
// keyboard close, live tail, copy, empty and error states.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { transformWithEsbuild } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceUrl = (relative) => pathToFileURL(path.join(repositoryRoot, relative)).href;

function row(id, overrides = {}) {
  return {
    id,
    ts: 1_790_000_000_000 + id * 1000,
    level: 'info',
    component: 'queue',
    event: 'job.state.changed',
    message: '',
    fields: { from: 'queued', to: 'running' },
    process: 'worker',
    pid: 42,
    traceId: null,
    jobId: `job-${id}`,
    durationMs: null,
    seq: id,
    count: 1,
    firstTs: null,
    ...overrides,
  };
}

async function loadView(temporaryDirectory) {
  const source = (await readFile(path.join(repositoryRoot, 'src', 'StudioLogView.jsx'), 'utf8'))
    .replace("'../runtime/log-fields.js'", `'${sourceUrl('runtime/log-fields.js')}'`)
    .replace("'./app-log.js'", `'${sourceUrl('src/app-log.js')}'`)
    .replace("'./i18n/index.js'", `'${sourceUrl('src/i18n/index.js')}'`)
    .replace("'./studio-log-api.js'", `'${sourceUrl('src/studio-log-api.js')}'`)
    .replace("'./useNav'", `'${sourceUrl('src/useNav.js')}'`)
    .replace("import './studio-log.css';", '');
  const transformed = await transformWithEsbuild(
    source,
    path.join(temporaryDirectory, 'StudioLogView.jsx'),
    { loader: 'jsx', jsx: 'automatic' },
  );
  const modulePath = path.join(temporaryDirectory, 'StudioLogView.mjs');
  await writeFile(modulePath, transformed.code, 'utf8');
  return (await import(pathToFileURL(modulePath).href)).default;
}

test('studio log view: rows, grouping, filters, detail drawer, trace link, tail and states', async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(repositoryRoot, 'test', '.studio-log-ui-'));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/diagnostics',
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    reactActEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const requests = [];
  let pageRows = [
    row(5, { level: 'warn', event: 'queue.poll.failed', jobId: null, count: 3 }),
    row(4, { level: 'warn', event: 'queue.poll.failed', jobId: null }),
    row(3, { traceId: 'trace-abc-123', durationMs: 120 }),
    row(2, { level: 'error', component: 'engine', event: 'engine.start.failed', jobId: null }),
  ];
  let tailRows = [];
  let failNext = false;
  let copied = '';
  let tailTick = null;
  let root;
  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: dom.window.navigator,
    });
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => (copied = value) },
    });
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.setInterval = (callback) => {
      tailTick = callback;
      return 1;
    };
    globalThis.clearInterval = () => {
      tailTick = null;
    };
    globalThis.fetch = async (url, init = {}) => {
      requests.push({ url, headers: init.headers });
      if (failNext) {
        failNext = false;
        return { ok: false, status: 500, json: async () => ({ error: 'The log service failed.' }) };
      }
      if (url.startsWith('/api/logs/summary')) {
        return {
          ok: true,
          json: async () => ({
            rows: 4,
            fileBytes: 3 * 1024 * 1024,
            dropped: { records: 2, fields: 5, collapsedRecords: 3, browser_dropped_records: 1 },
            retention: { maxAgeDays: 14, maxBytes: 256 * 1024 * 1024 },
          }),
        };
      }
      if (url.startsWith('/api/logs/tail')) {
        const rows = tailRows;
        tailRows = [];
        return { ok: true, json: async () => ({ rows, cursor: rows.at(-1)?.id ?? 5 }) };
      }
      return { ok: true, json: async () => ({ rows: pageRows, nextCursor: null }) };
    };
    const StudioLogView = await loadView(temporaryDirectory);
    let location;
    function LocationProbe() {
      location = useLocation();
      return null;
    }
    root = createRoot(document.getElementById('root'));
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/diagnostics'] },
          React.createElement(StudioLogView),
          React.createElement(LocationProbe),
        ),
      );
    });
    const container = document.getElementById('root');
    assert.ok(requests.every((request) => request.headers['X-Forge-Request'] === 'logs'));
    assert.match(requests[0].url, /^\/api\/logs\?level=info&since=\d+&limit=100$/);

    // Duplicates are grouped with a count; the level is written out, not only coloured.
    const buttons = [...container.querySelectorAll('.studio-log-row')];
    assert.equal(buttons.length, 3);
    assert.match(buttons[0].textContent, /WARN.*queue\.poll\.failed.*×4/);
    assert.match(buttons[2].textContent, /ERROR/);
    assert.match(container.querySelector('.studio-log-summary').textContent, /3\.0 MiB/);
    assert.match(container.querySelector('.studio-log-summary').textContent, /Dropped records3/);

    // Detail drawer, then the trace link narrows the view through the URL.
    buttons[1].focus();
    await act(async () => buttons[1].click());
    const drawer = container.querySelector('.studio-log-detail');
    assert.ok(drawer);
    assert.equal(document.activeElement, drawer);
    assert.match(drawer.textContent, /"to": "running"/);
    const copyRecord = [...drawer.querySelectorAll('button')].find((button) =>
      /Copy record/.test(button.textContent),
    );
    await act(async () => copyRecord.click());
    assert.equal(JSON.parse(copied).id, 3);
    await act(async () => {
      drawer.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(container.querySelector('.studio-log-detail'), null);
    assert.equal(document.activeElement, container.querySelectorAll('.studio-log-row')[1]);

    await act(async () => container.querySelectorAll('.studio-log-row')[1].click());
    const traceLink = [...container.querySelectorAll('.studio-log-detail button')].find((button) =>
      /this trace/.test(button.textContent),
    );
    await act(async () => traceLink.click());
    assert.match(location.search, /logTrace=trace-abc-123/);
    assert.match(requests.at(-2).url, /traceId=trace-abc-123/);
    assert.ok(!/since=/.test(requests.at(-2).url), 'a trace shows its whole history');
    assert.match(container.textContent, /Showing trace trace-abc-123/);

    // Live tail adds new rows at the top.
    const liveButton = [...container.querySelectorAll('button')].find((button) =>
      /Live tail/.test(button.textContent),
    );
    await act(async () => liveButton.click());
    assert.equal(liveButton.getAttribute('aria-pressed'), 'true');
    tailRows = [row(9, { event: 'job.state.changed', traceId: 'trace-abc-123' })];
    await act(async () => {
      await tailTick();
    });
    assert.match(container.querySelector('.studio-log-row').textContent, /job-9/);

    // Empty and error states.
    pageRows = [];
    const clear = [...container.querySelectorAll('button')].find((button) =>
      /Clear filters/.test(button.textContent),
    );
    await act(async () => clear.click());
    assert.match(container.textContent, /No records yet/);
    failNext = true;
    const levelSelect = container.querySelector('.studio-log-filters select');
    await act(async () => {
      levelSelect.value = 'error';
      levelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.match(container.querySelector('[role="alert"]').textContent, /The log service failed/);
  } finally {
    await act(async () => root?.unmount());
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    if (saved.navigator) {
      Object.defineProperty(globalThis, 'navigator', saved.navigator);
    }
    globalThis.fetch = saved.fetch;
    globalThis.setInterval = saved.setInterval;
    globalThis.clearInterval = saved.clearInterval;
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.reactActEnvironment;
    dom.window.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  t.diagnostic('rendered rows, drawer, trace filter, tail, empty and error states');
});
