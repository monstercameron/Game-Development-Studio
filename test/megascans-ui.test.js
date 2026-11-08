import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
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
const { MemoryRouter, useLocation } = await import('react-router');

const LISTINGS = [
  {
    id: '854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
    title: 'Old Wooden Crate',
    url: 'https://www.fab.com/listings/854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
    license: 'Fab Standard License',
    seller: 'Quixel Megascans',
    source: 'fab',
    tags: ['wood', 'prop'],
    fabTags: ['wood', 'prop'],
    userTags: [],
    category: 'Furniture & Fixtures',
    formats: [{ code: 'fbx', name: 'FBX' }],
    sizeMin: 7246865,
    sizeMax: 393280290,
    publishedAt: '2026-10-20T08:55:14.000Z',
    thumbnailUrl: '/api/megascans/thumbs/854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
    detailFetchedAt: '2026-11-01T00:00:00.000Z',
    licenseUrl: 'https://www.fab.com/eula',
    detail: {
      description: 'Rustic crate.',
      recommendedUid: 'aaaaaaaa-0000-4000-8000-000000000001',
      groups: [
        {
          id: 'glb',
          label: 'GLB (one file, recommended)',
          advanced: false,
          files: [
            {
              uid: 'aaaaaaaa-0000-4000-8000-000000000002',
              name: 'crate_low.glb',
              size: 3214116,
              quality: 'low',
              importable: true,
              isLarge: false,
            },
            {
              uid: 'aaaaaaaa-0000-4000-8000-000000000001',
              name: 'crate_mid.glb',
              size: 11421444,
              quality: 'mid',
              importable: true,
              isLarge: false,
            },
            {
              uid: 'aaaaaaaa-0000-4000-8000-000000000003',
              name: 'crate_raw.glb',
              size: 177456356,
              quality: 'raw',
              importable: true,
              isLarge: true,
            },
          ],
        },
        {
          id: 'usdz',
          label: 'USDZ (Forge cannot open this format)',
          advanced: false,
          files: [
            {
              uid: 'aaaaaaaa-0000-4000-8000-000000000004',
              name: 'crate_low.usdz',
              size: 1888007,
              quality: 'low',
              importable: false,
              isLarge: false,
            },
          ],
        },
        {
          id: 'extra',
          label: 'Advanced: extra texture files',
          advanced: true,
          files: [
            {
              uid: 'aaaaaaaa-0000-4000-8000-000000000005',
              name: 'crate_exr_raw.zip',
              size: 1907253724,
              quality: 'raw',
              importable: false,
              isLarge: true,
            },
          ],
        },
      ],
      trianglesMin: 2510,
      trianglesMax: 1000012,
      texturesCount: 9,
      textureResolutionMax: 8192,
    },
    notes: 'For the tavern',
    attribution:
      'Old Wooden Crate by Quixel Megascans (Epic Games), via Fab: https://www.fab.com/listings/854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
  },
  {
    id: '2ff093a2-3380-4b64-bfb7-719600367b20',
    title: 'Jasper Stone',
    url: 'https://www.fab.com/listings/2ff093a2-3380-4b64-bfb7-719600367b20',
    license: 'Fab Standard License',
    seller: 'Quixel Megascans',
    source: 'user',
    tags: ['stone'],
    fabTags: [],
    userTags: ['stone'],
    category: null,
    formats: [],
    sizeMin: null,
    sizeMax: null,
    thumbnailUrl: null,
    detailFetchedAt: null,
    detail: null,
    notes: '',
    attribution: 'Jasper Stone by Quixel Megascans (Epic Games), via Fab',
  },
];
const PROJECT = { id: '0f6bd0a2-5d35-4ef9-a6a0-6a6a3f6d1f11', name: 'My Game' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function importItem(overrides) {
  return {
    id: '3e2d4d09-65f0-4f1a-b81b-c5ac01920a04',
    projectId: PROJECT.id,
    listingId: null,
    filename: 'crate.zip',
    kind: 'archive',
    status: 'queued',
    stage: 'Waiting',
    error: null,
    uploadBytes: 5 * 1024 * 1024,
    bytesDone: 0,
    bytesTotal: 0,
    bytesPerSecond: null,
    secondsRemaining: null,
    cancelRequested: false,
    output: null,
    ...overrides,
  };
}

async function mount(t, { entry = '/megascans', project = PROJECT, state }) {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">x</button><div id="root"></div></body></html>',
    {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
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
    value: { writeText: async (text) => (state.copied = text) },
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.Element.prototype.getClientRects = () => [{ width: 800, height: 600 }];
  dom.window.Element.prototype.getBoundingClientRect = () => ({
    width: 800,
    height: 600,
    top: 0,
    right: 800,
    bottom: 600,
    left: 0,
  });
  state.requests = [];
  state.uploads = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const route = url.pathname.replace('/api/megascans', '');
    state.requests.push({
      method: init.method || 'GET',
      route,
      search: url.search,
      headers: init.headers,
      body: init.body,
    });
    const respond = (status, body) => ({
      ok: status < 300,
      status,
      json: async () => structuredClone(body),
    });
    if (init.method === 'POST' && route === '/downloads/confirm') {
      state.fab.downloads = {
        ...state.fab.downloads,
        confirmed: true,
        acceptedAt: '2026-11-08T12:00:00Z',
      };
      return respond(200, { downloads: state.fab.downloads });
    }
    if (init.method === 'POST' && route === '/downloads/revoke') {
      state.fab.downloads = { ...state.fab.downloads, confirmed: false, acceptedAt: null };
      return respond(200, { downloads: state.fab.downloads });
    }
    if (init.method === 'POST' && route === '/downloads') {
      state.downloadBody = JSON.parse(init.body);
      return respond(201, { import: state.imports?.[0] });
    }
    if (init.method === 'POST' && route === '/more') {
      state.moreCalls = (state.moreCalls || 0) + 1;
      state.listings = [...state.listings, ...(state.moreListings || [])];
      state.fab.cache.hasMore = Boolean(state.moreHasMore);
      return respond(200, { added: (state.moreListings || []).length, updated: 0, fab: state.fab });
    }
    if (init.method === 'POST' && route === '/refresh') {
      return respond(200, { added: 1, updated: 0, fab: state.fab });
    }
    if (init.method === 'POST' && route === '/scan') {
      state.scanBody = JSON.parse(init.body);
      state.fab.scan = { ...state.fab.scan, status: 'running' };
      return respond(202, { scan: { ...state.fab.scan, status: 'running' } });
    }
    if (init.method === 'POST' && /\/listings\/[^/]+\/refresh$/.test(route)) {
      state.detailBody = JSON.parse(init.body || '{}');
      if (state.detailFails) {
        return respond(503, { error: 'Fab is blocking automated requests.', blocked: true });
      }
      return respond(200, {
        listing: { ...state.listings[1], detailFetchedAt: 'now', detail: { description: 'Read.' } },
      });
    }
    if (init.method === 'POST') {
      if (state.postFails) {
        return respond(400, { error: 'Enter a title for this listing.' });
      }
      return respond(200, { listing: LISTINGS[0], import: state.imports?.[0] });
    }
    if (route === '/listings') {
      if (state.listingsError) {
        return respond(500, { error: 'Database is locked.' });
      }
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const tag = url.searchParams.get('tag') || '';
      const listings = state.listings.filter(
        (item) => (!q || item.title.toLowerCase().includes(q)) && (!tag || item.tags.includes(tag)),
      );
      const size = Number(url.searchParams.get('pageSize') || 24);
      const page = Number(url.searchParams.get('page') || 1);
      state.listingRequests = [...(state.listingRequests || []), { page, size }];
      return respond(200, {
        listings: listings.slice((page - 1) * size, page * size),
        total: listings.length,
        page,
        pageSize: size,
        pageCount: Math.max(Math.ceil(listings.length / size), 1),
        tags: [
          { tag: 'prop', count: 1 },
          { tag: 'stone', count: 1 },
          { tag: 'wood', count: 1 },
        ],
      });
    }
    if (route === '/status') {
      return respond(200, { fab: state.fab });
    }
    if (route === '/imports') {
      return respond(200, {
        imports: state.imports,
        summary: { running: 1, queued: 1, failed: 1, completed: 1, maxConcurrent: 2 },
      });
    }
    const detail = /^\/listings\/(.+)$/.exec(route);
    if (detail) {
      const listing = state.listings.find((item) => item.id === detail[1]);
      return listing
        ? respond(200, { listing, imports: [] })
        : respond(404, { error: 'Listing not found.' });
    }
    return respond(404, { error: 'Not found.' });
  };
  class FakeXhr {
    constructor() {
      this.upload = {};
      this.headers = {};
      state.uploads.push(this);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    send(file) {
      this.file = file;
    }

    abort() {
      this.onabort?.();
    }
  }
  globalThis.XMLHttpRequest = FakeXhr;
  const { module, cleanup } = await loadJsx('Megascans.jsx');
  const location = { current: '' };
  function Probe() {
    const here = useLocation();
    location.current = here.pathname + here.search;
    return null;
  }
  const selected = [];
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        React.createElement(Probe),
        React.createElement(module.default, {
          project,
          projects: [PROJECT],
          onSelect: (id) => selected.push(id),
          onRefresh: () => {},
          onOpenLibrary: () => selected.push('library'),
        }),
      ),
    );
  });
  t.after(async () => {
    await act(async () => root.unmount());
    await cleanup();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.XMLHttpRequest = previous.XMLHttpRequest;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    if (previous.navigator) {
      Object.defineProperty(globalThis, 'navigator', previous.navigator);
    }
    dom.window.close();
  });
  const settle = async (ms = 20) => act(async () => sleep(ms));
  await settle();
  return { dom, root, location, selected, settle, container: document.getElementById('root') };
}

