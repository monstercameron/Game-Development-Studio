import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const bootstrap = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

test('tray is checked only for completions and an optional timeout falls back without an error report', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/voices',
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let tick;
  globalThis.setInterval = (callback) => {
    tick = callback;
    return 1;
  };
  globalThis.clearInterval = () => {};
  let status = 'running';
  let trayCalls = 0;
  let trayMode = 'timeout';
  const reports = [];
  const notices = [];
  dom.window.addEventListener('forge:completion', (event) => notices.push(event.detail));
  dom.window.fetch = async (input, init = {}) => {
    const route = String(input);
    if (route === '/api/runtime/jobs') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobs: [{ id: '1', type: 'sfx', status, request: {} }] }),
      };
    }
    if (route === '/api/tray/status') {
      trayCalls++;
      if (trayMode === 'timeout') {
        throw new DOMException('signal timed out', 'TimeoutError');
      }
      if (trayMode === 'network') {
        throw new TypeError('tray network down');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ active: true, render: true, queue: true }),
      };
    }
    if (route === '/api/errors/report') {
      reports.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    }
    if (route === '/api/unavailable') {
      throw new TypeError('network down');
    }
    if (route === '/api/slow') {
      throw new DOMException('signal timed out', 'TimeoutError');
    }
    return { ok: true, status: 200 };
  };
  globalThis.fetch = (...args) => dom.window.fetch(...args);
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  const capture = await vite.ssrLoadModule('/src/error-capture.js');
  capture.installErrorCapture(dom.window);
  const { useRuntimeNotifications } = await vite.ssrLoadModule('/src/useRuntimeNotifications.js');
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    dom.window.close();
    globalThis.IS_REACT_ACT_ENVIRONMENT = saved.act;
    Object.assign(globalThis, {
      window: saved.window,
      document: saved.document,
      fetch: saved.fetch,
      Event: saved.Event,
      CustomEvent: saved.CustomEvent,
      setInterval: saved.setInterval,
      clearInterval: saved.clearInterval,
    });
  });
  function Harness() {
    useRuntimeNotifications();
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => tick());
  assert.equal(trayCalls, 0, 'idle polls do not contact the optional tray');
  status = 'completed';
  await act(async () => tick());
  assert.equal(trayCalls, 1);
  assert.deepEqual(
    notices.map((notice) => notice.type),
    ['render', 'queue'],
  );
  assert.equal(reports.length, 0, 'handled optional tray timeout is not a connectivity error');

  status = 'running';
  await act(async () => tick());
  trayMode = 'active';
  status = 'completed';
  await act(async () => tick());
  assert.equal(trayCalls, 2);
  assert.equal(notices.length, 2, 'native tray alerts suppress duplicate browser alerts');

  await assert.rejects(globalThis.fetch('/api/unavailable'), /network down/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 1, 'other network failures remain visible in Errors');
  assert.equal(reports[0].context.path, '/api/unavailable');
  await assert.rejects(globalThis.fetch('/api/slow'), /signal timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports[1].context.path, '/api/slow', 'other endpoint timeouts remain reportable');

  status = 'running';
  await act(async () => tick());
  trayMode = 'network';
  status = 'completed';
  await act(async () => tick());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    reports[2].context.path,
    '/api/tray/status',
    'tray network failures remain reportable',
  );
  assert.deepEqual(
    notices.map((notice) => notice.type),
    ['render', 'queue', 'render', 'queue'],
  );
});
