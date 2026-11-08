import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('field help is injected inline after the label text, opens a tooltip and cleans up', async () => {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="app-shell">
        <label id="seed-label">Seed <span>OPTIONAL</span><input id="seed" /></label>
        <label id="plain">Steps<select id="steps"><option>1</option></select></label>
        <label id="untipped">No tip here<input id="x" /></label>
      </div>
      <div id="root"></div>
    </body></html>`,
    { pretendToBeVisual: true, url: 'http://localhost/' },
  );
  const previous = {};
  const set = (name, value) => {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  let root;
  let server;
  try {
    set('window', dom.window);
    set('document', dom.window.document);
    set('navigator', dom.window.navigator);
    set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    set('NodeFilter', dom.window.NodeFilter);
    set('Node', dom.window.Node);
    set('MutationObserver', dom.window.MutationObserver);
    set('IS_REACT_ACT_ENVIRONMENT', true);
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
      left: 10,
      top: 10,
      right: 30,
      bottom: 30,
      width: 20,
      height: 20,
    });

    server = await createServer({
      root: repositoryRoot,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null },
      esbuild: { jsx: 'automatic' },
    });
    const { default: FieldHelp } = await server.ssrLoadModule('/src/tooltips/FieldHelp.jsx');

    const container = dom.window.document.getElementById('root');
    root = createRoot(container);
    const tooltips = {
      common: {},
      images: { Seed: 'A seed repeats a result.', Steps: 'More steps.' },
    };
    await act(async () => {
      root.render(React.createElement(FieldHelp, { section: 'images', tooltips }));
    });
    // Discovery is debounced, so give the timer time to fire and React time to commit its result.
    await act(async () => {
      await wait(400);
    });

    const slots = [...dom.window.document.querySelectorAll('.field-help-slot')];
    assert.equal(slots.length, 2, 'only labels that have a tip get a button');
    const seedLabel = dom.window.document.getElementById('seed-label');
    const slot = seedLabel.querySelector('.field-help-slot');
    assert.equal(
      slot.previousElementSibling?.textContent,
      'OPTIONAL',
      'the button follows the REQUIRED/OPTIONAL tag, inside the label',
    );
    const button = slot.querySelector('button.field-help-trigger');
    assert.equal(button.getAttribute('aria-label'), 'Help: Seed');
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.style.position, '', 'help buttons are not positioned from script');
    assert.equal(
      dom.window.document.getElementById('seed').getAttribute('aria-description'),
      'A seed repeats a result.',
    );
    assert.equal(
      dom.window.document.getElementById('untipped').querySelector('.field-help-slot'),
      null,
    );

    await act(async () => button.click());
    const tooltip = dom.window.document.querySelector('[role="tooltip"]');
    assert.equal(tooltip?.textContent, 'A seed repeats a result.');
    assert.equal(button.getAttribute('aria-expanded'), 'true');

    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    assert.equal(dom.window.document.querySelector('[role="tooltip"]'), null);

    await act(async () => root.unmount());
    root = null;
    assert.equal(dom.window.document.querySelectorAll('.field-help-slot').length, 0);
    assert.equal(
      dom.window.document.getElementById('seed').hasAttribute('aria-description'),
      false,
    );
  } finally {
    if (root) {
      await act(async () => root.unmount());
    }
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
    dom.window.close();
    await server?.close();
  }
});
