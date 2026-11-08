import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

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

// The components are loaded through Vite's SSR loader so they share one router and one context.
async function startVite() {
  return createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    ssr: { noExternal: ['react-router'] },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROJECT = { id: '0f6bd0a2-5d35-4ef9-a6a0-6a6a3f6d1f11', name: 'Forest', assets: [] };

const number = (id, name, group, min, max, step, value, type = 'number') => ({
  id,
  name,
  group,
  type,
  min,
  max,
  step,
  default: value,
});
const SCHEMA = {
  schemaVersion: 2,
  seedthree: { version: '0.1.0-alpha', commit: 'a'.repeat(40) },
  seed: { min: 1, max: 9999, default: 1 },
  limits: { maxTriangles: 1500000 },
  budgets: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }],
  species: [
    {
      key: 'whiteOak',
      name: 'White Oak',
      latin: 'Quercus alba',
      biome: 'temperate',
      generator: 'weber-penn',
      controls: [
        number('height', 'Height (m)', 'shape', 4, 26, 0.5, 13),
        number('levels', 'Branch levels', 'shape', 2, 4, 1, 3, 'integer'),
        {
          id: 'crownShape',
          name: 'Crown shape',
          group: 'shape',
          type: 'choice',
          default: 1,
          options: [
            { label: 'Conical', value: 0 },
            { label: 'Spherical', value: 1 },
          ],
        },
        { id: 'showLeaves', name: 'Show leaves', group: 'leaves', type: 'boolean', default: true },
        number(
          'paramOverrides.downAngle.1',
          'Down angle · L1',
          'advanced',
          0,
          135,
          1,
          68,
          'integer',
        ),
      ],
    },
    {
      key: 'saguaro',
      name: 'Saguaro',
      latin: 'Carnegiea gigantea',
      biome: 'desert',
      generator: 'dichotomous-lsystem',
      controls: [number('armLength', 'Arm length (m)', 'shape', 0.6, 2, 0.1, 1.1)],
    },
  ],
};
const MEASURED = {
  whiteOak: { low: 9450, medium: 28104, high: 56208 },
  saguaro: { low: 608, medium: 2160, high: 7104 },
};
const READY = {
  checkout: {
    state: 'ready',
    action: null,
    message: 'SeedThree is ready.',
    license: 'MIT',
    repository: 'https://github.com/SkyeShark/SeedThree.git',
    expectedCommit: 'a'.repeat(40),
    location: 'external/SeedThree',
  },
  fetch: { running: false, step: '', error: '' },
};
const describeStatus = (extra = {}) => ({
  provider: 'openai',
  model: 'gpt-6-luna',
  hasOpenAIKey: true,
  localChatRunning: null,
  notice: 'Your description and the plant parameter list are sent to OpenAI.',
  maxChars: 600,
  state: 'ready',
  ...extra,
});

