// jsdom tests for Diagnostics, Developer tools, Test the error pipeline (src/ErrorPipelineTest.jsx).
// The studio API is a fake fetch; test/errors-e2e.test.js runs the same section against the real host.
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
const capture = await import('../src/error-capture.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(t, { responses = {}, installCapture = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/diagnostics',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    Event: Object.getOwnPropertyDescriptor(globalThis, 'Event'),
  };
  const state = { requests: [], reports: [], responses, errorEvents: [], caughtEvents: [] };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.fetch = async (input, init = {}) => {
    const route = String(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (route === '/api/errors/report') {
      state.reports.push(body);
      return { ok: true, status: 200, json: async () => ({ id: 1 }) };
    }
    state.requests.push({ method: init.method || 'GET', route, body, headers: init.headers });
    const answer = state.responses[route] || { status: 200, data: { sent: true } };
    return {
      ok: answer.status < 300,
      status: answer.status,
      headers: { get: () => 'application/json' },
      clone() {
        return this;
      },
      json: async () => answer.data,
    };
  };
  globalThis.fetch = (...args) => dom.window.fetch(...args);
  if (installCapture) {
    capture.installErrorCapture(dom.window);
  }
  dom.window.addEventListener('error', (event) => {
    event.preventDefault();
    state.errorEvents.push(event.error);
  });
  dom.window.addEventListener('forge:caught-error', (event) =>
    state.caughtEvents.push(event.detail),
  );
  const { module, cleanup } = await loadJsx('ErrorPipelineTest.jsx');
  const calls = { openErrors: 0 };
  const root = createRoot(document.getElementById('root'));
  const originalConsoleError = console.error;
  console.error = () => {};
  await act(async () =>
    root.render(React.createElement(module.default, { onOpenErrors: () => calls.openErrors++ })),
  );
  t.after(async () => {
    console.error = originalConsoleError;
    await act(async () => root.unmount());
    await cleanup();
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    Object.defineProperty(globalThis, 'Event', previous.Event);
  });
  const byText = (selector, text) =>
    [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text);
  const click = async (element, wait = 20) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await act(() => sleep(wait));
  };
  const statusOf = (id) => document.getElementById(`error-test-status-${id}`);
  return { dom, state, calls, byText, click, statusOf };
}

test('the section is a collapsed Developer tools panel with named buttons and live statuses', async (t) => {
  const { byText, statusOf } = await mount(t);
  const details = document.querySelector('details.error-test');
  assert.ok(details);
  assert.equal(details.open, false, 'collapsed by default');
  assert.match(details.querySelector('summary').textContent, /DEVELOPER TOOLS/);
  assert.match(details.querySelector('summary').textContent, /Test the error pipeline/);
  assert.match(details.textContent, /\[Forge test error\]/);
  assert.match(details.textContent, /Nothing here starts an engine, loads a model or uses the GPU/);
  const labels = [
    'Browser: uncaught exception',
    'Browser: unhandled promise rejection',
    'Browser: React render error',
    'Browser: failed API call',
    'Server: thrown exception with stack',
    'Engine-style Python traceback',
    'Engine-style uvicorn ASGI error',
  ];
  for (const label of labels) {
    const button = byText('button', label);
    assert.ok(button, label);
    assert.equal(button.type, 'button');
    const described = button
      .getAttribute('aria-describedby')
      .split(' ')
      .map((id) => document.getElementById(id));
    assert.ok(described.every(Boolean), `${label} points at its help and status`);
  }
  for (const id of ['uncaught', 'rejection', 'render', 'api', 'server', 'python', 'asgi']) {
    assert.equal(statusOf(id).getAttribute('role'), 'status');
    assert.equal(statusOf(id).getAttribute('aria-live'), 'polite');
  }
  assert.ok(byText('button', 'Open error review'));
  assert.ok(byText('button', 'Delete test errors'));
});

test('server and engine buttons post the confirmed request and report Sent', async (t) => {
  const { state, byText, click, statusOf } = await mount(t);
  await click(byText('button', 'Server: thrown exception with stack'));
  await click(byText('button', 'Engine-style Python traceback'));
  await click(byText('button', 'Engine-style uvicorn ASGI error'));
  assert.deepEqual(
    state.requests.map((request) => [request.route, request.body]),
    [
      ['/api/errors/test/server', { confirm: 'emit-test-error' }],
      ['/api/errors/test/python', { confirm: 'emit-test-error', variant: 'traceback' }],
      ['/api/errors/test/python', { confirm: 'emit-test-error', variant: 'asgi' }],
    ],
  );
  for (const request of state.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['X-Forge-Request'], 'errors');
  }
  for (const id of ['server', 'python', 'asgi']) {
    assert.match(statusOf(id).textContent, /^Sent\. The studio saved it/);
  }
});

test('failures are explained: an old studio without the routes, and a rate limit', async (t) => {
  const { byText, click, statusOf } = await mount(t, {
    responses: {
      '/api/errors/test/server': { status: 404, data: { error: 'Not found.' } },
      '/api/errors/test/python': {
        status: 429,
        data: { error: 'Too many test errors. Wait a minute and try again.' },
      },
    },
  });
  await click(byText('button', 'Server: thrown exception with stack'));
  await click(byText('button', 'Engine-style Python traceback'));
  assert.match(statusOf('server').textContent, /^Failed: .*Restart the studio/);
  assert.match(statusOf('python').textContent, /^Failed: Too many test errors/);
  assert.ok(!/^Sent/.test(statusOf('python').textContent));
});

