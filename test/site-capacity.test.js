import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';

import {
  ROW_DEFINITIONS,
  STATIC_END,
  STATIC_START,
  assertNoForgottenModel,
  scanModelsFolder,
  staticBlock,
  validateDefinitions,
} from '../tools/model-capacity.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const siteFolder = path.join(repositoryRoot, 'site');
const BYTES_PER_GIB = 1024 ** 3;
const BYTES_PER_GB = 1000 ** 3;

const data = JSON.parse(await fs.readFile(path.join(siteFolder, 'model-capacity.json'), 'utf8'));
const indexHtml = await fs.readFile(path.join(siteFolder, 'index.html'), 'utf8');
const capacitySource = await fs.readFile(path.join(siteFolder, 'capacity.js'), 'utf8');
const { ForgeCapacity } = globalThis;

const round2 = (value) => Math.round(value * 100) / 100;
const decodeText = (value) => new JSDOM(`<p>${value}</p>`).window.document.body.textContent;

test('the capacity JSON has the documented shape', () => {
  assert.equal(data.schemaVersion, 1);
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(typeof data.machine.gpuName, 'string');
  assert.ok(Number.isInteger(data.machine.gpuMemoryMiB) && data.machine.gpuMemoryMiB > 0);
  assert.ok(Array.isArray(data.method) && data.method.length >= 3);
  assert.ok(data.method.every((paragraph) => typeof paragraph === 'string' && paragraph));
  for (const key of ['models', 'supportingEntries', 'bytes', 'gib', 'gb']) {
    assert.ok(Number.isFinite(data.totals[key]), `totals.${key}`);
  }
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0);
  for (const row of data.rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['area', 'bytes', 'card', 'gib', 'id', 'kind', 'name', 'note', 'share'],
      row.name,
    );
    assert.ok(['weights', 'supporting', 'cache'].includes(row.kind), row.name);
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0, row.name);
  }
  assert.equal(typeof data.comparison.text, 'string');
});

test('every row size in GiB matches its bytes and the totals add up', () => {
  for (const row of data.rows) {
    assert.equal(row.gib, round2(row.bytes / BYTES_PER_GIB), row.name);
  }
  const sum = (rows) => rows.reduce((total, row) => total + row.bytes, 0);
  const models = data.rows.filter((row) => row.kind === 'weights');
  const supporting = data.rows.filter((row) => row.kind !== 'weights');
  assert.equal(sum(data.rows), data.totals.bytes);
  assert.equal(sum(models), data.totals.modelBytes);
  assert.equal(sum(supporting), data.totals.supportingBytes);
  assert.equal(models.length, data.totals.models);
  assert.equal(models.filter((row) => row.bytes > 0).length, data.totals.modelsWithWeights);
  assert.equal(supporting.length, data.totals.supportingEntries);
  assert.equal(data.totals.gib, round2(data.totals.bytes / BYTES_PER_GIB));
  assert.equal(data.totals.gb, round2(data.totals.bytes / BYTES_PER_GB));
  assert.equal(data.totals.modelGib, round2(data.totals.modelBytes / BYTES_PER_GIB));
  assert.equal(data.totals.supportingGib, round2(data.totals.supportingBytes / BYTES_PER_GIB));
});

test('shares add up to 100 percent and the rows are sorted by size', () => {
  const shareSum = data.rows.reduce((total, row) => total + row.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 0.001, `shares sum to ${shareSum}`);
  for (const row of data.rows) {
    assert.ok(Math.abs(row.share - row.bytes / data.totals.bytes) < 0.00001, row.name);
  }
  for (let index = 1; index < data.rows.length; index += 1) {
    assert.ok(data.rows[index - 1].bytes >= data.rows[index].bytes, 'sorted by size');
  }
});

test('the GPU comparison follows from the stored sizes', () => {
  const gpuBytes = data.machine.gpuMemoryMiB * 1024 ** 2;
  assert.equal(data.comparison.gpuMemoryBytes, gpuBytes);
  assert.equal(data.comparison.modelWeightsBytes, data.totals.modelBytes);
  assert.equal(data.comparison.modelWeightsToGpuMemory, round2(data.totals.modelBytes / gpuBytes));
  const summary = ForgeCapacity.summarize(data);
  assert.equal(data.comparison.text, ForgeCapacity.compareText(data, summary));
  assert.match(data.comparison.text, /which is why Forge loads one model at a time/);
});

