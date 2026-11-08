import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { JSDOM } from 'jsdom';
import { settingsService } from '../runtime/settings-service.js';
import { loadJsx } from './fixtures/load-jsx.js';

// React DOM decides at import time whether the platform supports the `input` event, so a DOM
// must exist before it loads. Each test then mounts into a fresh DOM of its own.
const bootstrap = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mounts the real section against the real /api/settings routes (temporary runtime folder, no
// engine, no model). `intercept` can answer a request itself to simulate a failing server.
async function mount(t, { env = {}, intercept } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-behaviour-ui-'));
  const service = settingsService({
    runtimeDir: directory,
    env,
    power: { get: () => false, set: async () => {} },
  });
  const app = express();
  const server = createServer(app);
  service.configureServer({ middlewares: app, httpServer: server, config: {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : null,
    });
    const answered = await intercept?.(url, options);
    if (answered) {
      return answered;
    }
    // A browser adds the Origin header itself; Node's fetch does not.
    return previous.fetch(`${base}${url}`, {
      ...options,
      headers: { ...options.headers, Origin: base },
    });
  };
  const { module, cleanup } = await loadJsx('StudioBehaviourSettings.jsx');
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(module.default));
  });
  t.after(async () => {
    await act(async () => root.unmount());
    await cleanup();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    if (previous.navigator) {
      Object.defineProperty(globalThis, 'navigator', previous.navigator);
    }
    dom.window.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const settle = (ms = 40) => act(async () => sleep(ms));
  await settle();
  return { container, dom, requests };
}

const row = (container, key) => container.querySelector(`[data-setting="${key}"]`);
const press = (dom, element) =>
  act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(60);
  });
