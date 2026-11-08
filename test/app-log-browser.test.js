// Browser logger (src/app-log.js) in jsdom: field rules, batching, silent failure, automatic
// capture of routes, failed /api requests and named clicks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><button id="queue-render">Queue a castle</button><input id="prompt" value="a castle"></body></html>',
  {
    url: 'http://127.0.0.1:5173/images?prompt=castle',
  },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'location', { configurable: true, value: dom.window.location });
const sent = [];
let shouldFail = false;
// The network stand-in records what the ingest route would receive.
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === '/api/logs/ingest') {
    if (shouldFail) {
      throw new TypeError('Failed to fetch');
    }
    sent.push({ headers: init.headers, body: JSON.parse(init.body), keepalive: init.keepalive });
    return { ok: true, status: 202 };
  }
  if (url.includes('/api/broken')) {
    return { ok: false, status: 503 };
  }
  return { ok: true, status: 200 };
};
dom.window.fetch = globalThis.fetch;

const appLog = await import('../src/app-log.js');

test('records follow the shared field rules and are posted in batches', async () => {
  appLog.configureBrowserLogForTests({ sender: null, level: 'info' });
  sent.length = 0;
  const log = appLog.createLog('image');
  log.debug('image.preview.drawn', { width: 10 });
  log.info('image.render.queued', {
    jobId: 'job-1',
    prompt: 'a castle at dusk',
    outputPath: 'C:\\Users\\alice\\castle.png',
    steps: 4,
  });
  const { pending } = appLog.getBrowserLogState();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].jobId, 'job-1');
  assert.deepEqual(pending[0].fields.droppedFieldNames, ['prompt', 'outputPath']);
  assert.equal(await appLog.flushBrowserLog(), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['X-Forge-Request'], 'app-log');
  assert.equal(sent[0].body.records[0].event, 'image.render.queued');
  assert.ok(!JSON.stringify(sent).includes('castle'));
});

test('failed sends are dropped silently and counted', async () => {
  appLog.configureBrowserLogForTests({ level: 'info' });
  shouldFail = true;
  const log = appLog.createLog('ui');
  log.info('ui.dialog.opened', { view: 'errors' });
  assert.equal(await appLog.flushBrowserLog(), false);
  assert.equal(appLog.getBrowserLogState().dropped, 1);
  shouldFail = false;
  for (let index = 0; index < 250; index += 1) {
    log.info('ui.item.viewed', { index, jobId: `job-${index}` });
  }
  assert.ok(appLog.getBrowserLogState().pending.length <= appLog.PENDING_CAP_ROWS);
});

test('sampling keeps a fraction of info records and all warnings', () => {
  appLog.configureBrowserLogForTests({ level: 'info' });
  const noisy = appLog.createLog('ui', undefined, { sampleRate: 0 });
  noisy.info('ui.scroll.moved', { index: 1 });
  noisy.warn('ui.scroll.failed', { index: 2 });
  const events = appLog.getBrowserLogState().pending.map((record) => record.event);
  assert.deepEqual(events, ['ui.scroll.failed']);
});

test('capture records page names, failed API routes and named clicks only', async () => {
  appLog.configureBrowserLogForTests({ level: 'info' });
  sent.length = 0;
  appLog.installAppLogCapture();
  dom.window.history.pushState({}, '', '/projects/My%20Secret%20Game?tab=assets');
  await globalThis.fetch('/api/projects/my-secret-game/assets?q=dragon', { method: 'POST' });
  await globalThis.fetch('/api/broken/thing?token=abc');
  document.getElementById('queue-render').click();
  document.getElementById('prompt').dispatchEvent(new dom.window.Event('input'));
  const records = appLog.getBrowserLogState().pending;
  const routes = records.filter((record) => record.event === 'ui.route.changed');
  assert.deepEqual(
    routes.map((record) => record.fields.page),
    ['images', 'projects'],
  );
  const failed = records.find((record) => record.event === 'http.request.failed');
  assert.deepEqual(
    { route: failed.fields.route, status: failed.fields.status, method: failed.fields.method },
    { route: '/api/broken/thing', status: 503, method: 'GET' },
  );
  const click = records.find((record) => record.event === 'ui.action.clicked');
  assert.equal(click.fields.actionId, 'queue-render');
  const text = JSON.stringify(records);
  for (const secret of ['Secret', 'dragon', 'castle', 'token=abc', 'Queue a castle']) {
    assert.ok(!text.includes(secret), `captured ${secret}`);
  }
});
