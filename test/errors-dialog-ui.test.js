import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { loadJsx } from './fixtures/load-jsx.js';

// React DOM checks platform features at import time, so a DOM must exist before it loads.
const bootstrap = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, useLocation } = await import('react-router');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ERRORS = [
  {
    id: 1,
    fingerprint: 'f'.repeat(32),
    source: 'engine:segmentation',
    message: 'ValueError: No matching objects were found.',
    count: 3,
    firstSeen: '2026-11-08T09:00:00.000Z',
    lastSeen: '2026-11-08T10:00:00.000Z',
    status: 'new',
    page: null,
    jobId: '1a2b3c4d-1111-2222-3333-444455556666',
    projectId: null,
    hasSuggestion: false,
    issueUrl: null,
    issueNumber: null,
  },
  {
    id: 2,
    fingerprint: 'e'.repeat(32),
    source: 'browser',
    message: 'TypeError: x is undefined',
    count: 1,
    firstSeen: '2026-11-08T08:00:00.000Z',
    lastSeen: '2026-11-08T08:00:00.000Z',
    status: 'resolved',
    page: '/images',
    jobId: null,
    projectId: null,
    hasSuggestion: false,
    issueUrl: null,
    issueNumber: null,
  },
];

function detailOf(summary, overrides = {}) {
  return {
    ...summary,
    stack:
      'Traceback (most recent call last):\n  File "<repo>\\runtime\\sam31_backend.py", line 138, in segment_image\nValueError: No matching objects were found.',
    context: { jobType: 'segmentation', jobStatus: 'failed', log: 'engine-segmentation.log' },
    note: '',
    fixNote: '',
    fixSource: null,
    suggestion: '',
    suggestionModel: null,
    suggestionAt: null,
    includesPaths: false,
    ...overrides,
  };
}

async function mount(t, { entry = '/?dialog=errors', state = {} } = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Errors</button><div id="root"></div></body></html>',
    { pretendToBeVisual: true, url: 'http://localhost/' },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => state.copied.push(text) },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.getClientRects = () => [{ width: 800, height: 600 }];
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    width: 800,
    height: 600,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
  });
  state.copied = [];
  state.requests = [];
  state.errors ??= ERRORS;
  state.details ??= {};
  state.settings ??= {
    model: 'gpt-6.1-sol',
    defaultModel: 'gpt-6.1-sol',
    provider: 'openai',
    hasKey: false,
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const route = url.pathname.replace('/api/errors', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ method, route, search: url.search, body, headers: init.headers });
    const respond = (status, data) => ({ ok: status < 300, status, json: async () => data });
    if (method === 'GET' && route === '') {
      const status = url.searchParams.get('status');
      const errors = state.errors.filter((error) => !status || error.status === status);
      return respond(200, {
        errors,
        total: errors.length,
        summary: { unread: 1, counts: { resolved: 1 }, total: 2 },
        scanProblems: [],
      });
    }
    if (method === 'GET' && route === '/settings') {
      return respond(200, state.settings);
    }
    if (method === 'GET' && route === '/export') {
      return respond(200, {
        errors: state.errors
          .filter((error) => error.status === 'new')
          .map((error) => detailOf(error)),
      });
    }
    const detail = /^\/(\d+)(?:\/([a-z-]+))?$/.exec(route);
    if (detail) {
      const id = Number(detail[1]);
      const summary = state.errors.find((error) => error.id === id);
      const current = state.details[id] || detailOf(summary);
      if (method === 'GET') {
        return respond(200, { error: current });
      }
      if (detail[2] === 'viewed') {
        state.details[id] = { ...current, status: 'reviewed' };
        return respond(200, { error: state.details[id] });
      }
      if (detail[2] === 'status') {
        state.details[id] = { ...current, status: body.status, fixNote: body.fixNote || '' };
        return respond(200, { error: state.details[id] });
      }
      if (detail[2] === 'fix-preview') {
        return respond(200, {
          body: {
            model: 'gpt-6.1-sol',
            instructions: 'help',
            input: 'Error message: x',
            max_output_tokens: 4000,
            store: false,
          },
          digest: 'abc',
          sourceFiles: [{ path: 'runtime/sam31_backend.py', startLine: 132, endLine: 144 }],
          notice:
            'The redacted error text and the listed source lines are sent to OpenAI. Nothing else is sent.',
          hasKey: state.settings.hasKey,
        });
      }
    }
    if (method === 'POST') {
      return respond(200, { ok: true });
    }
    return respond(404, { error: 'Not found.' });
  };
  const { module, cleanup } = await loadJsx('ErrorsDialog.jsx');
  const location = { current: '' };
  function Probe() {
    const here = useLocation();
    location.current = here.pathname + here.search;
    return null;
  }
  const calls = { close: 0, settings: 0, jobs: [] };
  document.getElementById('opener').focus();
  const root = createRoot(document.getElementById('root'));
  const render = (open) =>
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        React.createElement(Probe),
        open
          ? React.createElement(module.default, {
              onClose: () => calls.close++,
              onOpenSettings: () => calls.settings++,
              onOpenJob: (id) => calls.jobs.push(id),
            })
          : null,
      ),
    );
  await act(async () => render(true));
  await act(() => sleep(300));
  t.after(async () => {
    await act(async () => root.unmount());
    await cleanup();
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.getComputedStyle = previous.getComputedStyle;
    Object.defineProperty(globalThis, 'navigator', previous.navigator);
  });
  const byText = (selector, text) =>
    [...document.querySelectorAll(selector)].find((element) => element.textContent.includes(text));
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await act(() => sleep(30));
  };
  return { dom, state, calls, location, byText, click, render };
}