test('the failed API call button gets HTTP 500 and the fetch wrapper reports it', async (t) => {
  const { state, byText, click, statusOf } = await mount(t, {
    installCapture: true,
    responses: {
      '/api/errors/test/api-failure': {
        status: 500,
        data: { error: '[Forge test error] Deliberate HTTP 500', code: 'test_api_failure' },
      },
    },
  });
  await click(byText('button', 'Browser: failed API call'), 60);
  assert.equal(state.requests[0].route, '/api/errors/test/api-failure');
  assert.deepEqual(state.requests[0].body, { confirm: 'emit-test-error' });
  const report = state.reports.find((entry) => entry.kind === 'fetch');
  assert.ok(report, 'the 500 was reported');
  assert.equal(
    report.message,
    'POST /api/errors/test/api-failure failed with HTTP 500: [Forge test error] Deliberate HTTP 500',
  );
  assert.deepEqual(report.context, {
    method: 'POST',
    path: '/api/errors/test/api-failure',
    status: 500,
  });
  assert.match(statusOf('api').textContent, /^Sent\. The studio saved it/);
});

test('a different failure of the test route is an error, not a Sent', async (t) => {
  const { byText, click, statusOf } = await mount(t, {
    responses: { '/api/errors/test/api-failure': { status: 403, data: { error: 'Local only.' } } },
  });
  await click(byText('button', 'Browser: failed API call'));
  assert.equal(statusOf('api').textContent, 'Failed: Local only.');
});

test('the uncaught exception button throws from a timer with a real stack', async (t) => {
  const { state, byText, click } = await mount(t);
  await click(byText('button', 'Browser: uncaught exception'), 60);
  assert.equal(state.errorEvents.length, 1);
  const [thrown] = state.errorEvents;
  assert.match(thrown.message, /^\[Forge test error\] Browser uncaught exception from a timer/);
  assert.match(thrown.stack, /throwTestException/);
  assert.match(thrown.stack, /:\d+:\d+/);
});

test('the rejection button leaves a rejected promise nobody handles', async (t) => {
  const { byText, click } = await mount(t);
  // A real unhandled rejection would fail this test process, so Promise.reject is observed instead.
  const originalReject = Promise.reject;
  const rejected = [];
  Promise.reject = (reason) => {
    rejected.push(reason);
    return originalReject.call(Promise, reason).catch(() => {});
  };
  try {
    await click(byText('button', 'Browser: unhandled promise rejection'));
  } finally {
    Promise.reject = originalReject;
  }
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0] instanceof Error);
  assert.match(rejected[0].message, /^\[Forge test error\] Browser unhandled promise rejection/);
});

test('the render error stays inside the sandbox, is reported once, and can be reset', async (t) => {
  const { state, byText, click, statusOf } = await mount(t, { installCapture: true });
  const sandbox = document.querySelector('.error-test-sandbox');
  assert.match(sandbox.textContent, /The sandbox is healthy/);
  await click(byText('button', 'Browser: React render error'), 80);
  assert.match(sandbox.textContent, /Could not open the error test sandbox/);
  assert.ok(sandbox.querySelector('[role="alert"]'), 'the real boundary fallback is shown');
  assert.ok(byText('button', 'Browser: failed API call'), 'the rest of the page still renders');
  assert.equal(state.caughtEvents.length, 1, 'the boundary announces the error once');
  assert.match(state.caughtEvents[0].componentStack, /BrokenTestWidget/);
  assert.equal(state.caughtEvents[0].name, 'the error test sandbox');
  const boundaryReports = state.reports.filter((report) => report.kind === 'boundary');
  assert.equal(boundaryReports.length, 1, 'and it is reported once');
  assert.match(
    boundaryReports[0].message,
    /^Error: \[Forge test error\] Browser React render error/,
  );
  assert.match(boundaryReports[0].componentStack, /BrokenTestWidget/);
  assert.equal(boundaryReports[0].context.boundary, 'the error test sandbox');
  assert.equal(state.errorEvents.length, 0, 'a caught render error is not also an uncaught error');
  assert.match(statusOf('render').textContent, /^Sent\. The studio saved it/);
  await click(byText('button', 'Reset sandbox'));
  assert.match(sandbox.textContent, /The sandbox is healthy/);
  assert.equal(sandbox.querySelector('[role="alert"]'), null);
});

test('a browser trigger the studio does not confirm says so instead of claiming success', async (t) => {
  const { byText, click, statusOf } = await mount(t, { installCapture: false });
  await click(byText('button', 'Browser: uncaught exception'), 4300);
  assert.match(statusOf('uncaught').textContent, /^Sent, but the studio has not confirmed/);
});

test('Delete test errors asks first, then removes only after the confirmation', async (t) => {
  const { state, byText, click, calls } = await mount(t, {
    responses: { '/api/errors/test/delete': { status: 200, data: { removed: 3 } } },
  });
  const status = () => document.querySelector('.error-test-actions + .error-test-status');
  await click(byText('button', 'Delete test errors'));
  assert.equal(state.requests.length, 0, 'nothing is sent by the first click');
  const group = document.querySelector('[role="group"][aria-label="Confirm deleting test errors"]');
  assert.match(group.textContent, /Real errors are kept/);
  assert.equal(document.activeElement, byText('button', 'Yes, delete test errors'));
  await click(byText('button', 'Cancel'));
  assert.equal(state.requests.length, 0);
  assert.ok(byText('button', 'Delete test errors'));
  await click(byText('button', 'Delete test errors'));
  await click(byText('button', 'Yes, delete test errors'));
  assert.deepEqual(state.requests[0].body, { confirm: 'delete-test-errors' });
  assert.equal(state.requests[0].route, '/api/errors/test/delete');
  assert.equal(status().textContent, 'Deleted 3 test errors. Real errors were kept.');
  assert.equal(status().getAttribute('role'), 'status');
  await click(byText('button', 'Open error review'));
  assert.equal(calls.openErrors, 1);
});