test('every row links to a real card, and model rows carry the card title', () => {
  const dom = new JSDOM(indexHtml);
  const { document } = dom.window;
  const cards = [...document.querySelectorAll('article.model')];
  const modelCards = cards.filter((card) => !card.classList.contains('model-support'));
  const modelRows = data.rows.filter((row) => row.kind === 'weights');
  assert.equal(modelRows.length, modelCards.length, 'one row per model card');
  for (const row of data.rows) {
    const card = document.getElementById(row.card);
    assert.ok(card?.classList.contains('model'), `${row.name} -> #${row.card}`);
    if (row.kind === 'weights') {
      assert.equal(card.querySelector('h3').textContent, row.name);
    } else {
      assert.ok(card.classList.contains('model-support'), `${row.name} is supporting`);
    }
  }
  assert.equal(new Set(modelRows.map((row) => row.card)).size, modelRows.length);
});

test('the JSON holds no absolute path, user name or host name', () => {
  const text = JSON.stringify(data);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
  assert.doesNotMatch(text, /\\\\|\/Users\/|\/home\/|\/mnt\//);
  const privateValues = [os.userInfo().username, os.hostname(), repositoryRoot];
  for (const value of privateValues) {
    if (value.length >= 3) {
      assert.ok(!text.toLowerCase().includes(value.toLowerCase()), 'private value in JSON');
    }
  }
});

test('the no-JavaScript table in index.html is exactly what the JSON produces', () => {
  assert.equal(indexHtml.split(STATIC_START).length, 2, 'one start marker');
  assert.equal(indexHtml.split(STATIC_END).length, 2, 'one end marker');
  const start = indexHtml.indexOf(STATIC_START);
  const end = indexHtml.indexOf(STATIC_END) + STATIC_END.length;
  assert.equal(indexHtml.slice(start, end), staticBlock(data));

  // An independent read of the stored table, not through the generator.
  const { document } = new JSDOM(indexHtml).window;
  const root = document.getElementById('capacity-root');
  const bodyRows = [...root.querySelectorAll('tbody tr')];
  assert.equal(bodyRows.length, data.rows.length);
  bodyRows.forEach((tr, index) => {
    const row = data.rows[index];
    const cells = tr.querySelectorAll('th, td');
    assert.equal(cells[0].querySelector('a').textContent, row.name);
    assert.equal(cells[0].querySelector('a').getAttribute('href'), `#${row.card}`);
    assert.equal(cells[1].textContent, row.area);
    assert.equal(Number(cells[2].textContent.replaceAll(',', '')), row.gib);
    assert.ok(cells[3].textContent.endsWith('%'));
    assert.equal(cells[4].textContent, ForgeCapacity.KIND_LABELS[row.kind]);
  });
  const total = root.querySelector('tfoot tr').children;
  assert.equal(Number(total[2].textContent.replaceAll(',', '')), data.totals.gib);
  assert.match(total[0].textContent, new RegExp(`${data.rows.length} entries`));
  const tileValues = [...root.querySelectorAll('.cap-tile-value')].map((node) => node.textContent);
  assert.equal(tileValues[0], String(data.totals.models));
  assert.ok(tileValues[1].startsWith(ForgeCapacity.formatGiB(data.totals.bytes)));
  assert.ok(root.textContent.includes('sizes are on-disk bytes, not parameter counts'));
  assert.ok(root.textContent.includes('GiB = 1,024³ bytes; GB = 1,000³ bytes'));
  assert.ok(root.textContent.includes(data.generatedAt.slice(0, 10)));
});

test('the page loads capacity.js deferred, from its own folder, and nothing external', () => {
  const { document } = new JSDOM(indexHtml).window;
  const script = document.querySelector('script[src="capacity.js"]');
  assert.ok(script?.hasAttribute('defer'));
  for (const element of document.querySelectorAll('script[src]')) {
    assert.ok(!/^[a-z]+:|^\/\//i.test(element.getAttribute('src')), element.outerHTML);
  }
  assert.ok(document.getElementById('capacity'));
  assert.equal(document.getElementById('capacity-root').dataset.capacitySrc, 'model-capacity.json');
});

async function openPage({ fetchImplementation }) {
  const dom = new JSDOM(indexHtml, { runScripts: 'outside-only', url: 'https://example.test/' });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
  }
  dom.window.fetch = fetchImplementation;
  dom.window.eval(capacitySource);
  await dom.window.ForgeCapacity.ready;
  return dom;
}

const respondWith = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('the browser renders tiles and a sortable table from the JSON', async () => {
  const dom = await openPage({ fetchImplementation: respondWith(data) });
  const { document } = dom.window;
  const root = document.getElementById('capacity-root');
  assert.equal(root.dataset.capacityState, 'interactive');

  const tiles = [...root.querySelectorAll('.cap-tile-value')].map((node) => node.textContent);
  assert.equal(tiles[0], String(data.totals.models));
  assert.equal(tiles[1], `${ForgeCapacity.formatGiB(data.totals.bytes)} GiB`);
  assert.equal(tiles[2], `${ForgeCapacity.formatGiB(data.totals.modelBytes)} GiB`);
  assert.equal(tiles[3], data.rows.find((row) => row.kind === 'weights').name);
  assert.match(tiles[4], /^\d+\.\d×$/);

  const names = () =>
    [...root.querySelectorAll('tbody th a')].map((link) => decodeText(link.innerHTML));
  assert.deepEqual(
    names(),
    data.rows.map((row) => row.name),
  );
  const sortState = (label) =>
    [...root.querySelectorAll('thead th')].find((th) => th.textContent.includes(label));
  assert.equal(sortState('Size on disk').getAttribute('aria-sort'), 'descending');
  assert.equal(sortState('Model').getAttribute('aria-sort'), 'none');

  sortState('Model').querySelector('button').click();
  assert.equal(sortState('Model').getAttribute('aria-sort'), 'ascending');
  assert.equal(sortState('Size on disk').getAttribute('aria-sort'), 'none');
  const alphabetical = data.rows.map((row) => row.name).sort((a, b) => a.localeCompare(b, 'en'));
  assert.deepEqual(names(), alphabetical);

  sortState('Model').querySelector('button').click();
  assert.equal(sortState('Model').getAttribute('aria-sort'), 'descending');
  assert.deepEqual(names(), [...alphabetical].reverse());

  sortState('Size on disk').querySelector('button').click();
  assert.equal(sortState('Size on disk').getAttribute('aria-sort'), 'descending');
  assert.deepEqual(
    names(),
    data.rows.map((row) => row.name),
  );
  sortState('Size on disk').querySelector('button').click();
  assert.equal(sortState('Size on disk').getAttribute('aria-sort'), 'ascending');
  assert.equal(names().at(-1), data.rows[0].name);

  const status = root.querySelector('[data-capacity-status]');
  assert.equal(status.textContent, 'Sorted by Size on disk (GiB), ascending.');
  assert.equal(root.querySelectorAll('tbody tr').length, data.rows.length);
  const footer = root.querySelector('tfoot tr').children;
  assert.equal(footer[2].textContent, ForgeCapacity.formatGiB(data.totals.bytes));
});

test('the browser computes the same totals the JSON stores', () => {
  const summary = ForgeCapacity.summarize(data);
  assert.equal(summary.totalBytes, data.totals.bytes);
  assert.equal(summary.modelBytes, data.totals.modelBytes);
  assert.equal(summary.otherBytes, data.totals.supportingBytes);
  assert.equal(summary.modelRows.length, data.totals.models);
  const ratio = Math.round(summary.weightsToGpuRatio * 100) / 100;
  assert.equal(ratio, data.comparison.modelWeightsToGpuMemory);
});

test('the pre-rendered table stays when the JSON cannot be loaded', async () => {
  const failures = {
    'a network error': async () => {
      throw new Error('offline');
    },
    'an HTTP error': async () => ({ ok: false, status: 404, json: async () => ({}) }),
    'unreadable JSON': async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    }),
    'JSON of the wrong shape': respondWith({ rows: [] }),
    'rows with no sizes': respondWith({
      ...data,
      rows: data.rows.map((row) => ({ ...row, bytes: 0 })),
    }),
  };
  for (const [label, fetchImplementation] of Object.entries(failures)) {
    const dom = new JSDOM(indexHtml, { runScripts: 'outside-only', url: 'https://example.test/' });
    if (dom.window.document.readyState !== 'complete') {
      await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
    }
    const root = dom.window.document.getElementById('capacity-root');
    const before = root.innerHTML;
    dom.window.fetch = fetchImplementation;
    dom.window.eval(capacitySource);
    await assert.doesNotReject(dom.window.ForgeCapacity.ready, label);
    assert.equal(root.innerHTML, before, label);
    assert.equal(root.dataset.capacityState, 'static', label);
    assert.equal(root.querySelectorAll('button').length, 0, label);
  }
});

