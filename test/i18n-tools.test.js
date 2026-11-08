import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildOutputs,
  compareOutputs,
  extractAll,
  extractTooltips,
  writeOutputs,
} from '../tools/i18n-extract.mjs';
import { looksLikeUiText, scanSource } from '../tools/i18n-scan.mjs';
import { tooltipKey } from '../src/i18n/message-format.js';

const fixtures = fileURLToPath(new URL('./fixtures/i18n/', import.meta.url));
const converted = path.join(fixtures, 'Converted.jsx');
const broken = path.join(fixtures, 'Broken.jsx');
const unwrapped = path.join(fixtures, 'Unwrapped.jsx');

test('extractor collects t, tp, <T>, aliases and module-scope getters with static defaults', () => {
  const { keys, errors } = extractAll({ files: [converted], tooltipDirectory: null });
  assert.deepEqual(errors, []);
  assert.deepEqual([...keys.keys()].sort(), [
    'images.converted.files',
    'images.converted.help',
    'images.converted.region',
    'images.converted.save',
    'images.converted.saving',
    'images.converted.title',
    'images.quality.draft',
  ]);
  assert.equal(keys.get('images.converted.save').value, 'Save changes', 'const default resolved');
  assert.deepEqual(keys.get('images.converted.files').value, {
    one: '{count} file',
    other: '{count} files',
  });
  assert.equal(keys.get('images.converted.files').kind, 'plural');
  assert.equal(keys.get('images.converted.help').value, 'Open <link>Settings</link> to add a key.');
});

test('extractor reports dynamic keys, bad keys, non-static defaults and duplicates', () => {
  const { errors } = extractAll({ files: [converted, broken], tooltipDirectory: null });
  const messages = errors.map((item) => `${path.basename(item.file)}:${item.line} ${item.message}`);
  const expect = (pattern) =>
    assert.ok(
      messages.some((message) => pattern.test(message)),
      `${pattern} in ${messages.join('\n')}`,
    );
  expect(/Dynamic key/);
  expect(/Duplicate key "images\.converted\.title"/);
  expect(/Unknown namespace "nowhere"/);
  expect(/Malformed key "images\.notEnoughSegments"/);
  expect(/"images\.broken\.label": the English default must be a static string/);
  expect(/"images\.broken\.plural": tp\(\) needs "one" and "other"/);
  expect(/"images\.broken\.rich": rich-text tags are not balanced/);
  assert.equal(errors.length, 7);
});

test('extractor writes sorted namespace catalogs and a manifest, and --check sees edits', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-i18n-extract-'));
  try {
    const catalogDirectory = path.join(directory, 'en');
    const manifestFile = path.join(directory, 'manifest.json');
    const { keys } = extractAll({ files: [converted], tooltipDirectory: null });
    const outputs = buildOutputs(keys);
    assert.deepEqual(compareOutputs(outputs, { catalogDirectory, manifestFile }).length, 2);
    writeOutputs(outputs, { catalogDirectory, manifestFile });
    assert.deepEqual(compareOutputs(outputs, { catalogDirectory, manifestFile }), []);
    const catalog = JSON.parse(fs.readFileSync(path.join(catalogDirectory, 'images.json'), 'utf8'));
    assert.deepEqual(Object.keys(catalog), Object.keys(catalog).sort());
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    assert.match(manifest.keys['images.converted.title'].hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(manifest.keys['images.converted.title'].files, [
      'test/fixtures/i18n/Converted.jsx',
    ]);

    // A default edited in code without regenerating is reported as stale.
    catalog['images.converted.title'] = 'Edited by hand';
    fs.writeFileSync(path.join(catalogDirectory, 'images.json'), JSON.stringify(catalog));
    assert.deepEqual(compareOutputs(outputs, { catalogDirectory, manifestFile }), [
      'images.json is out of date',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('tooltip pages become <section>.tooltip.<slug> keys so the server can translate them', () => {
  const source = [
    "const images = { Seed: 'Repeat a result.', 'Aspect ratio': 'Choose ' + 'the shape.' };",
    'export default images;',
  ].join('\n');
  const { entries, errors } = extractTooltips(source, 'images.js', 'images');
  assert.deepEqual(errors, []);
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.value]),
    [
      [tooltipKey('images', 'Seed'), 'Repeat a result.'],
      [tooltipKey('images', 'Aspect ratio'), 'Choose the shape.'],
    ],
  );
  assert.match(tooltipKey('images', 'Aspect ratio'), /^images\.tooltip\.aspect_ratio_[0-9a-f]{6}$/);
  assert.match(tooltipKey('3d', '3D model'), /^3d\.tooltip\.x3d_model_[0-9a-f]{6}$/);
});

test('scanner lists visible English with line numbers and ignores code-like strings', () => {
  const findings = scanSource(fs.readFileSync(unwrapped, 'utf8'), 'Unwrapped.jsx');
  const texts = findings.map((item) => item.text);
  assert.deepEqual(texts, [
    'Draft quality',
    'Render settings',
    'Describe the scene',
    'Scene description',
    'Forge logo preview',
    'Saving…',
    'Save',
    'Saved to the project.',
    'Working',
    'Start',
    'Too many files were selected.',
    'Choose one file before rendering.',
  ]);
  const byText = Object.fromEntries(findings.map((item) => [item.text, item]));
  assert.equal(byText['Render settings'].kind, 'jsx-text');
  assert.equal(byText['Render settings'].line, 10);
  assert.equal(byText['Scene description'].kind, 'attribute');
  assert.equal(byText['Saved to the project.'].kind, 'message');
  assert.equal(byText['Too many files were selected.'].kind, 'error-message');
  // Class names, ids, URLs, MIME types, symbols, console text and ignored lines are not reported.
  for (const absent of [
    'outline-button',
    'grid-view',
    'unwrapped-root',
    'https://example.com/docs',
    'image/png',
    '·',
    'Forge Studio Pro',
    'Debug message that should be ignored.',
  ]) {
    assert.ok(!texts.includes(absent), absent);
  }
});

test('scanner finds nothing left in a converted file', () => {
  assert.deepEqual(scanSource(fs.readFileSync(converted, 'utf8'), 'Converted.jsx'), []);
});

test('looksLikeUiText keeps a low false-positive rate on common non-UI values', () => {
  for (const value of [
    'forge-model',
    'image/png',
    'https://x.test/a',
    '#ff00aa',
    '12px',
    'snake_case_id',
    'camelCaseName',
    'MAX_ITEMS',
    'GPU',
    'TRELLIS.2',
    'model.glb',
    'var(--forge-text)',
    '→',
  ]) {
    assert.equal(looksLikeUiText(value), false, value);
  }
  for (const value of ['Save', 'Open settings', 'GPU memory is low.', 'No renders yet']) {
    assert.equal(looksLikeUiText(value), true, value);
  }
});

test('the pilot files are fully converted and their keys extract cleanly', async () => {
  const sources = ['src/ForceStopDialog.jsx', 'src/ErrorsButton.jsx', 'src/tooltips/FieldHelp.jsx'];
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const file of sources) {
    assert.deepEqual(
      scanSource(fs.readFileSync(path.join(root, file), 'utf8'), file),
      [],
      `${file} has unwrapped strings`,
    );
  }
  const { errors } = extractAll();
  assert.deepEqual(
    errors.filter((item) => sources.includes(item.file)),
    [],
  );
});