async function typeInto(dom, input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(
      input,
      value,
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
const resetButton = (container, key) => row(container, key).querySelector('.behaviour-reset');

test('lists every setting by group with labelled controls and an effect badge', async (t) => {
  const { container, requests } = await mount(t);
  assert.equal(requests[0].url, '/api/settings');
  assert.equal(requests[0].method, 'GET');
  const groups = [
    ...container.querySelectorAll('details.behaviour-group > summary > span:first-child'),
  ];
  assert.deepEqual(
    groups.map((item) => item.textContent),
    ['Engines', 'Memory', 'Render queue', 'Speech', 'AI assist', 'Interface', 'Studio app'],
  );
  assert.equal(container.querySelector('details.behaviour-group').open, true);

  const trellis = row(container, 'engines.autoStart.trellis');
  const toggle = trellis.querySelector('input[type="checkbox"]');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.checked, true);
  assert.equal(trellis.querySelector('label').textContent, 'Start TRELLIS.2 on demand');
  assert.equal(trellis.querySelector('.behaviour-badge').textContent, 'Next render');
  assert.equal(
    row(container, 'asr.latencyMs').querySelector('.behaviour-badge').textContent,
    'Restart needed',
  );
  assert.equal(
    row(container, 'ai.errorFix.model').querySelector('.behaviour-badge').textContent,
    'Applies now',
  );

  const describedBy = toggle.getAttribute('aria-describedby').split(' ');
  assert.ok(describedBy.length >= 2);
  for (const id of describedBy) {
    assert.ok(container.ownerDocument.getElementById(id), `description ${id} exists`);
  }
  assert.match(trellis.textContent, /Using the default · Default: On/);
  assert.equal(container.querySelectorAll('[data-setting]').length >= 25, true);
  // No credential fields, and the resets are disabled while a value is the default.
  assert.equal(container.querySelectorAll('input[type="password"]').length, 0);
  assert.equal(resetButton(container, 'engines.autoStart.trellis').disabled, true);
  const select = row(container, 'memory.hostPolicy').querySelector('select');
  assert.deepEqual(
    [...select.options].map((option) => option.value),
    ['soft', 'strict'],
  );
});

test('a switch saves at once, keeps focus and says when the change applies', async (t) => {
  const { container, dom, requests } = await mount(t);
  const trellis = row(container, 'engines.autoStart.trellis');
  const toggle = trellis.querySelector('input[type="checkbox"]');
  toggle.focus();
  await press(dom, toggle);
  const write = requests.find((item) => item.method === 'POST');
  assert.equal(write.url, '/api/settings');
  assert.equal(write.headers['X-Forge-Request'], 'settings');
  assert.deepEqual(write.body, {
    changes: [{ key: 'engines.autoStart.trellis', value: false }],
    via: 'ui',
  });
  const after = row(container, 'engines.autoStart.trellis');
  assert.equal(after.querySelector('input').checked, false);
  assert.match(after.textContent, /Changed by you · Default: On/);
  assert.equal(container.ownerDocument.activeElement, after.querySelector('input'));
  assert.match(
    container.querySelector('.credential-message').textContent,
    /Saved Start TRELLIS\.2 on demand\. It applies to the next render\./,
  );
  assert.equal(resetButton(container, 'engines.autoStart.trellis').disabled, false);
  assert.match(
    container.querySelector('.behaviour-recent').textContent,
    /Start TRELLIS\.2 on demand: true → false \(Studio/,
  );
});

test('a setting locked by the environment is disabled and names the variable', async (t) => {
  const { container, dom, requests } = await mount(t, {
    env: { FORGE_HOST_MEMORY_POLICY: 'strict' },
  });
  const locked = row(container, 'memory.hostPolicy');
  assert.equal(locked.querySelector('select').disabled, true);
  assert.equal(locked.querySelector('select').value, 'strict');
  assert.match(locked.textContent, /Locked by the environment variable FORGE_HOST_MEMORY_POLICY/);
  assert.match(locked.textContent, /Current value: strict/);
  assert.equal(resetButton(container, 'memory.hostPolicy').disabled, true);
  await press(dom, resetButton(container, 'memory.hostPolicy'));
  assert.equal(
    requests.some((item) => item.method === 'POST'),
    false,
  );
});

test('reset is gated: confirm or cancel, Escape closes, focus returns', async (t) => {
  const { container, dom, requests } = await mount(t);
  await press(dom, row(container, 'queue.chainUnload').querySelector('input'));
  assert.equal(row(container, 'queue.chainUnload').querySelector('input').checked, false);

  await press(dom, resetButton(container, 'queue.chainUnload'));
  let group = row(container, 'queue.chainUnload').querySelector('.reset-confirm');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), 'Confirm reset');
  assert.match(group.textContent, /Reset Free the first model of a chained render\?/);
  assert.equal(requests.filter((item) => item.url === '/api/settings/reset').length, 0);
  assert.equal(container.ownerDocument.activeElement.textContent, 'Yes, reset');

  await act(async () => {
    group.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(20);
  });
  assert.equal(row(container, 'queue.chainUnload').querySelector('.reset-confirm'), null);
  assert.equal(container.ownerDocument.activeElement, resetButton(container, 'queue.chainUnload'));

  await press(dom, resetButton(container, 'queue.chainUnload'));
  group = row(container, 'queue.chainUnload').querySelector('.reset-confirm');
  await press(
    dom,
    [...group.querySelectorAll('button')].find((button) => button.textContent === 'Cancel'),
  );
  assert.equal(requests.filter((item) => item.url === '/api/settings/reset').length, 0);

  await press(dom, resetButton(container, 'queue.chainUnload'));
  group = row(container, 'queue.chainUnload').querySelector('.reset-confirm');
  await press(
    dom,
    [...group.querySelectorAll('button')].find((button) => button.textContent === 'Yes, reset'),
  );
  const reset = requests.find((item) => item.url === '/api/settings/reset');
  assert.deepEqual(reset.body, { key: 'queue.chainUnload', via: 'ui' });
  assert.equal(reset.headers['X-Forge-Request'], 'settings');
  assert.equal(row(container, 'queue.chainUnload').querySelector('input').checked, true);
  assert.equal(resetButton(container, 'queue.chainUnload').disabled, true);
});

