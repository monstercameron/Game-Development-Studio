import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

test('project and asset deletion require the project name and call separate endpoints', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
    url: 'http://localhost/assets',
  });
  const previous = new Map();
  const calls = [];
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ moved: 2, failures: [] }) };
    },
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    ssr: { noExternal: ['react-router'] },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router');
  const { default: ProjectManagement } = await vite.ssrLoadModule('/src/ProjectManagement.jsx');
  const root = createRoot(document.querySelector('#root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });
  let refreshed = 0;
  let removed = 0;
  await act(async () =>
    root.render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(ProjectManagement, {
          project: { id: 'p', name: 'Example' },
          onChanged: async () => {
            refreshed++;
          },
          onRemoved: async () => {
            removed++;
          },
        }),
      ),
    ),
  );
  const click = async (element) => act(async () => element.click());
  const enterName = async () =>
    act(async () => {
      const input = document.querySelector('.project-management-confirmation input');
      const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
      input[propsKey].onChange({ target: { value: 'Example' } });
    });
  await click(
    [...document.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Delete all project assets'),
    ),
  );
  let confirm = document.querySelector('.studio-confirm-danger');
  assert.equal(confirm.disabled, true);
  await enterName();
  assert.equal(confirm.disabled, false);
  await click(confirm);
  assert.equal(calls[0].url, '/api/projects/p/assets/trash-all');
  assert.equal(calls[0].options.headers['X-Forge-Request'], 'project');
  assert.equal(refreshed, 1);
  assert.equal(removed, 0);
  await click(
    [...document.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Delete project'),
    ),
  );
  confirm = document.querySelector('.studio-confirm-danger');
  assert.equal(confirm.disabled, true);
  await enterName();
  await click(confirm);
  assert.equal(calls[1].url, '/api/runtime/projects/trash');
  assert.deepEqual(JSON.parse(calls[1].options.body), { projectId: 'p', confirmation: 'Example' });
  assert.equal(removed, 1);
});