test('the table mapping covers every folder the catalog knows exactly once', () => {
  const owner = validateDefinitions();
  assert.ok(owner.size >= 22);
  const ids = ROW_DEFINITIONS.map((definition) => definition.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.throws(
    () =>
      validateDefinitions([
        { id: 'a', folders: ['x'] },
        { id: 'b', folders: ['x'] },
      ]),
    /mapped to both/,
  );
  assert.throws(() => validateDefinitions([{ id: 'a', folders: [] }]), /no table row maps it/);
});

test('the scan counts hard-linked files once and refuses a forgotten large folder', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-capacity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const definitions = [
    { id: 'model', kind: 'weights', folders: ['model-a'] },
    { id: 'cache', kind: 'cache', folders: ['cache-b'] },
    { id: 'other', kind: 'supporting', folders: [] },
  ];
  const owner = new Map([
    ['model-a', 'model'],
    ['cache-b', 'cache'],
  ]);
  await fs.mkdir(path.join(root, 'model-a'));
  await fs.mkdir(path.join(root, 'cache-b'));
  await fs.writeFile(path.join(root, 'model-a', 'weights.bin'), Buffer.alloc(1000));
  await fs.link(path.join(root, 'model-a', 'weights.bin'), path.join(root, 'cache-b', 'copy.bin'));
  await fs.writeFile(path.join(root, 'cache-b', 'own.bin'), Buffer.alloc(300));

  const scan = await scanModelsFolder(root, owner, definitions);
  assert.equal(scan.folders.get('model-a').bytes, 1000, 'the model owns the shared file');
  assert.equal(scan.folders.get('cache-b').bytes, 300, 'the cache does not count it again');
  assert.equal(scan.folders.get('cache-b').nameBytes, 1300, 'but its names add up to more');
  assert.equal(scan.sharedWithOutsideFiles, 0);

  await fs.mkdir(path.join(root, 'new-model'));
  await fs.writeFile(path.join(root, 'new-model', 'big.bin'), Buffer.alloc(101 * 1024 * 1024));
  await fs.mkdir(path.join(root, 'tiny'));
  await fs.writeFile(path.join(root, 'tiny', 'note.txt'), 'x');
  const withNew = await scanModelsFolder(root, owner, definitions);
  assert.throws(
    () => assertNoForgottenModel(withNew.folders, owner),
    /Unmapped folder\(s\) over 100 MiB: new-model/,
  );
  assert.equal(withNew.folders.get('tiny').rowId, 'other', 'small leftovers go to the catch-all');
});

test('the README totals and the docs match the JSON', async () => {
  const readme = await fs.readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
  const guide = await fs.readFile(path.join(repositoryRoot, 'docs', 'STUDIO_GUIDE.md'), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json')));
  const gib = ForgeCapacity.formatGiB(data.totals.bytes);
  const gb = ForgeCapacity.formatGB(data.totals.bytes);
  assert.ok(readme.includes(`total ${gib} GiB (${gb} GB) of files`), 'README total');
  assert.ok(
    readme.includes(`the ${data.totals.models} models and ${data.totals.supportingEntries}`),
  );
  assert.ok(readme.includes(`measured ${data.generatedAt.slice(0, 10)}`));
  assert.ok(guide.includes('### Refreshing the capacity figures'));
  assert.ok(guide.includes(`the tool reports ${gib} GiB (${gb} GB)`), 'guide total');
  assert.equal(packageJson.scripts['site:capacity'], 'node tools/model-capacity.mjs');
});