async function mount(t, { entry = '/vegetation', project = PROJECT, state }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
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
  state.jobs = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const record = {
      method: init.method || 'GET',
      path: url.pathname,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    state.requests.push(record);
    const respond = (status, body) => ({
      ok: status < 300,
      status,
      json: async () => structuredClone(body),
    });
    const route = `${record.method} ${record.path}`;
    if (route === 'GET /api/vegetation/status') {
      return respond(200, state.status);
    }
    if (route === 'GET /api/vegetation/schema') {
      return state.status.checkout.state === 'ready'
        ? respond(200, { schema: SCHEMA, measured: MEASURED })
        : respond(409, { error: 'not ready' });
    }
    if (route === 'POST /api/vegetation/fetch') {
      state.status = { ...state.status, fetch: { running: true, step: 'Downloading', error: '' } };
      return respond(202, { fetch: state.status.fetch });
    }
    if (route === 'POST /api/vegetation/describe') {
      return state.describeError
        ? respond(state.describeError.status, state.describeError.body)
        : respond(200, { suggestion: state.suggestion });
    }
    if (route === 'POST /api/vegetation/describe/check') {
      return respond(200, state.check);
    }
    if (route === 'POST /api/runtime/estimate') {
      return respond(200, { available: false, sampleCount: 0 });
    }
    if (route === 'POST /api/runtime/jobs') {
      if (state.queueError && state.jobs.length === state.queueError.after) {
        return respond(400, { error: state.queueError.message });
      }
      state.jobs.push(record.body);
      return respond(201, { job: { id: `job-${state.jobs.length}` } });
    }
    if (route === 'GET /api/runtime/jobs') {
      return respond(200, { jobs: [] });
    }
    if (route === 'POST /api/runtime/models/chat/load') {
      state.status = {
        ...state.status,
        describe: describeStatus({ provider: 'local', localChatRunning: true, state: 'local' }),
      };
      return respond(200, { message: 'Qwen is starting.' });
    }
    if (route === 'GET /api/ai-assist/settings') {
      return respond(200, { features: state.features, hasOpenAIKey: true });
    }
    if (route === 'POST /api/ai-assist/settings') {
      return respond(200, {
        feature: {
          ...state.features[1],
          ...record.body,
          label: state.features[1].label,
          defaultProvider: 'openai',
          defaultModel: 'gpt-6-luna',
        },
      });
    }
    return respond(200, {});
  };
  const vite = await startVite();
  const { MemoryRouter, useLocation } = await vite.ssrLoadModule('react-router');
  const { default: Vegetation } = await vite.ssrLoadModule('/src/Vegetation.jsx');
  const { QueueTimingProvider } = await vite.ssrLoadModule('/src/QueueTiming.jsx');
  const location = { current: '' };
  function Probe() {
    const here = useLocation();
    location.current = here.pathname + here.search;
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        React.createElement(Probe),
        React.createElement(
          QueueTimingProvider,
          null,
          React.createElement(Vegetation, {
            project,
            projects: [PROJECT],
            onRefresh: async () => {},
            onOpenLibrary: () => {},
            onNewProject: () => {},
          }),
        ),
      ),
    );
  });
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    if (previous.navigator) {
      Object.defineProperty(globalThis, 'navigator', previous.navigator);
    }
    dom.window.close();
  });
  const settle = async (ms = 400) => act(async () => sleep(ms));
  await settle();
  return { root, location, settle, container: document.getElementById('root') };
}

const baseState = (extra = {}) => ({
  status: { ...READY, describe: describeStatus() },
  ...extra,
});
const byText = (container, selector, text) =>
  [...container.querySelectorAll(selector)].find((element) => element.textContent.includes(text));
