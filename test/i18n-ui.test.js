import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { createServer } from 'vite';
import { loadJsx } from './fixtures/load-jsx.js';
import { I18nProvider, LOCALE_STORAGE_KEY, T, i18n, useT } from '../src/i18n/index.js';
import { tooltipKey } from '../src/i18n/message-format.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const h = React.createElement;

// react-dom decides at import time whether a DOM exists, so it is imported after jsdom is set up.
async function createRoot(container) {
  const client = await import('react-dom/client');
  return client.createRoot(container);
}

function installDom(t) {
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><body><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    },
  );
  const previous = {};
  const set = (name, value) => {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  set('window', dom.window);
  set('document', dom.window.document);
  set('navigator', dom.window.navigator);
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  set('Node', dom.window.Node);
  set('NodeFilter', dom.window.NodeFilter);
  set('MutationObserver', dom.window.MutationObserver);
  set('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 1, height: 1 }];
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
  });
  t.after(() => {
    i18n.setLocale('en');
    i18n.setShowOriginal(false);
    i18n.setLoaders([]);
    dom.window.close();
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  });
  return dom;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fakeStudio({ catalogs = {}, preview, events = [] } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url, 'http://localhost');
    requests.push({ path: parsed.pathname, search: parsed.search, init });
    if (parsed.pathname === '/api/i18n/preference') {
      return jsonResponse(init.method === 'POST' ? JSON.parse(init.body) : { locale: null });
    }
    if (parsed.pathname === '/api/i18n/catalog') {
      const namespace = parsed.searchParams.get('ns');
      return jsonResponse({
        entries: catalogs[namespace] || {},
        machine: catalogs.machine || null,
      });
    }
    if (parsed.pathname === '/api/i18n/languages') {
      return jsonResponse({ languages: [{ code: 'de', name: 'German', nativeName: 'Deutsch' }] });
    }
    if (parsed.pathname === '/api/i18n/preview') {
      return jsonResponse(preview);
    }
    if (parsed.pathname === '/api/i18n/translate') {
      return new Response(events.map((event) => JSON.stringify(event)).join('\n'), {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }
    return jsonResponse({ error: 'Not found.' }, 404);
  };
  return { fetchImpl, requests };
}

test('provider applies the saved locale, lang/dir, rich text and lazy catalogs', async (t) => {
  const dom = installDom(t);
  dom.window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
  const studio = fakeStudio({
    catalogs: {
      images: {
        'images.demo.title': { value: 'إنشاء صورة', source: 'Create an image', kind: 'machine' },
        'images.demo.help': {
          value: 'افتح <link>الإعدادات</link> يا {name}.',
          source: 'Open <link>Settings</link>, {name}.',
          kind: 'machine',
        },
      },
      machine: { model: 'gpt-6-luna', translatedAt: '2026-11-08T00:00:00Z' },
    },
  });
  function Demo() {
    const { t } = useT();
    return h(
      'div',
      null,
      h('h1', null, t('images.demo.title', 'Create an image')),
      h(
        'p',
        null,
        h(T, {
          id: 'images.demo.help',
          en: 'Open <link>Settings</link>, {name}.',
          params: { name: h('em', null, 'Ana') },
          components: { link: h('a', { href: '?dialog=settings' }) },
        }),
      ),
    );
  }
  const root = await createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(h(I18nProvider, { fetchImpl: studio.fetchImpl }, h(Demo)));
  });
  await act(async () => {
    await wait(20);
  });
  assert.equal(document.documentElement.lang, 'ar');
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(document.querySelector('h1').textContent, 'إنشاء صورة');
  const link = document.querySelector('p a');
  assert.equal(link.getAttribute('href'), '?dialog=settings');
  assert.equal(link.textContent, 'الإعدادات');
  assert.equal(document.querySelector('p em').textContent, 'Ana');
  assert.equal(
    studio.requests.filter((request) => request.path === '/api/i18n/catalog').length,
    1,
    'one namespace loaded once',
  );
  assert.ok(!studio.requests.some((request) => request.path === '/api/i18n/preference'));

  await act(async () => i18n.setLocale('en'));
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.documentElement.dir, 'ltr');
  assert.equal(document.querySelector('h1').textContent, 'Create an image');
  assert.equal(document.querySelector('p').textContent, 'Open Settings, Ana.');
  await act(async () => root.unmount());
});