test('the dialog has an accessible title, focuses search, lists errors and closes on Escape', async (t) => {
  const { dom, calls, state } = await mount(t);
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(
    document.getElementById(dialog.getAttribute('aria-labelledby')).textContent,
    'Errors',
  );
  assert.equal(document.activeElement, document.querySelector('.errors-search input'));
  const items = document.querySelectorAll('.errors-item');
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /Engine segmentation/);
  assert.match(items[0].textContent, /New/);
  assert.match(items[0].textContent, /×3/);
  assert.ok(
    state.requests.some((request) => request.method === 'POST' && request.route === '/opened'),
  );
  await act(async () => {
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  assert.equal(calls.close, 1);
});

test('focus returns to the opener when the dialog closes', async (t) => {
  const { render } = await mount(t);
  assert.notEqual(document.activeElement.id, 'opener');
  await act(async () => render(false));
  assert.equal(document.activeElement.id, 'opener');
});

test('selecting an error updates the URL, marks it reviewed and copies redacted text', async (t) => {
  const { state, calls, location, byText, click } = await mount(t);
  await click(document.querySelector('.errors-item'));
  assert.match(location.current, /error=1/);
  assert.ok(state.requests.some((request) => request.route === '/1/viewed'));
  assert.match(document.querySelector('.errors-detail-title').textContent, /ValueError/);
  assert.equal(document.querySelectorAll('.errors-stack-line').length, 3);
  const toggle = byText('label', 'Include local paths').querySelector('input');
  assert.equal(toggle.checked, false);
  await click(byText('button', 'Copy error'));
  assert.match(state.copied.at(-1), /\[Engine segmentation\] ValueError/);
  assert.match(state.copied.at(-1), /<repo>\\runtime\\sam31_backend\.py/);
  await click(byText('button', 'Copy as markdown'));
  assert.match(state.copied.at(-1), /^### Engine segmentation/);
  await click(byText('button', 'Copy stack only'));
  assert.ok(state.copied.at(-1).startsWith('Traceback (most recent call last):'));
  await click(byText('button', 'Copy fix prompt'));
  assert.match(state.copied.at(-1), /I am debugging Forge/);
  assert.match(document.querySelector('.errors-detail .errors-live').textContent, /copied/);
  await click(byText('button', 'Open in render queue'));
  assert.deepEqual(calls.jobs, ['1a2b3c4d-1111-2222-3333-444455556666']);
});

test('arrow keys move through the list and filters refetch', async (t) => {
  const { dom, state, location } = await mount(t);
  const [first, second] = document.querySelectorAll('.errors-item');
  first.focus();
  await act(async () => {
    first.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
  });
  assert.equal(document.activeElement, second);
  assert.match(location.current, /error=2/);
  const status = document.querySelector('.errors-toolbar select');
  await act(async () => {
    status.value = 'resolved';
    status.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await act(() => sleep(30));
  assert.ok(
    state.requests.some(
      (request) => request.route === '' && request.search.includes('status=resolved'),
    ),
  );
  assert.equal(document.querySelectorAll('.errors-item').length, 1);
});

test('the empty state explains where errors come from', async (t) => {
  await mount(t, { state: { errors: [] } });
  assert.match(document.querySelector('.errors-empty').textContent, /No errors recorded/);
});

test('without a key the fix button links to Settings and nothing is sent without Send', async (t) => {
  const { state, calls, byText, click } = await mount(t, { entry: '/?dialog=errors&error=1' });
  await act(() => sleep(50));
  await click(byText('button', 'Add your OpenAI key in Settings'));
  assert.equal(calls.settings, 1);
  await click(byText('button', 'Suggest a fix with GPT'));
  const preview = document.querySelector('[aria-label="What will be sent to OpenAI"]');
  assert.ok(preview);
  assert.match(preview.textContent, /sent to OpenAI/);
  assert.match(preview.textContent, /runtime\/sam31_backend\.py 132-144/);
  assert.equal(byText('button', 'Send to OpenAI').disabled, true);
  assert.ok(!state.requests.some((request) => request.route.endsWith('/suggest-fix')));
  await click(byText('button', 'Cancel'));
  assert.equal(document.querySelector('[aria-label="What will be sent to OpenAI"]'), null);
});

test('Copy all new and the two-step Clear resolved', async (t) => {
  const { state, byText, click } = await mount(t);
  await click(byText('button', 'Copy all new'));
  assert.match(state.copied.at(-1), /^# Forge errors \(1\)/);
  await click(byText('button', 'Clear resolved'));
  assert.ok(!state.requests.some((request) => request.route === '/clear'));
  await click(byText('button', 'Delete 1 resolved'));
  const clear = state.requests.find((request) => request.route === '/clear');
  assert.deepEqual(clear.body, { statuses: ['resolved'], confirm: 'clear' });
  assert.equal(clear.headers['X-Forge-Request'], 'errors');
});

test('a fix can be marked as worked with a note, which enables the GitHub issue button', async (t) => {
  const { state, byText, click, dom } = await mount(t, { entry: '/?dialog=errors&error=1' });
  await act(() => sleep(50));
  assert.equal(byText('button', 'Create GitHub issue'), undefined);
  await click(byText('button', 'Fix worked'));
  const note = document.querySelector('.errors-verify textarea');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLTextAreaElement.prototype,
      'value',
    ).set;
    setter.call(note, 'Restarted the engine');
    note.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await click(byText('button', 'Save as fixed (verified)'));
  const request = state.requests.find((entry) => entry.route === '/1/status');
  assert.deepEqual(request.body, {
    status: 'verified',
    fixNote: 'Restarted the engine',
    fixSource: 'self',
  });
  assert.ok(byText('button', 'Create GitHub issue'));
});

test('error boundaries and failed studio API calls are reported to the Errors review', async (t) => {
  const { dom, state } = await mount(t, { state: { errors: [] } });
  const capture = await import('../src/error-capture.js');
  const reports = [];
  const studioFetch = async (input, init = {}) => {
    const path = String(input);
    if (path === '/api/errors/report') {
      reports.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }
    if (path === '/api/runtime/jobs') {
      return {
        ok: false,
        status: 502,
        headers: { get: () => 'application/json' },
        clone: () => ({ json: async () => ({ error: 'Runtime unavailable.' }) }),
      };
    }
    if (path === '/api/projects') {
      throw new TypeError('Failed to fetch');
    }
    if (path === '/api/errors/summary') {
      return { ok: false, status: 500, headers: { get: () => '' } };
    }
    return { ok: true, status: 200 };
  };
  dom.window.fetch = studioFetch;
  capture.installErrorCapture(dom.window);
  const response = await dom.window.fetch('/api/runtime/jobs');
  assert.equal(response.status, 502, 'the response passes through unchanged');
  await assert.rejects(dom.window.fetch('/api/projects'), /Failed to fetch/);
  await dom.window.fetch('/api/errors/summary');
  assert.equal(capture.isErrorNotice('Could not queue image: busy'), true);
  assert.equal(capture.isErrorNotice('Image added to the durable queue.'), false);
  capture.reportNoticeError('Could not queue image: busy');
  capture.reportNoticeError('Video added to the durable queue.');

  const { module, cleanup } = await loadJsx('PageErrorBoundary.jsx');
  t.after(cleanup);
  function Broken() {
    throw new Error('render exploded');
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await act(async () =>
      root.render(
        React.createElement(module.default, { name: 'Images' }, React.createElement(Broken)),
      ),
    );
  } finally {
    console.error = originalConsoleError;
  }
  await act(() => sleep(30));
  assert.match(
    container.textContent,
    /Could not open Images/,
    'the fallback keeps the studio usable',
  );
  await act(async () => root.unmount());

  const kinds = reports.map((report) => report.kind);
  assert.ok(kinds.includes('fetch'));
  assert.ok(
    reports.some(
      (report) =>
        report.message === 'GET /api/runtime/jobs failed with HTTP 502: Runtime unavailable.',
    ),
  );
  assert.ok(
    reports.some((report) =>
      report.message.startsWith('GET /api/projects could not reach the studio'),
    ),
  );
  assert.ok(
    !reports.some((report) => report.message.includes('/api/errors')),
    'failures of the errors API itself are not reported, so reporting cannot loop',
  );
  assert.deepEqual(
    reports.filter((report) => report.kind === 'notice').map((report) => report.message),
    ['Could not queue image: busy'],
  );
  const boundary = reports.find((report) => report.kind === 'boundary');
  assert.ok(boundary, JSON.stringify(kinds));
  assert.equal(boundary.message, 'Error: render exploded');
  assert.match(boundary.componentStack, /Broken/);
  assert.equal(boundary.context.boundary, 'Images');
  assert.ok(state);
});

test('the top-bar button names the unread count for screen readers', async (t) => {
  const { dom } = await mount(t, { state: { errors: [] } });
  const { module, cleanup } = await loadJsx('ErrorsButton.jsx');
  t.after(cleanup);
  dom.window.fetch = undefined;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ unread: 4 }) });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let opened = 0;
  await act(async () =>
    root.render(React.createElement(module.default, { onOpen: () => opened++ })),
  );
  await act(() => sleep(30));
  const button = container.querySelector('button');
  assert.equal(
    button.getAttribute('aria-label'),
    'Errors: 4 new since last opened. Open error review.',
  );
  assert.equal(container.querySelector('.errors-button-badge').textContent, '4');
  button.click();
  assert.equal(opened, 1);
  await act(async () => root.unmount());
});