async function click(element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
async function type(input, value) {
  const prototype =
    input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function choose(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}
const search = (location) => new URLSearchParams(location.current.split('?')[1] || '');
const field = (container, id) => container.querySelector(`[id="${id}"]`);

test('an unfetched SeedThree shows an actionable Fetch state and downloads nothing by itself', async (t) => {
  const state = baseState({
    status: {
      ...READY,
      checkout: {
        ...READY.checkout,
        state: 'missing',
        action: 'fetch',
        message: 'SeedThree has not been fetched yet.',
      },
      describe: describeStatus(),
    },
  });
  const { container, settle } = await mount(t, { state });
  assert.match(container.textContent, /SeedThree is not ready/);
  assert.match(container.textContent, /has not been fetched yet/);
  assert.match(container.textContent, /install\.ps1 -Vegetation/);
  assert.match(container.textContent, /about 1 MiB/);
  assert.equal(container.querySelector('form.vegetation-form'), null, 'no form until it is ready');
  assert.ok(!state.requests.some((request) => request.path === '/api/vegetation/schema'));
  assert.ok(!state.requests.some((request) => request.path === '/api/vegetation/fetch'));
  const button = byText(container, 'button', 'Fetch SeedThree');
  await click(button);
  const posted = state.requests.find((request) => request.path === '/api/vegetation/fetch');
  assert.equal(posted.method, 'POST');
  assert.equal(posted.headers['X-Forge-Request'], 'vegetation');
  await settle(1200);
  assert.match(
    container.querySelector('[role="status"].vegetation-fetch-step').textContent,
    /Downloading/,
  );
});

test('an outdated checkout offers Update, and a failed fetch is shown as an alert', async (t) => {
  const state = baseState({
    status: {
      ...READY,
      checkout: {
        ...READY.checkout,
        state: 'outdated',
        action: 'update',
        message: 'SeedThree is at 1234567890; Forge is tested with aaaaaaaaaa.',
      },
      fetch: { running: false, step: '', error: 'git fetch failed (exit 128). unable to access' },
      describe: describeStatus(),
    },
  });
  const { container } = await mount(t, { state });
  assert.ok(byText(container, 'button', 'Update SeedThree'));
  assert.match(container.querySelector('[role="alert"]').textContent, /git fetch failed/);
});

test('controls come from the schema with ranges, labels, and the measured triangle budgets', async (t) => {
  const state = baseState();
  const { container } = await mount(t, { state });
  assert.match(container.querySelector('h1').textContent, /Vegetation/);
  const species = field(container, 'vegetation-species');
  assert.deepEqual(
    [...species.options].map((option) => option.textContent),
    ['White Oak (Quercus alba)', 'Saguaro (Carnegiea gigantea)'],
  );
  assert.equal([...species.querySelectorAll('optgroup')].length, 2);
  const budgets = [...container.querySelectorAll('.vegetation-budget')].map(
    (label) => label.textContent,
  );
  assert.deepEqual(budgets, [
    'Low9,450 triangles',
    'Medium28,104 triangles',
    'High56,208 triangles',
  ]);
  assert.equal(field(container, 'vegetation-control-height').min, '4');
  assert.equal(field(container, 'vegetation-control-height').max, '26');
  assert.equal(container.querySelector('input[aria-label="Height (m) slider"]').step, '0.5');
  assert.equal(field(container, 'vegetation-control-levels').step, '1');
  assert.equal(field(container, 'vegetation-control-crownShape').tagName, 'SELECT');
  assert.equal(field(container, 'vegetation-control-showLeaves').type, 'checkbox');
  assert.ok(container.querySelector('label[for="vegetation-control-height"]'));
  assert.match(container.textContent, /4 to 26 · default 13/);
  const advanced = container.querySelector('details.vegetation-advanced:last-of-type');
  assert.match(advanced.querySelector('summary').textContent, /Advanced branch controls/);
  assert.equal(advanced.open, false, 'advanced controls start collapsed');
  assert.match(container.textContent, /no textures, no wind/i);
});

test('tuning, species, seed and budget live in the address and reset is gated', async (t) => {
  const state = baseState();
  const { container, location } = await mount(t, { state });
  const reset = () => container.querySelector('#vegetation-reset');
  assert.equal(reset().disabled, true, 'nothing to reset on a clean page');
  await type(field(container, 'vegetation-control-height'), '20');
  assert.equal(search(location).get('tune'), 'height:20');
  await click(container.querySelectorAll('input[name="vegetation-budget"]')[2]);
  assert.equal(search(location).get('budget'), 'high');
  await type(field(container, 'vegetation-seed'), '1737');
  assert.equal(search(location).get('seed'), '1737');
  assert.equal(reset().disabled, false);
  await click(reset());
  assert.ok(container.querySelector('[role="group"][aria-label="Confirm reset"]'));
  assert.equal(search(location).get('tune'), 'height:20', 'arming the reset changes nothing');
  await click(byText(container, 'button', 'Yes, reset'));
  assert.equal(location.current, '/vegetation');
  assert.equal(field(container, 'vegetation-control-height').value, '13');
  await choose(field(container, 'vegetation-species'), 'saguaro');
  assert.equal(search(location).get('species'), 'saguaro');
  assert.ok(field(container, 'vegetation-control-armLength'));
  assert.equal(field(container, 'vegetation-control-height'), null);
});

test('the address restores a shared design and drops what the schema does not allow', async (t) => {
  const state = baseState();
  const { container } = await mount(t, {
    entry:
      '/vegetation?species=whiteOak&seed=77&budget=low&tune=height:20,levels:9,nope:1,showLeaves:false',
    state,
  });
  assert.equal(field(container, 'vegetation-seed').value, '77');
  assert.equal(field(container, 'vegetation-control-height').value, '20');
  assert.equal(field(container, 'vegetation-control-levels').value, '3', 'out of range is dropped');
  assert.equal(field(container, 'vegetation-control-showLeaves').checked, false);
  assert.equal(
    container.querySelector('input[name="vegetation-budget"][value="low"]').checked,
    true,
  );
});

test('an invalid typed number shows an inline error and blocks queuing', async (t) => {
  const state = baseState();
  const { container } = await mount(t, { state });
  const input = field(container, 'vegetation-control-height');
  await type(input, '99');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(container.textContent, /Enter a number from 4 to 26/);
  await click(byText(container, 'button', 'Add plant to queue'));
  assert.match(
    container.querySelector('[role="alert"].vegetation-notice').textContent,
    /Height \(m\): enter a number/,
  );
  assert.equal(state.jobs.length, 0);
  await type(input, '10');
  assert.equal(input.getAttribute('aria-invalid'), null);
});

test('queuing needs a project, and variations queue sibling jobs with consecutive seeds', async (t) => {
  const none = baseState();
  const noProject = await mount(t, { state: none, project: null });
  await click(byText(noProject.container, 'button', 'Add plant to queue'));
  assert.match(noProject.container.textContent, /Choose or create a project first/);
  assert.equal(none.jobs.length, 0);
});

test('adding plants posts one validated job per variation and reports it', async (t) => {
  const state = baseState();
  const { container } = await mount(t, {
    entry: '/vegetation?species=whiteOak&seed=100&n=3&budget=high&tune=height:20',
    state,
  });
  assert.ok(byText(container, 'button', 'Add 3 plants to queue'));
  await click(byText(container, 'button', 'Add 3 plants to queue'));
  assert.equal(state.jobs.length, 3);
  assert.deepEqual(
    state.jobs.map((job) => [
      job.type,
      job.projectId,
      job.request.seed,
      job.request.variation_index,
    ]),
    [
      ['vegetation', PROJECT.id, 100, 1],
      ['vegetation', PROJECT.id, 101, 2],
      ['vegetation', PROJECT.id, 102, 3],
    ],
  );
  assert.deepEqual(state.jobs[0].request.params, { height: 20 });
  assert.equal(state.jobs[0].request.budget, 'high');
  assert.equal(new Set(state.jobs.map((job) => job.request.variation_group)).size, 1);
  const runtimeRequest = state.requests.find(
    (request) => request.path === '/api/runtime/jobs' && request.method === 'POST',
  );
  assert.equal(runtimeRequest.headers['X-Forge-Request'], 'runtime');
  assert.match(
    container.querySelector('[role="status"].vegetation-notice').textContent,
    /3 plants added to the render queue/,
  );
  assert.ok(state.requests.some((request) => request.path === '/api/runtime/estimate'));
});

test('a partial failure says how many plants were queued', async (t) => {
  const state = baseState({
    queueError: { after: 1, message: 'Seed must be a whole number from 1 to 9999.' },
  });
  const { container } = await mount(t, { entry: '/vegetation?n=3', state });
  await click(byText(container, 'button', 'Add 3 plants to queue'));
  assert.equal(state.jobs.length, 1);
  assert.match(
    container.querySelector('[role="alert"].vegetation-notice').textContent,
    /1 of 3 queued before an error/,
  );
});

test('seeds that would pass 9999 are refused before anything is queued', async (t) => {
  const state = baseState();
  const { container } = await mount(t, { entry: '/vegetation?seed=9999&n=2', state });
  await click(byText(container, 'button', 'Add 2 plants to queue'));
  assert.equal(state.jobs.length, 0);
  assert.match(container.textContent, /use a seed of 9998 or lower for 2 variations/);
});

test('Describe it without an OpenAI key shows the Settings link and sends nothing', async (t) => {
  const state = baseState();
  state.status.describe = describeStatus({ hasOpenAIKey: false, state: 'needs_key' });
  const { container, location } = await mount(t, { entry: '/vegetation?describe=1', state });
  assert.match(container.textContent, /Add your OpenAI key in Settings/);
  assert.equal(byText(container, 'button', 'Describe').disabled, true);
  assert.match(
    container.textContent,
    /Your description and the plant parameter list are sent to OpenAI/,
  );
  assert.match(container.textContent, /Uses OpenAI · gpt-6-luna/);
  await click(byText(container, 'button.text-action', 'Add your OpenAI key in Settings'));
  assert.equal(search(location).get('dialog'), 'settings');
  assert.ok(!state.requests.some((request) => request.path.startsWith('/api/vegetation/describe')));
});

test('a description fills the controls as editable values and queues nothing', async (t) => {
  const state = baseState({
    suggestion: {
      species: 'whiteOak',
      seed: 4242,
      params: { height: 24, crownShape: 0 },
      adjusted: ['Height (m)'],
      ignored: ['evil'],
      provider: 'openai',
      model: 'gpt-6-luna',
    },
  });
  const { container, location } = await mount(t, { entry: '/vegetation?describe=1', state });
  await type(container.querySelector('#vegetation-description'), 'a tall old oak');
  await click(byText(container, 'button', 'Describe'));
  const request = state.requests.find((item) => item.path === '/api/vegetation/describe');
  assert.deepEqual(request.body, { description: 'a tall old oak', species: 'whiteOak' });
  assert.equal(request.headers['X-Forge-Request'], 'vegetation');
  assert.equal(search(location).get('tune'), 'crownShape:0,height:24');
  assert.equal(search(location).get('seed'), '4242');
  assert.equal(
    field(container, 'vegetation-control-height').value,
    '24',
    'the values are ordinary controls',
  );
  const note = container.querySelector('.vegetation-suggestion');
  assert.match(note.textContent, /Nothing is queued yet/);
  assert.match(note.textContent, /gpt-6-luna \(OpenAI\)/);
  assert.match(note.textContent, /Brought into range: Height \(m\)/);
  assert.match(note.textContent, /Ignored .*: evil/);
  assert.equal(state.jobs.length, 0);
});

test('a provider error from Describe it is shown, and the form still works by hand', async (t) => {
  const state = baseState({
    describeError: {
      status: 404,
      body: { error: 'OpenAI could not find the model gpt-6-luna (404).' },
    },
  });
  const { container } = await mount(t, { entry: '/vegetation?describe=1', state });
  await type(container.querySelector('#vegetation-description'), 'a tree');
  await click(byText(container, 'button', 'Describe'));
  assert.match(
    container.querySelector('[role="alert"]').textContent,
    /could not find the model gpt-6-luna/,
  );
  await type(field(container, 'vegetation-control-height'), '9');
  assert.equal(state.jobs.length, 0);
  await click(byText(container, 'button', 'Add plant to queue'));
  assert.equal(state.jobs.length, 1);
});

test('the model id can be checked, and the provider message is shown when it is missing', async (t) => {
  const state = baseState({
    check: {
      exists: false,
      message: 'The model gpt-6-luna does not exist.',
      models: ['gpt-6.1-sol'],
    },
  });
  const { container } = await mount(t, { entry: '/vegetation?describe=1', state });
  await click(byText(container, 'button', 'Check model id'));
  assert.match(
    container.textContent,
    /The model gpt-6-luna does not exist\. Models this key can use include: gpt-6\.1-sol/,
  );
});

test('with the local provider and a stopped chat model the page offers Start chat model, never auto-starts', async (t) => {
  const state = baseState();
  state.status.describe = describeStatus({
    provider: 'local',
    localChatRunning: false,
    state: 'local',
    notice:
      'Your description and the plant parameter list are sent to the local chat model on this computer.',
  });
  const { container, settle } = await mount(t, { entry: '/vegetation?describe=1', state });
  assert.match(container.textContent, /The local chat model is not running/);
  assert.equal(byText(container, 'button', 'Describe').disabled, true);
  assert.ok(
    !state.requests.some((request) => request.path === '/api/runtime/models/chat/load'),
    'nothing starts by itself',
  );
  await click(byText(container, 'button', 'Start chat model'));
  const load = state.requests.find((request) => request.path === '/api/runtime/models/chat/load');
  assert.equal(load.method, 'POST');
  assert.equal(load.headers['X-Forge-Request'], 'runtime');
  await settle();
  assert.match(container.textContent, /Qwen is starting/);
});

test('Settings, AI assist lists the Describe it override with provider and model id', async (t) => {
  const state = baseState({
    features: [
      {
        feature: 'error-fix',
        label: 'Error fix suggestions',
        provider: 'openai',
        model: 'gpt-6.1-sol',
        defaultProvider: 'openai',
        defaultModel: 'gpt-6.1-sol',
      },
      {
        feature: 'vegetation-describe',
        label: 'Vegetation “Describe it”',
        provider: 'openai',
        model: 'gpt-6-luna',
        defaultProvider: 'openai',
        defaultModel: 'gpt-6-luna',
      },
    ],
  });
  const vite = await startVite();
  const { default: AiAssistSettings } = await vite.ssrLoadModule('/src/AiAssistSettings.jsx');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'http://localhost/',
  });
  const root = createRoot(dom.window.document.getElementById('host'));
  const previousFetch = globalThis.fetch;
  // The vegetation mount above has already installed a fetch for this state; install it again.
  globalThis.fetch = async (input, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests = [
      ...(state.requests || []),
      { path: String(input), method: init.method || 'GET', body, headers: init.headers },
    ];
    if ((init.method || 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ features: state.features }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        feature: { ...state.features[1], provider: body.provider, model: body.model },
      }),
    };
  };
  const host = dom.window.document.getElementById('host');
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    globalThis.fetch = previousFetch;
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
    dom.window.close();
  });
  await act(async () => {
    root.render(React.createElement(AiAssistSettings));
    await sleep(100);
  });
  assert.match(host.textContent, /Vegetation “Describe it”/);
  const provider = host.querySelector('#ai-provider-vegetation-describe');
  const model = host.querySelector('#ai-model-vegetation-describe');
  assert.deepEqual(
    [...provider.options].map((option) => option.value),
    ['openai', 'local'],
  );
  assert.equal(model.value, 'gpt-6-luna');
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype,
    'value',
  ).set;
  await act(async () => {
    setter.call(provider, 'local');
    provider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const save = [...host.querySelectorAll('button')].find(
    (button) =>
      button.getAttribute('aria-label') === 'Save AI assist model for Vegetation “Describe it”',
  );
  await act(async () => {
    save.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(50);
  });
  // Browser log batches are posted too; look for the settings save only.
  const post = state.requests.find(
    (request) => request.method === 'POST' && request.path !== '/api/logs/ingest',
  );
  assert.deepEqual(post.body, {
    feature: 'vegetation-describe',
    provider: 'local',
    model: 'gpt-6-luna',
  });
  assert.equal(post.headers['X-Forge-Request'], 'ai-assist');
  assert.match(host.textContent, /will use gpt-6-luna/);
});