test('without a provider components render the English defaults and fetch nothing', async (t) => {
  installDom(t);
  let fetched = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched += 1;
    throw Error('no network in this test');
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const { module, cleanup } = await loadJsx('ForceStopDialog.jsx');
  t.after(cleanup);
  const root = await createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(
      h(module.default, {
        name: 'Mammoth service',
        working: false,
        result: { interruptedJobId: 'job-1' },
        error: '',
        onClose() {},
        onForceStop() {},
      }),
    ),
  );
  const text = document.querySelector('[role="dialog"]').textContent;
  assert.match(text, /^Emergency controlService stopped/);
  assert.match(text, /The affected render is marked interrupted\. Review it in the render queue/);
  assert.equal(document.querySelector('[role="dialog"] strong').textContent, 'interrupted');
  assert.equal(fetched, 0);
  await act(async () => root.unmount());
});

test('field help finds English tooltips from translated labels and translates them', async (t) => {
  const dom = installDom(t);
  const server = await createServer({
    root: repositoryRoot,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    esbuild: { jsx: 'automatic' },
  });
  t.after(() => server.close());
  const { default: FieldHelp } = await server.ssrLoadModule('/src/tooltips/FieldHelp.jsx');
  const { i18n: store } = await server.ssrLoadModule('/src/i18n/index.js');
  t.after(() => {
    store.setLocale('en');
    store.setLoaders([]);
  });
  store.setLoaders([
    async (_locale, namespace) => ({
      entries:
        namespace === 'images'
          ? {
              'images.form.seed': 'Startwert',
              [tooltipKey('images', 'Seed')]: 'Ein Startwert wiederholt ein Ergebnis.',
            }
          : { 'common.fieldHelp.button': 'Hilfe: {name}' },
    }),
  ]);
  store.setLocale('de');
  store.t('images.form.seed', 'Seed');
  store.t('common.fieldHelp.button', 'Help: {name}', { name: 'x' });
  await wait(10);
  // The label shows the translation produced by t(); field help maps it back to "Seed".
  const shell = dom.window.document.createElement('div');
  shell.className = 'app-shell';
  shell.innerHTML = `<label id="seed-label">${store.t('images.form.seed', 'Seed')} <span>OPTIONAL</span><input id="seed" /></label>`;
  dom.window.document.body.prepend(shell);
  const root = await createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      h(FieldHelp, {
        section: 'images',
        tooltips: { common: {}, images: { Seed: 'A seed repeats a result.' } },
      }),
    );
  });
  await act(async () => {
    await wait(400);
  });
  const button = document.querySelector('#seed-label .field-help-trigger');
  assert.ok(button, 'help button found for the translated label');
  assert.equal(button.getAttribute('aria-label'), 'Hilfe: Startwert');
  assert.equal(
    document.getElementById('seed').getAttribute('aria-description'),
    'Ein Startwert wiederholt ein Ergebnis.',
  );
  await act(async () => root.unmount());
});

