import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from 'vite';
import { RECONNECT_MAX_MS, pollDelayMs } from '../src/reconnect.js';
import {
  CHAT_DRAFT_KEY,
  readChatDraft,
  sanitizeSavedChatList,
  writeChatDraft,
} from '../src/chat-project.js';
import {
  readStoredJson,
  sanitizeDrafts,
  sanitizeJobList,
  sanitizeRatings,
  sanitizeSelectedProject,
  sanitizeSwitches,
} from '../src/storage-tolerance.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('polling stays at the normal period while healthy and backs off from 1 s to 15 s on failure', () => {
  assert.equal(pollDelayMs(0), 5000);
  assert.equal(pollDelayMs(0, 7000), 7000);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 50].map((failureCount) => pollDelayMs(failureCount)),
    [1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
  assert.equal(pollDelayMs(Number.NaN), 5000);
  assert.equal(pollDelayMs(-3), 5000);
  assert.equal(RECONNECT_MAX_MS, 15000);
});

test('damaged JSON and wrongly shaped values read back as the defaults', () => {
  assert.equal(readStoredJson('k', memoryStorage({ k: '{"half' })), undefined);
  assert.equal(readStoredJson('k', memoryStorage()), undefined);
  assert.equal(
    readStoredJson('k', {
      getItem: () => {
        throw Error('blocked');
      },
    }),
    undefined,
  );

  const initial = {
    images: { prompt: '', second: '', options: ['a', 'b'], seed: '', refs: [] },
    music: { prompt: '', second: '', options: ['x'], seed: '', refs: [] },
  };
  for (const saved of [null, 'text', 7, [], [1, 2], { images: 'garbage', music: [1] }]) {
    assert.deepEqual(sanitizeDrafts(saved, initial), initial, JSON.stringify(saved));
  }
  const restored = sanitizeDrafts(
    {
      images: {
        prompt: 'a bronze compass',
        second: 5,
        options: ['c', 'd'],
        seed: 42,
        refs: ['asset'],
        model: 'Qwen',
        nested: { a: 1 },
      },
      music: { prompt: 'song', options: ['too', 'many'] },
    },
    initial,
  );
  assert.equal(restored.images.prompt, 'a bronze compass');
  assert.equal(restored.images.second, '', 'a number is not text');
  assert.deepEqual(restored.images.options, ['c', 'd']);
  assert.equal(restored.images.seed, 42);
  assert.equal(restored.images.model, 'Qwen');
  assert.deepEqual(restored.images.refs, [], 'reference selections are never restored');
  assert.equal('nested' in restored.images, false);
  assert.deepEqual(restored.music.options, ['x'], 'options of another length are ignored');
  assert.equal(restored.music.prompt, 'song');

  assert.deepEqual(sanitizeJobList('x'), []);
  assert.deepEqual(sanitizeJobList({ id: 'a' }), []);
  assert.deepEqual(sanitizeJobList([null, 3, { id: 'a' }, { id: 5 }]), [{ id: 'a' }]);
  assert.equal(sanitizeSelectedProject({ id: 1 }), null);
  assert.equal(sanitizeSelectedProject(''), null);
  assert.equal(sanitizeSelectedProject('p-1'), 'p-1');
  const defaults = { render: true, queue: true };
  assert.deepEqual(sanitizeSwitches('x', defaults), defaults);
  assert.deepEqual(sanitizeSwitches({ render: false, queue: 'no', extra: 1 }, defaults), {
    render: false,
    queue: true,
  });
  assert.deepEqual(sanitizeRatings([1, 2]), {});
  assert.deepEqual(sanitizeRatings({ a: 5, b: 'x', c: null }), { a: 5 });
});

test('saved conversations keep what is valid, and the unsent chat draft tolerates damage', () => {
  assert.deepEqual(sanitizeSavedChatList('x'), []);
  assert.deepEqual(sanitizeSavedChatList([null, 3, { id: 1 }, { id: 'a', messages: 'no' }]), []);
  const kept = sanitizeSavedChatList([
    { id: 'a', title: 5, messages: [null, { role: 'user', content: 'hi' }, 'x'] },
    { id: 'b' },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'New conversation');
  assert.deepEqual(kept[0].messages, [{ role: 'user', content: 'hi' }]);

  for (const raw of [undefined, '{"text":', '[]', '{"text":5}', 'null']) {
    const damagedStorage = memoryStorage(raw === undefined ? {} : { [CHAT_DRAFT_KEY]: raw });
    assert.equal(readChatDraft(damagedStorage), '');
  }
  const storage = memoryStorage();
  writeChatDraft('half a thought', storage);
  assert.equal(readChatDraft(storage), 'half a thought');
  writeChatDraft('', storage);
  assert.equal(storage.getItem(CHAT_DRAFT_KEY), null);
  assert.equal(CHAT_DRAFT_KEY, 'forge-chat-draft-v1');
  const blocked = {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {
      throw Error('full');
    },
    removeItem: () => {
      throw Error('blocked');
    },
  };
  assert.equal(readChatDraft(blocked), '');
  assert.doesNotThrow(() => writeChatDraft('x', blocked));
});

test('the studio connection message appears when polling fails, clears on recovery, and keeps the jobs', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: dom.window.localStorage,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const stamps = [];
  let calls = 0;
  globalThis.fetch = async (url) => {
    // Browser log batches are not counted: this test measures the queue's own retry timing.
    if (url === '/api/logs/ingest') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    calls += 1;
    stamps.push(Date.now());
    if (calls >= 2 && calls <= 3) {
      throw Error('connect ECONNREFUSED');
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jobs: [{ id: 'job-1', type: 'images', status: 'completed' }] }),
    };
  };
  const vite = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: { ignored: ['**/.forge-runtime/**'] } },
  });
  const timing = await vite.ssrLoadModule('/src/QueueTiming.jsx');
  const { default: ConnectionStatus } = await vite.ssrLoadModule('/src/ConnectionStatus.jsx');
  let observed = null;
  function Probe() {
    observed = timing.useQueueTiming();
    return null;
  }
  const root = createRoot(document.querySelector('#root'));
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    for (const [name, descriptor] of [
      ['localStorage', previous.localStorage],
      ['navigator', previous.navigator],
    ]) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    dom.window.close();
  });
  await act(async () =>
    root.render(
      React.createElement(
        timing.QueueTimingProvider,
        null,
        React.createElement(ConnectionStatus),
        React.createElement(Probe),
      ),
    ),
  );
  const status = () => document.querySelector('.connection-status');
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  assert.equal(status().getAttribute('role'), 'status');
  assert.equal(status().getAttribute('aria-live'), 'polite');
  assert.equal(status().textContent, '', 'the live region exists but is empty while healthy');
  assert.equal(observed.jobs.length, 1);

  // The first poll succeeded; the second comes after the normal 5 s, then retries after 1 s, 2 s.
  await wait(5300);
  assert.equal(status().textContent, 'Studio is not responding, reconnecting…');
  assert.equal(observed.jobs.length, 1, 'the jobs from before the outage stay on screen');
  await wait(1300);
  assert.equal(calls, 3, 'the retry came after about one second');
  assert.equal(status().textContent, 'Studio is not responding, reconnecting…');
  await wait(2300);
  assert.equal(calls, 4, 'the next retry waited about two seconds');
  assert.equal(status().textContent, '', 'the message clears when the studio answers');
  const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
  assert.ok(gaps[0] >= 4800 && gaps[1] >= 900 && gaps[1] < 1800 && gaps[2] >= 1900, gaps.join());
});