const idleScan = {
  status: 'idle',
  cursor: '',
  pagesThisRun: 0,
  pagesTotal: 0,
  listingsSeen: 0,
  maxPages: 10,
  reachedEnd: false,
  error: null,
};
const freshFab = () => ({
  block: null,
  downloads: {
    confirmed: false,
    acceptedAt: null,
    eulaUrl: 'https://www.fab.com/eula',
  },
  cache: {
    listings: 2,
    fetchedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    stale: false,
  },
  scan: { ...idleScan },
});
async function until(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) {
    await act(async () => sleep(100));
  }
}

const baseState = () => ({ listings: LISTINGS, imports: [], fab: freshFab() });
const byText = (container, selector, text) =>
  [...container.querySelectorAll(selector)].find((element) => element.textContent.includes(text));

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

test('the page lists cached models and keeps search, tag, sort and page in the URL', async (t) => {
  const state = baseState();
  const { container, location, settle } = await mount(t, { state });
  assert.match(container.querySelector('h1').textContent, /Megascans/);
  assert.equal(container.querySelectorAll('.megascans-card').length, 2);
  assert.match(container.textContent, /Cached 3 h ago · 2 listings from Fab/);
  assert.match(
    container.textContent,
    /Fab data is fetched slowly and cached locally; downloads start only after you confirm Fab.s license agreement/,
  );
  assert.ok(
    container.querySelector('.megascans-card img[loading="lazy"]'),
    'thumbnails load lazily from the local cache',
  );

  // The primary Fab link is external, opens a new tab and cannot reach the opener.
  const browse = container.querySelector('a.megascans-browse');
  assert.equal(browse.getAttribute('target'), '_blank');
  assert.match(browse.getAttribute('rel'), /noopener/);
  assert.match(
    browse.getAttribute('href'),
    /^https:\/\/www\.fab\.com\/sellers\/Quixel%20Megascans/,
  );
  assert.match(browse.getAttribute('href'), /listing_types=3d-model/);

  await type(container.querySelector('#megascans-search'), 'crate');
  await settle(350);
  assert.match(location.current, /q=crate/);
  assert.equal(container.querySelectorAll('.megascans-card').length, 1);

  const tag = container.querySelector('#megascans-tag');
  await act(async () => {
    tag.value = 'wood';
    tag.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle();
  assert.match(location.current, /tag=wood/);

  const sort = container.querySelector('#megascans-sort');
  await act(async () => {
    sort.value = 'title';
    sort.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await settle();
  assert.match(location.current, /sort=title/);
});

test('every control is labelled and the Open on Fab links are safe', async (t) => {
  const { container } = await mount(t, { state: baseState() });
  for (const control of container.querySelectorAll('input:not([type="file"]), select, textarea')) {
    assert.ok(
      (control.id && container.querySelector(`label[for="${control.id}"]`)) ||
        control.closest('label'),
      `control ${control.id || control.outerHTML.slice(0, 40)} needs a visible label`,
    );
  }
  const cardLinks = [...container.querySelectorAll('.megascans-card a')];
  assert.equal(cardLinks.length, 2);
  for (const link of cardLinks) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('rel'), /noopener/);
    assert.match(link.getAttribute('aria-label'), /opens in a new tab/);
    assert.match(link.getAttribute('href'), /^https:\/\/www\.fab\.com\/listings\//);
  }
});

test('an error loads inline with a retry, and empty states explain the next step', async (t) => {
  const state = { ...baseState(), listingsError: true };
  const { container, settle } = await mount(t, { state });
  const alert = container.querySelector('.megascans-error[role="alert"]');
  assert.match(alert.textContent, /Could not load models: Database is locked/);
  state.listingsError = false;
  state.listings = [];
  await click(byText(container, 'button', 'Try again'));
  await settle();
  assert.match(container.textContent, /No models are cached yet/);
  assert.match(container.textContent, /Add by address/);
});

test('a search with no matches offers to clear it', async (t) => {
  const { container, location, settle } = await mount(t, {
    state: baseState(),
    entry: '/megascans?q=zzz',
  });
  assert.match(container.textContent, /No cached models match this search/);
  await click(byText(container, 'button', 'Clear search'));
  await settle();
  assert.doesNotMatch(location.current, /q=/);
  assert.equal(container.querySelectorAll('.megascans-card').length, 2);
});

test('the detail dialog is accessible, deep-linkable, closes on Escape and restores focus', async (t) => {
  const { container, location, settle } = await mount(t, { state: baseState() });
  const opener = container.querySelector('.megascans-card-open');
  opener.focus();
  await click(opener);
  await settle();
  assert.match(location.current, /listing=854ffc09/);
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const title = document.getElementById(dialog.getAttribute('aria-labelledby'));
  assert.equal(title.textContent, 'Old Wooden Crate');
  assert.match(dialog.textContent, /Fab Standard License/);
  assert.match(dialog.textContent, /Quixel Megascans \(Epic Games\), via Fab/);
  const fab = dialog.querySelector('a.megascans-get-on-fab');
  assert.equal(fab.getAttribute('href'), LISTINGS[0].url);
  assert.equal(fab.getAttribute('rel'), 'noopener noreferrer');
  assert.ok(dialog.contains(document.activeElement), 'focus moves into the dialog');

  await click(byText(dialog, 'button', 'Copy'));
  assert.match(dialog.textContent, /Attribution copied/);

  await act(async () => {
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  await settle();
  assert.ok(!document.querySelector('[role="dialog"]'), 'the dialog closed');
  assert.doesNotMatch(location.current, /listing=/);
  assert.ok(document.activeElement === opener, 'focus returns to the opener');
});

test('a direct link to a missing listing explains itself', async (t) => {
  const { settle } = await mount(t, {
    state: baseState(),
    entry: '/megascans?listing=11111111-1111-4111-8111-111111111111',
  });
  await settle();
  assert.match(
    document.querySelector('[role="dialog"] [role="alert"]').textContent,
    /no longer in the library/,
  );
});

test('adding a listing validates inline before it posts, then sends the request header', async (t) => {
  const state = baseState();
  const { container, location, settle } = await mount(t, { state });
  await click(byText(container, 'button', 'Add by address'));
  assert.match(location.current, /add=1/);
  const dialog = document.querySelector('[role="dialog"]');
  await act(async () => {
    dialog
      .querySelector('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const alerts = [...dialog.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /Paste a Fab listing address/);
  assert.equal(dialog.querySelector('#megascans-url').getAttribute('aria-invalid'), 'true');
  assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);

  await type(
    dialog.querySelector('#megascans-url'),
    'https://www.fab.com/listings/2ff093a2-3380-4b64-bfb7-719600367b20',
  );
  await type(dialog.querySelector('#megascans-title'), 'Jasper Stone');
  await type(dialog.querySelector('#megascans-tags'), 'stone, gem');
  await act(async () => {
    dialog
      .querySelector('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
  const post = state.requests.find((request) => request.method === 'POST');
  assert.equal(post.route, '/listings');
  assert.equal(post.headers['X-Forge-Request'], 'megascans');
  assert.deepEqual(JSON.parse(post.body).tags, ['stone', 'gem']);
  assert.ok(!document.querySelector('[role="dialog"]'), 'the dialog closed');
  assert.doesNotMatch(location.current, /add=1/);
});

test('the server error shows inside the form', async (t) => {
  const state = { ...baseState(), postFails: true };
  const { container, settle } = await mount(t, { state, entry: '/megascans?add=1' });
  const dialog = document.querySelector('[role="dialog"]');
  await type(dialog.querySelector('#megascans-url'), '854ffc09-e07f-45c2-9569-37cb7c4ab9c2');
  await type(dialog.querySelector('#megascans-title'), 'x');
  await act(async () => {
    dialog
      .querySelector('form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
  assert.match(dialog.textContent, /Enter a title for this listing/);
  assert.ok(container.isConnected);
});

test('the imports panel shows active, waiting, finished and failed imports with accessible progress', async (t) => {
  const state = {
    ...baseState(),
    imports: [
      importItem({
        id: '00000000-0000-4000-8000-000000000001',
        filename: 'running.zip',
        status: 'running',
        stage: 'Extracting',
        bytesDone: 40,
        bytesTotal: 100,
        bytesPerSecond: 10 * 1024 * 1024,
        secondsRemaining: 90,
      }),
      importItem({ id: '00000000-0000-4000-8000-000000000002', filename: 'waiting.zip' }),
      importItem({
        id: '00000000-0000-4000-8000-000000000003',
        filename: 'done.zip',
        status: 'completed',
        output: { files: ['3d/a/crate.fbx'], folder: '3d/megascans-a', skipped: 2 },
      }),
      importItem({
        id: '00000000-0000-4000-8000-000000000004',
        filename: 'bad.zip',
        status: 'failed',
        error: 'The archive contains an executable or script (.exe) and was rejected.',
      }),
    ],
  };
  const { container, settle, selected } = await mount(t, { state });
  const list = container.querySelector('ul[aria-label="Downloads and imports"]');
  assert.equal(list.children.length, 4);
  assert.match(container.textContent, /Running 1 of 2 · 1 waiting/);
  const bar = list.querySelector('[role="progressbar"]');
  assert.equal(bar.getAttribute('aria-valuenow'), '40');
  assert.equal(bar.getAttribute('aria-valuemin'), '0');
  assert.equal(bar.getAttribute('aria-valuemax'), '100');
  assert.match(bar.getAttribute('aria-label'), /running\.zip/);
  assert.match(list.textContent, /10\.0 MiB\/s · about 1 min 30 s left \(estimate\)/);
  assert.match(list.textContent, /Waiting/);
  assert.match(
    list.textContent,
    /Saved one model to 3d\/megascans-a · 2 unsupported file\(s\) skipped/,
  );
  assert.match(list.querySelector('[role="alert"]').textContent, /executable or script/);
  assert.match(container.textContent, /At most 2\s+downloads or imports run at the same time/);

  await click(byText(list, 'button', 'Cancel'));
  await click(byText(list, 'button', 'Retry'));
  await click(byText(list, 'button', 'Open Asset library'));
  const dismiss = [...list.querySelectorAll('button')].filter(
    (button) => button.textContent === 'Dismiss',
  );
  assert.equal(dismiss.length, 2, 'only finished imports can be dismissed');
  await click(dismiss[1]);
  await settle();
  const posts = state.requests
    .filter((request) => request.method === 'POST')
    .map((request) => request.route);
  assert.deepEqual(posts, [
    '/imports/00000000-0000-4000-8000-000000000001/cancel',
    '/imports/00000000-0000-4000-8000-000000000004/retry',
    '/imports/00000000-0000-4000-8000-000000000004/dismiss',
  ]);
  assert.ok(selected.includes('library'));
});

test('importing needs a project, rejects bad files inline, and uploads a good one', async (t) => {
  const state = baseState();
  const { container, settle } = await mount(t, { state });
  const input = container.querySelector('input[type="file"]');
  const choose = async (file) => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  };
  await choose(new window.File(['x'], 'setup.exe'));
  assert.match(
    container.querySelector('.megascans-import-uploading [role="alert"]').textContent,
    /Choose a ZIP archive or a GLB/,
  );
  await click(byText(container, 'button', 'Dismiss'));
  assert.ok(!container.querySelector('.megascans-import-uploading'));

  await choose(new window.File([new Uint8Array(1024)], 'crate.zip'));
  const xhr = state.uploads[0];
  assert.match(xhr.url, /project=0f6bd0a2/);
  assert.match(xhr.url, /filename=crate\.zip/);
  assert.doesNotMatch(xhr.url, /listing=/);
  assert.equal(xhr.headers['X-Forge-Request'], 'megascans');
  await act(async () =>
    xhr.upload.onprogress({ lengthComputable: true, loaded: 512, total: 1024 }),
  );
  assert.equal(
    container
      .querySelector('[aria-label="Upload progress for crate.zip"]')
      .getAttribute('aria-valuenow'),
    '50',
  );
  await act(async () => {
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ import: importItem({}) });
    xhr.onload();
  });
  await settle();
  assert.ok(!container.querySelector('.megascans-import-uploading'));
  assert.match(container.textContent, /queued for import into My Game/);

  // From a listing card the upload carries the listing id.
  await click(
    container.querySelector('button[aria-label="Import a downloaded file for Old Wooden Crate"]'),
  );
  await choose(new window.File([new Uint8Array(8)], 'crate.glb'));
  const upload = state.uploads.find((item) => /crate\.glb/.test(item.url));
  assert.match(upload.url, /listing=854ffc09-e07f-45c2-9569-37cb7c4ab9c2/);
});

test('without a project the import controls are disabled and say why', async (t) => {
  const { container } = await mount(t, { state: baseState(), project: null });
  assert.equal(byText(container, 'button', 'Import file').disabled, true);
  assert.match(container.textContent, /Choose a project above before importing a file/);
  for (const button of container.querySelectorAll('.megascans-card button[aria-label^="Import"]')) {
    assert.equal(button.disabled, true);
  }
});

test('a stale cache is refreshed once on arrival, never twice', async (t) => {
  const state = baseState();
  state.fab.cache.stale = true;
  const { container, settle } = await mount(t, { state });
  await settle(40);
  const posts = state.requests.filter((request) => request.route === '/refresh');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['X-Forge-Request'], 'megascans');
  assert.match(container.textContent, /Added 1 new listing/);
});

test('a fresh cache is not refreshed without a click, and Refresh posts once per click', async (t) => {
  const state = baseState();
  const { container, settle } = await mount(t, { state });
  assert.equal(state.requests.filter((request) => request.route === '/refresh').length, 0);
  await click(byText(container, 'button', 'Refresh'));
  await settle();
  assert.equal(state.requests.filter((request) => request.route === '/refresh').length, 1);
});

test('when Fab blocks Forge the page says so, stops asking, and points to Import', async (t) => {
  const state = baseState();
  state.fab.block = {
    kind: 'blocked',
    until: new Date(Date.now() + 3600 * 1000).toISOString(),
    message:
      'Fab is blocking automated requests. Try again later, or download from Fab yourself and use Import.',
  };
  state.fab.cache.stale = true;
  const { container, settle } = await mount(t, { state });
  await settle(40);
  const alert = container.querySelector('.megascans-error[role="alert"]');
  assert.match(alert.textContent, /Fab is blocking automated requests/);
  assert.match(alert.textContent, /use Import/);
  assert.equal(state.requests.filter((request) => request.method === 'POST').length, 0);
  assert.equal(byText(container, 'button', 'Refresh').disabled, true);
  assert.equal(byText(container, 'button', 'Scan catalog').disabled, true);
  // The cached models and the import flow still work.
  assert.equal(container.querySelectorAll('.megascans-card').length, 2);
  assert.equal(byText(container, 'button', 'Import file').disabled, false);
});

test('Scan catalog starts a scan and shows capped progress with a cancel control', async (t) => {
  const state = baseState();
  const { container, settle } = await mount(t, { state });
  await click(byText(container, 'button', 'Scan catalog'));
  await settle();
  assert.deepEqual(state.scanBody, { action: 'start' });

  state.fab.scan = {
    ...idleScan,
    status: 'running',
    pagesThisRun: 3,
    pagesTotal: 3,
    listingsSeen: 72,
  };
  await until(
    () =>
      container
        .querySelector('[aria-label="Catalog scan progress"]')
        ?.getAttribute('aria-valuenow') === '30',
  );
  const bar = container.querySelector('[aria-label="Catalog scan progress"]');
  assert.equal(bar.getAttribute('aria-valuenow'), '30');
  assert.match(container.textContent, /Scanning: page 4 of up to 10 this run · 72 listings read/);
  assert.ok(byText(container, 'button', 'Cancel scan'));

  state.fab.scan = {
    ...idleScan,
    status: 'capped',
    pagesThisRun: 10,
    pagesTotal: 10,
    listingsSeen: 240,
    cursor: 'x',
  };
  await until(() => /Paused after 10 pages/.test(container.textContent));
  assert.match(container.textContent, /Paused after 10 pages/);
  assert.ok(byText(container, 'button', 'Resume scan'));
});

test('opening a cached listing without details reads them once and shows Fab errors inline', async (t) => {
  const state = baseState();
  state.listings = [
    LISTINGS[0],
    {
      ...LISTINGS[0],
      id: '2ff093a2-3380-4b64-bfb7-719600367b20',
      detailFetchedAt: null,
      detail: null,
    },
  ];
  const { settle } = await mount(t, {
    state,
    entry: '/megascans?listing=2ff093a2-3380-4b64-bfb7-719600367b20',
  });
  await settle(60);
  assert.equal(state.requests.filter((request) => /refresh$/.test(request.route)).length, 1);
});

test('a Fab refusal while reading details shows inline and the cached data stays', async (t) => {
  const state = baseState();
  state.listings = [
    {
      ...LISTINGS[0],
      id: '2ff093a2-3380-4b64-bfb7-719600367b20',
      detailFetchedAt: null,
      detail: null,
    },
  ];
  state.detailFails = true;
  const { settle } = await mount(t, {
    state,
    entry: '/megascans?listing=2ff093a2-3380-4b64-bfb7-719600367b20',
  });
  await settle(60);
  assert.match(
    document.querySelector('[role="dialog"] [role="alert"]').textContent,
    /Could not read details from Fab: Fab is blocking/,
  );
  assert.match(document.querySelector('[role="dialog"]').textContent, /Old Wooden Crate/);
});

test('downloads stay off until the user ticks the license confirmation, then queue one file', async (t) => {
  const state = baseState();
  const { container, settle } = await mount(t, {
    state,
    entry: '/megascans?listing=854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
  });
  await settle(40);
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Download from Fab/);
  assert.match(dialog.textContent, /GLB \(one file, recommended\)/);
  assert.match(dialog.textContent, /Recommended/);
  const mid = dialog.querySelector('button[aria-label="Download crate_mid.glb (10.9 MiB)"]');
  assert.equal(mid.disabled, true);
  assert.match(dialog.textContent, /Downloads are off: Tick the license confirmation first/);

  // The checkbox is never ticked by Forge itself and links to the agreement and the listing.
  const box = dialog.querySelector('input[type="checkbox"]');
  assert.equal(box.checked, false);
  assert.equal(
    dialog.querySelector('a[href="https://www.fab.com/eula"]').getAttribute('rel'),
    'noopener noreferrer',
  );
  assert.ok(
    dialog.querySelector(
      'a[href="https://www.fab.com/listings/854ffc09-e07f-45c2-9569-37cb7c4ab9c2"]',
    ),
  );
  await click(box);
  await settle(40);
  assert.equal(
    state.requests.filter((request) => request.route === '/downloads/confirm').length,
    1,
  );
  assert.match(document.querySelector('[role="dialog"]').textContent, /Confirmed on/);

  const enabled = document.querySelector('button[aria-label="Download crate_mid.glb (10.9 MiB)"]');
  assert.equal(enabled.disabled, false);
  await click(enabled);
  await settle(40);
  assert.deepEqual(state.downloadBody, {
    project: PROJECT.id,
    listing: '854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
    fileUid: 'aaaaaaaa-0000-4000-8000-000000000001',
    confirmLarge: false,
  });
  assert.match(document.querySelector('[role="dialog"]').textContent, /crate_mid\.glb is queued/);
  assert.ok(container.isConnected);
});

test('large files ask again, USDZ and extra textures offer no download, and the extras are tucked away', async (t) => {
  const state = baseState();
  state.fab.downloads = {
    confirmed: true,
    acceptedAt: '2026-11-08T12:00:00Z',
    eulaUrl: 'https://www.fab.com/eula',
  };
  await mount(t, { state, entry: '/megascans?listing=854ffc09-e07f-45c2-9569-37cb7c4ab9c2' });
  await sleep(60);
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Large file: 169 MiB/);
  await click(dialog.querySelector('button[aria-label="Download crate_raw.glb (169 MiB)"]'));
  assert.match(dialog.textContent, /This is 169 MiB\. Download anyway\?/);
  assert.equal(state.downloadBody, undefined, 'nothing is queued by the first click');
  await click(byText(dialog, 'button', 'Download anyway'));
  await act(async () => sleep(40));
  assert.equal(state.downloadBody.confirmLarge, true);

  assert.ok(!dialog.querySelector('button[aria-label^="Download crate_low.usdz"]'));
  assert.ok(!dialog.querySelector('button[aria-label^="Download crate_exr_raw.zip"]'));
  const advanced = dialog.querySelector('details.megascans-advanced');
  assert.equal(advanced.open, false);
  assert.match(advanced.textContent, /very large \(up to 1\.8 GiB\)/);
  assert.match(advanced.textContent, /Forge cannot import them/);
});

test('the Downloads panel carries the same confirmation and labels downloads by their source', async (t) => {
  const state = baseState();
  state.imports = [
    importItem({
      id: '00000000-0000-4000-8000-0000000000d1',
      filename: 'crate_mid.glb',
      source: 'fab',
      status: 'running',
      stage: 'Downloading',
      bytesDone: 5,
      bytesTotal: 10,
    }),
  ];
  const { container, settle } = await mount(t, { state });
  assert.equal(container.querySelector('#megascans-imports-title').textContent, 'Downloads');
  assert.match(container.textContent, /Downloaded from Fab/);
  assert.ok(container.querySelector('[aria-label="Download progress for crate_mid.glb"]'));
  const box = container.querySelector('.megascans-imports input[type="checkbox"]');
  assert.equal(box.checked, false);
  await click(box);
  await settle(40);
  assert.equal(container.querySelector('.megascans-imports input[type="checkbox"]').checked, true);
  await click(container.querySelector('.megascans-imports input[type="checkbox"]'));
  await settle(40);
  assert.equal(state.requests.filter((request) => request.route === '/downloads/revoke').length, 1);
});

function manyListings(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...LISTINGS[0],
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: `Crate ${String(index + 1).padStart(3, '0')}`,
    url: `https://www.fab.com/listings/00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    thumbnailUrl: null,
  }));
}

function installObserver() {
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }

    observe(target) {
      this.targets.push(target);
    }

    disconnect() {
      this.targets = [];
    }
  };
  return {
    // Reports the end-of-list marker as visible to every observer that is watching it.
    async reveal() {
      await act(async () => {
        for (const observer of observers) {
          if (observer.targets.length) {
            observer.callback([{ isIntersecting: true }]);
          }
        }
      });
    },
  };
}

test('models are shown 24 at a time; Load more appends a chunk, announces it and keeps focus', async (t) => {
  const state = { ...baseState(), listings: manyListings(60) };
  const { container, location, settle } = await mount(t, { state });
  const cards = () => container.querySelectorAll('.megascans-card[aria-label]');
  assert.equal(cards().length, 24);
  assert.match(container.textContent, /Showing 24 of 60 models/);
  assert.equal(state.listingRequests.length, 1, 'only the first chunk was requested');

  const button = container.querySelector('.megascans-load-more');
  assert.match(button.textContent, /Load more models \(36 left in the cache\)/);
  button.focus();
  await click(button);
  await settle(30);
  assert.equal(cards().length, 48);
  assert.ok(document.activeElement === button, 'focus stays on the same Load more button');
  assert.match(container.textContent, /24 more models loaded\. Showing 48 of 60/);
  assert.match(location.current, /page=2/);

  document.activeElement.focus();
  await click(container.querySelector('.megascans-load-more'));
  await settle(30);
  assert.equal(cards().length, 60);
  assert.ok(!container.querySelector('.megascans-load-more'));
  assert.match(container.textContent, /That is every model in the cache/);
  const firstNew = container.querySelectorAll('.megascans-card-open')[48];
  assert.ok(document.activeElement === firstNew, 'focus moves to the first model that was added');
});

test('a deep link with a page count loads that many chunks at once', async (t) => {
  const state = { ...baseState(), listings: manyListings(60) };
  const { container } = await mount(t, { state, entry: '/megascans?page=2' });
  assert.equal(container.querySelectorAll('.megascans-card[aria-label]').length, 48);
  assert.deepEqual(state.listingRequests.map((request) => request.page).sort(), [1, 2]);
});

test('scrolling to the end of the list appends the next chunk without a click', async (t) => {
  const observer = installObserver();
  t.after(() => delete globalThis.IntersectionObserver);
  const state = { ...baseState(), listings: manyListings(50) };
  const { container, settle } = await mount(t, { state });
  assert.equal(container.querySelectorAll('.megascans-card[aria-label]').length, 24);
  await observer.reveal();
  await settle(30);
  assert.equal(container.querySelectorAll('.megascans-card[aria-label]').length, 48);
});

test('Fab is asked for more only when the cache is used up and the person has scrolled', async (t) => {
  const observer = installObserver();
  t.after(() => delete globalThis.IntersectionObserver);
  const state = { ...baseState(), listings: manyListings(3) };
  state.fab.cache.hasMore = true;
  state.moreListings = manyListings(8).slice(3);
  const { container, settle } = await mount(t, { state });
  assert.ok(byText(container, 'button', 'Read more from Fab'));
  assert.equal(container.querySelectorAll('.megascans-card[aria-label]').length, 3);

  await observer.reveal();
  await settle(30);
  assert.equal(state.moreCalls, undefined, 'the list being short is not a reason to ask Fab');

  await act(async () => {
    document.dispatchEvent(new window.Event('wheel', { bubbles: true }));
  });
  await observer.reveal();
  await settle(40);
  assert.equal(state.moreCalls, 1);
  assert.equal(container.querySelectorAll('.megascans-card[aria-label]').length, 8);
  assert.match(container.textContent, /5 more models read from Fab/);
});

test('Fab is not asked for more while it is blocking Forge', async (t) => {
  const state = { ...baseState(), listings: manyListings(3) };
  state.fab.cache.hasMore = true;
  state.fab.block = {
    kind: 'blocked',
    until: new Date(Date.now() + 3600000).toISOString(),
    message: 'Fab is blocking automated requests.',
  };
  const { container } = await mount(t, { state });
  assert.equal(byText(container, 'button', 'Read more from Fab'), undefined);
});

test('previews show a placeholder while loading and an explicit state when they fail', async (t) => {
  const state = baseState();
  state.listings = [
    LISTINGS[0],
    { ...LISTINGS[0], id: '2ff093a2-3380-4b64-bfb7-719600367b20', title: 'Other' },
  ];
  const { container } = await mount(t, { state });
  const previews = container.querySelectorAll('.megascans-card-preview');
  assert.ok(previews[0].classList.contains('megascans-preview-loading'));
  const images = container.querySelectorAll('.megascans-card-preview img');
  assert.equal(images[0].getAttribute('loading'), 'lazy');
  await act(async () => images[0].dispatchEvent(new window.Event('load')));
  assert.ok(previews[0].classList.contains('megascans-preview-loaded'));
  await act(async () => images[1].dispatchEvent(new window.Event('error')));
  assert.match(previews[1].textContent, /No preview/);
  assert.ok(!previews[1].querySelector('img'));
});

const LEGAL = {
  'https://www.fab.com/eula': 'Fab End User License Agreement',
  'https://www.fab.com/terms-of-service': 'Fab Terms of Service',
  'https://dev.epicgames.com/en-US/services/terms/aup': 'Acceptable Use Policy',
  'https://www.fab.com/sellers/Quixel%20Megascans': 'Quixel Megascans on Fab',
};

function linkTo(root, href, label) {
  return [...root.querySelectorAll(`a[href="${href}"]`)].find((link) =>
    link.textContent.includes(label),
  );
}

function assertSafeLink(link, href, label) {
  assert.ok(link, `a link to ${href} labelled ${label}`);
  assert.equal(link.getAttribute('href'), href);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.match(link.textContent, new RegExp(label));
  assert.match(link.querySelector('.sr-only').textContent, /opens in a new tab/);
  assert.ok(link.querySelector('svg'), 'an external-link icon');
}

test('the page footer links to the agreements and terms with safe external links', async (t) => {
  const { container } = await mount(t, { state: baseState() });
  const footer = container.querySelector('.megascans-footer');
  assert.equal(footer.querySelector('h3').textContent, 'Licences and terms');
  for (const [href, label] of Object.entries(LEGAL)) {
    assertSafeLink(linkTo(footer, href, label), href, label);
  }
});

test('the dialog links to the listing, its licence and every agreement, and the checkbox names them', async (t) => {
  const { settle } = await mount(t, {
    state: baseState(),
    entry: '/megascans?listing=854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
  });
  await settle(40);
  const dialog = document.querySelector('[role="dialog"]');
  const legal = dialog.querySelector('.megascans-legal');
  assertSafeLink(
    legal.querySelector('a[href="https://www.fab.com/eula"]'),
    'https://www.fab.com/eula',
    "This listing's licence: Fab Standard License",
  );
  assertSafeLink(
    legal.querySelector(
      'a[href="https://www.fab.com/listings/854ffc09-e07f-45c2-9569-37cb7c4ab9c2"]',
    ),
    'https://www.fab.com/listings/854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
    'This listing on Fab',
  );
  for (const [href, label] of Object.entries(LEGAL)) {
    assertSafeLink(linkTo(legal, href, label), href, label);
  }
  const consent = dialog.querySelector('.megascans-consent-label');
  for (const href of [
    'https://www.fab.com/eula',
    'https://www.fab.com/terms-of-service',
    'https://dev.epicgames.com/en-US/services/terms/aup',
  ]) {
    assert.equal(
      consent.querySelector(`a[href="${href}"]`).getAttribute('rel'),
      'noopener noreferrer',
    );
  }
  assert.match(consent.textContent, /this listing's licence \(Fab Standard License/);
});

test('cards show their licence, and cached details can be refreshed on demand', async (t) => {
  const state = baseState();
  const { container, settle } = await mount(t, {
    state,
    entry: '/megascans?listing=854ffc09-e07f-45c2-9569-37cb7c4ab9c2',
  });
  assert.match(
    container.querySelector('.megascans-card').textContent,
    /Licence: Fab Standard License/,
  );
  await settle(40);
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(
    dialog.querySelector('.megascans-cached').textContent,
    /Details cached \d+ days? ago/,
  );
  await click(byText(dialog, 'button', 'Refresh details'));
  await settle(40);
  assert.deepEqual(state.detailBody, { force: true });
});

test('when Fab cannot be reached the saved models stay usable and the page says so', async (t) => {
  const state = baseState();
  state.fab.unreachable = { at: '2026-11-08T10:32:00.000Z', message: 'Could not reach Fab.' };
  const { container } = await mount(t, { state });
  assert.match(
    container.textContent,
    /Fab could not be reached at .*Everything saved here still works/,
  );
  assert.equal(container.querySelectorAll('.megascans-card[aria-label]').length, 2);
});