test('language menu and translate dialog: preview, send, progress, report, focus and Escape', async (t) => {
  installDom(t);
  const preview = {
    lang: 'de',
    languageName: 'German',
    nativeName: 'Deutsch',
    dir: 'ltr',
    namespaces: [{ namespace: 'images', total: 4, cached: 0, stale: 0, missing: 4, overrides: 0 }],
    strings: 4,
    characters: 61,
    requests: 1,
    model: 'gpt-6-luna',
    provider: 'openai',
    hasKey: true,
    digest: 'digest-1',
  };
  const studio = fakeStudio({
    preview,
    events: [
      { type: 'start', total: 4, requests: 1 },
      { type: 'progress', done: 4, total: 4, translated: 3, keptEnglish: 1 },
      {
        type: 'done',
        report: {
          lang: 'de',
          model: 'gpt-6-luna',
          total: 4,
          translated: 3,
          keptEnglish: 1,
          notTranslated: 0,
          rejected: [{ key: 'images.form.save', reason: 'placeholder' }],
          reasons: { placeholder: 1 },
          error: null,
        },
      },
    ],
  });
  const { module, cleanup } = await loadJsx('i18n/LanguageMenu.jsx');
  t.after(cleanup);
  let location;
  function Spy() {
    location = useLocation();
    return null;
  }
  const root = await createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      h(
        I18nProvider,
        { fetchImpl: studio.fetchImpl, storage: null },
        h(
          MemoryRouter,
          { initialEntries: ['/images'] },
          h(
            Routes,
            null,
            h(Route, {
              path: '/:section',
              element: h(React.Fragment, null, h(module.default, { section: 'images' }), h(Spy)),
            }),
          ),
        ),
      ),
    );
  });
  const menuButton = document.querySelector('.language-menu-button');
  assert.equal(menuButton.getAttribute('aria-label'), 'Language: English');
  await act(async () => menuButton.click());
  await act(async () => {
    await wait(10);
  });
  const options = [...document.querySelectorAll('.language-menu-option')].map(
    (item) => item.textContent,
  );
  assert.deepEqual(options, ['English', 'Deutsch (German)']);
  assert.ok(!options.some((text) => text.includes('Pseudo')), 'pseudo-locale hidden outside dev');
  const translateButton = [...document.querySelectorAll('.language-menu-panel button')].find(
    (button) => button.textContent === 'Translate this page with ChatGPT…',
  );
  await act(async () => translateButton.click());
  assert.equal(new URLSearchParams(location.search).get('dialog'), 'translate');

  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(
    document.getElementById(dialog.getAttribute('aria-labelledby')).textContent,
    'Translate this page',
  );
  assert.ok(document.activeElement.classList.contains('translate-search'), 'search has focus');

  // Search, pick German and review the preview.
  const search = document.activeElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, 'deut');
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const languages = [...dialog.querySelectorAll('.translate-language-option')];
  assert.equal(languages.length, 1);
  await act(async () => languages[0].querySelector('input').click());
  await act(async () => dialog.querySelector('form').requestSubmit());
  await act(async () => {
    await wait(10);
  });
  assert.match(dialog.textContent, /What will be sent/);
  assert.match(
    dialog.textContent,
    /4 interface strings \(61 characters\) in 1 requests to OpenAI, model gpt-6-luna, for Deutsch \(German\)\./,
  );
  assert.match(
    dialog.textContent,
    /Projects, prompts, file names, assets and anything you typed are never sent/,
  );
  const previewRequest = studio.requests.find((request) => request.path === '/api/i18n/preview');
  assert.deepEqual(JSON.parse(previewRequest.init.body), {
    lang: 'de',
    namespaces: ['images', 'shell', 'common', 'settings', 'errors', 'i18n'],
  });

  // Focus stays inside the dialog.
  const focusable = [...dialog.querySelectorAll('button:not(:disabled), input, select')];
  focusable.at(-1).focus();
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  });
  assert.equal(document.activeElement, focusable[0]);

  const send = [...dialog.querySelectorAll('button')].find(
    (button) => button.textContent === 'Send to OpenAI',
  );
  await act(async () => send.click());
  await act(async () => {
    await wait(20);
  });
  const translateRequest = studio.requests.find(
    (request) => request.path === '/api/i18n/translate',
  );
  assert.deepEqual(Object.keys(JSON.parse(translateRequest.init.body)).sort(), [
    'digest',
    'lang',
    'namespaces',
  ]);
  const report = dialog.querySelector('.translate-report');
  assert.equal(report.getAttribute('aria-live'), 'polite');
  assert.match(
    report.textContent,
    /3 strings translated, 1 kept in English: placeholder mismatch \(1\)\./,
  );
  assert.match(
    report.textContent,
    /Machine translated by gpt-6-luna\. Review before relying on it\./,
  );

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(new URLSearchParams(location.search).get('dialog'), null);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await act(async () => root.unmount());
});

test('dialog shows the no-key path with a Settings link and validates typed codes', async (t) => {
  installDom(t);
  const studio = fakeStudio({
    preview: {
      lang: 'tlh',
      languageName: 'Klingon',
      nativeName: 'Klingon',
      dir: 'ltr',
      namespaces: [],
      strings: 3,
      characters: 20,
      requests: 1,
      model: 'gpt-6-luna',
      provider: 'openai',
      hasKey: false,
      digest: 'd',
    },
  });
  const { module, cleanup } = await loadJsx('i18n/TranslatePageDialog.jsx');
  t.after(cleanup);
  let settingsOpened = 0;
  const root = await createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      h(
        I18nProvider,
        { fetchImpl: studio.fetchImpl, storage: null },
        h(module.default, {
          namespaces: ['images'],
          onClose() {},
          onOpenSettings: () => {
            settingsOpened += 1;
          },
        }),
      ),
    );
  });
  const code = document.querySelector('input[maxlength="35"]');
  const type = async (value) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(code, value);
      code.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await type('en-GB');
  assert.match(
    document.querySelector('[aria-live="polite"]').textContent,
    /English is the source language/,
  );
  await type('$$');
  assert.match(
    document.querySelector('[aria-live="polite"]').textContent,
    /not a valid language code/,
  );
  assert.equal(code.getAttribute('aria-invalid'), 'true');
  await type('tlh');
  assert.match(document.querySelector('[aria-live="polite"]').textContent, /tlh is Klingon\./);
  await act(async () => document.querySelector('form').requestSubmit());
  await act(async () => {
    await wait(10);
  });
  assert.match(document.body.textContent, /Add your OpenAI key in Settings before translating\./);
  const send = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Send to OpenAI',
  );
  assert.equal(send.disabled, true);
  const settings = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Open Settings',
  );
  await act(async () => settings.click());
  assert.equal(settingsOpened, 1);
  assert.ok(!studio.requests.some((request) => request.path === '/api/i18n/translate'));
  await act(async () => root.unmount());
});