test('a number field checks its range inline, then saves a valid value', async (t) => {
  const { container, dom, requests } = await mount(t);
  const field = row(container, 'vegetation.timeoutMs');
  const input = field.querySelector('input[type="number"]');
  assert.equal(input.min, '10000');
  assert.equal(input.max, '1800000');
  assert.equal(input.value, '120000');
  const save = field.querySelector('button[type="submit"]');
  assert.equal(save.disabled, true, 'nothing to save yet');

  await typeInto(dom, input, '5');
  assert.equal(save.disabled, false);
  await act(async () => {
    field
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(20);
  });
  const error = row(container, 'vegetation.timeoutMs').querySelector('[role="alert"]');
  assert.equal(error.textContent, 'Enter a whole number from 10000 to 1800000.');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.ok(input.getAttribute('aria-describedby').includes(error.id));
  assert.equal(
    requests.some((item) => item.method === 'POST'),
    false,
    'nothing was sent',
  );

  await typeInto(dom, input, '30000');
  assert.equal(row(container, 'vegetation.timeoutMs').querySelector('[role="alert"]'), null);
  await press(dom, save);
  const write = requests.find((item) => item.method === 'POST');
  assert.deepEqual(write.body.changes, [{ key: 'vegetation.timeoutMs', value: 30000 }]);
  assert.equal(row(container, 'vegetation.timeoutMs').querySelector('input').value, '30000');
  assert.match(row(container, 'vegetation.timeoutMs').textContent, /Changed by you/);
});

test('a select saves its choice and a text field rejects an unusable model id', async (t) => {
  const { container, dom, requests } = await mount(t);
  const latency = row(container, 'asr.latencyMs').querySelector('select');
  await act(async () => {
    latency.value = '560';
    latency.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await sleep(60);
  });
  const write = requests.find((item) => item.method === 'POST');
  assert.deepEqual(write.body.changes, [{ key: 'asr.latencyMs', value: 560 }]);
  assert.match(
    container.querySelector('.credential-message').textContent,
    /Restart needed to apply it/,
  );

  const model = row(container, 'ai.errorFix.model');
  const input = model.querySelector('input[type="text"]');
  await typeInto(dom, input, 'has spaces');
  await act(async () => {
    model
      .querySelector('form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(60);
  });
  // The server's answer is shown on the row, next to the field.
  assert.match(
    row(container, 'ai.errorFix.model').querySelector('[role="alert"]').textContent,
    /Use a model id of 1 to 80 letters/,
  );
  assert.equal(
    requests.filter((item) => item.method === 'POST').at(-1).body.changes[0].value,
    'has spaces',
  );
});

test('a refused change shows the server message on its row and changes nothing', async (t) => {
  const { container, dom } = await mount(t, {
    intercept: async (url, options) =>
      options.method === 'POST' && url === '/api/settings'
        ? new Response(
            JSON.stringify({
              error: 'invalid',
              code: 'invalid_value',
              problems: [
                { key: 'tray.enabled', code: 'invalid_value', message: 'Not allowed here.' },
              ],
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        : null,
  });
  const tray = row(container, 'tray.enabled').querySelector('input');
  await press(dom, tray);
  assert.equal(
    row(container, 'tray.enabled').querySelector('[role="alert"]').textContent,
    'Not allowed here.',
  );
  assert.equal(row(container, 'tray.enabled').querySelector('input').checked, true);
});

test('a failed load shows an alert and Retry loads the list', async (t) => {
  let failures = 1;
  const { container, dom } = await mount(t, {
    intercept: async (url) =>
      url === '/api/settings' && failures-- > 0
        ? new Response(JSON.stringify({ error: 'The settings service failed.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        : null,
  });
  assert.equal(
    container.querySelector('[role="alert"]').textContent,
    'The settings service failed.',
  );
  assert.equal(container.querySelectorAll('[data-setting]').length, 0);
  await press(
    dom,
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Retry'),
  );
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.ok(container.querySelectorAll('[data-setting]').length >= 25);
});

test('every control has an accessible name and none is a credential field', async (t) => {
  const { container } = await mount(t);
  const controls = [...container.querySelectorAll('input, select, button, summary')];
  for (const control of controls) {
    const name =
      control.getAttribute('aria-label') ||
      control.textContent.trim() ||
      container.ownerDocument.querySelector(`label[for="${control.id}"]`)?.textContent.trim() ||
      control.closest('label')?.textContent.trim();
    assert.ok(name, `unnamed control: ${control.outerHTML.slice(0, 120)}`);
  }
  const text = container.textContent;
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8}/);
  assert.equal(
    container.querySelectorAll('input[type="password"], input[autocomplete="new-password"]').length,
    0,
  );
});
