import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createI18nStore,
  directionFor,
  formatNumber,
  i18n,
  isRtlLocale,
  normalizeLocale,
  pluralCategoriesFor,
  t,
  tp,
} from '../src/i18n/index.js';
import {
  interpolate,
  parseRichText,
  pseudoLocalize,
  samePlaceholders,
  tagsOf,
} from '../src/i18n/message-format.js';
import { isValidKey, namespacesForSection } from '../src/i18n/namespaces.js';
import { filterLanguages, languageOptions, parseLanguageCode } from '../src/i18n/languages.js';
import { extractAll } from '../tools/i18n-extract.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function germanStore(entries, machine = null) {
  const store = createI18nStore();
  const calls = [];
  store.setLoaders([
    async (locale, namespace) => {
      calls.push(`${locale}/${namespace}`);
      return { entries: entries[namespace] || {}, machine };
    },
  ]);
  return { store, calls };
}

test('without a provider every call returns the English default exactly', () => {
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(t('queue.list.empty', 'No renders yet.'), 'No renders yet.');
  assert.equal(t('queue.item.eta', 'About {minutes} min left', { minutes: 3 }), 'About 3 min left');
  assert.equal(
    tp('queue.list.count', 1, { one: '{count} render', other: '{count} renders' }),
    '1 render',
  );
  assert.equal(
    tp('queue.list.count', 0, { one: '{count} render', other: '{count} renders' }),
    '0 renders',
  );
  // Numbers are not reformatted, so converted code shows the same text as before.
  assert.equal(t('queue.list.total', '{count} items', { count: 12345 }), '12345 items');
  // Invalid keys still fall back to English rather than throwing.
  assert.equal(t('not a key', 'Plain'), 'Plain');
});

test('every extracted English default round-trips unchanged through t and tp', () => {
  const { keys } = extractAll();
  assert.ok(keys.size > 0);
  for (const [key, entry] of keys) {
    if (entry.kind === 'plural') {
      assert.equal(tp(key, 1, entry.value), interpolate(entry.value.one, { count: 1 }), key);
      assert.equal(tp(key, 2, entry.value), interpolate(entry.value.other, { count: 2 }), key);
    } else {
      assert.equal(t(key, entry.value), entry.value, key);
    }
  }
});

test('interpolation keeps unknown placeholders and ignores non-identifier braces', () => {
  assert.equal(
    interpolate('Hi {name}, {missing} {not valid} {}', { name: 'Ana' }),
    'Hi Ana, {missing} {not valid} {}',
  );
  assert.equal(
    interpolate('<b>{x}</b>', { x: '<script>' }),
    '<b><script></b>',
    'values are plain text',
  );
  assert.equal(samePlaceholders('{a} and {b}', '{b} und {a}'), true);
  assert.equal(samePlaceholders('{a} and {b}', '{a} und {c}'), false);
});

test('rich text parses balanced tags and rejects unbalanced ones', () => {
  assert.deepEqual(parseRichText('Open <link>Settings</link> now<br/>'), [
    'Open ',
    { tag: 'link', children: ['Settings'] },
    ' now',
    { tag: 'br', children: [] },
  ]);
  assert.equal(parseRichText('Open <b>Settings'), null);
  assert.equal(parseRichText('a </b> b'), null);
  assert.deepEqual(tagsOf('<b>x</b> <i>y</i>'), ['b', 'i']);
});

test('a loaded catalog translates, falls back per key and ignores stale sources', async () => {
  const { store, calls } = germanStore(
    {
      queue: {
        'queue.list.empty': { value: 'Noch keine Renderings.', source: 'No renders yet.' },
        'queue.list.changed': { value: 'Alt', source: 'Old English text' },
        'queue.list.count': { one: '{count} Rendering', other: '{count} Renderings' },
        'queue.item.eta': 'Noch etwa {minutes} Min.',
      },
    },
    { model: 'gpt-6-luna', translatedAt: '2026-11-08T00:00:00.000Z' },
  );
  store.setLocale('de');
  // First use requests the namespace and shows English until it arrives.
  assert.equal(store.t('queue.list.empty', 'No renders yet.'), 'No renders yet.');
  await settle();
  await settle();
  assert.deepEqual(calls, ['de/queue']);
  assert.equal(store.t('queue.list.empty', 'No renders yet.'), 'Noch keine Renderings.');
  assert.equal(
    store.t('queue.item.eta', 'About {minutes} min left', { minutes: 4 }),
    'Noch etwa 4 Min.',
  );
  assert.equal(store.t('queue.list.changed', 'New English text'), 'New English text');
  assert.equal(store.t('queue.list.missing', 'Missing key'), 'Missing key');
  const forms = { one: '{count} render', other: '{count} renders' };
  assert.equal(store.tp('queue.list.count', 1, forms), '1 Rendering');
  assert.equal(store.tp('queue.list.count', 5, forms), '5 Renderings');
  assert.deepEqual(store.machineInfo(['queue']), {
    model: 'gpt-6-luna',
    translatedAt: '2026-11-08T00:00:00.000Z',
  });
  // The reverse map lets field help find English tooltip keys from translated labels.
  assert.equal(store.englishFor('Noch etwa 4 Min.'), 'About 4 min left');
  assert.equal(store.englishFor('Unrelated'), 'Unrelated');
  store.setShowOriginal(true);
  assert.equal(store.t('queue.list.empty', 'No renders yet.'), 'No renders yet.');
  store.setShowOriginal(false);
  store.setLocale('en');
  assert.equal(store.t('queue.list.empty', 'No renders yet.'), 'No renders yet.');
});

test('plural forms follow the target language rules', async () => {
  const { store } = germanStore({
    queue: {
      'queue.list.files': {
        one: '{count} plik',
        few: '{count} pliki',
        many: '{count} plików',
        other: '{count} pliku',
      },
    },
  });
  store.setLocale('pl');
  store.t('queue.list.files', 'x');
  await settle();
  await settle();
  const forms = { one: '{count} file', other: '{count} files' };
  assert.equal(store.tp('queue.list.files', 1, forms), '1 plik');
  assert.equal(store.tp('queue.list.files', 3, forms), '3 pliki');
  assert.equal(store.tp('queue.list.files', 5, forms), '5 plików');
  assert.equal(store.tp('queue.list.files', 1.5, forms), '1.5 pliku');
  assert.deepEqual(pluralCategoriesFor('ar'), ['zero', 'one', 'two', 'few', 'many', 'other']);
  assert.deepEqual(pluralCategoriesFor('ja'), ['other']);
});

test('a failing loader leaves English in place and listeners are notified on load', async () => {
  const store = createI18nStore();
  store.setLoaders([
    async () => {
      throw Error('offline');
    },
  ]);
  let notified = 0;
  store.subscribe(() => {
    notified += 1;
  });
  store.setLocale('fr');
  assert.equal(store.t('images.form.title', 'Create an image'), 'Create an image');
  await settle();
  await settle();
  assert.equal(store.namespaceStatus('images'), 'failed');
  assert.equal(store.t('images.form.title', 'Create an image'), 'Create an image');
  assert.ok(notified >= 2, 'locale change and load completion notify');
});

test('RTL detection and direction', () => {
  for (const locale of ['ar', 'he', 'fa', 'ur', 'ar-EG', 'he-IL']) {
    assert.equal(isRtlLocale(locale), true, locale);
    assert.equal(directionFor(locale), 'rtl', locale);
  }
  for (const locale of ['en', 'de', 'ja', 'en-XA', 'not a locale']) {
    assert.equal(directionFor(locale), 'ltr', locale);
  }
  assert.equal(normalizeLocale('pt-br'), 'pt-BR');
  assert.equal(normalizeLocale('zz-?'), null);
});

test('the en-XA pseudo-locale accents and expands text but keeps placeholders and tags', () => {
  const pseudo = pseudoLocalize('Save {name} in <b>Settings</b>');
  assert.match(pseudo, /^\[Šåṽé \{name\} îñ <b>Šéţţîñĝš<\/b> ·+\]$/);
  // 14 letters: at least 40% padding (6 dots) plus the brackets.
  assert.ok(pseudo.length >= 'Save {name} in <b>Settings</b>'.length + 6 + 3);
  const store = createI18nStore({ locale: 'en-XA' });
  assert.equal(store.getLocale(), 'en-XA');
  assert.match(store.t('images.form.save', 'Save {name}', { name: 'cube' }), /^\[Šåṽé cube ·+\]$/);
  assert.match(
    store.tp('images.form.files', 2, { one: '{count} file', other: '{count} files' }),
    /^\[2 ƒîļéš/,
  );
  assert.equal(store.englishFor(store.t('images.form.save', 'Save')), 'Save');
});

test('formatters use the browser locale for English and the chosen locale otherwise', () => {
  assert.equal(formatNumber(1234.5), new Intl.NumberFormat().format(1234.5));
  const store = createI18nStore({ locale: 'de' });
  assert.equal(store.formatNumber(1234.5), '1.234,5');
  assert.equal(store.formatList(['a', 'b', 'c']), 'a, b und c');
  assert.equal(store.formatRelativeTime(-1, 'day'), 'gestern');
  assert.equal(store.formatDate('not a date'), '');
  assert.equal(store.formatDuration(-1), '');
  assert.match(createI18nStore().formatDuration(3725), /1.*2.*5/);
});

test('module-scope labels use getters so they translate when read', async () => {
  const { store } = germanStore({ images: { 'images.quality.draft': 'Entwurf' } });
  const labels = {
    get draft() {
      return store.t('images.quality.draft', 'Draft');
    },
  };
  assert.equal(labels.draft, 'Draft');
  assert.deepEqual({ ...labels }, { draft: 'Draft' });
  store.setLocale('de');
  store.t('images.quality.draft', 'Draft');
  await settle();
  await settle();
  assert.equal(labels.draft, 'Entwurf');
});

test('keys, namespaces and language helpers', () => {
  assert.equal(isValidKey('images.form.title'), true);
  assert.equal(isValidKey('3d.tooltip.x3d_model_abcdef'), true);
  assert.equal(isValidKey('images.title'), false);
  assert.equal(isValidKey('unknown.form.title'), false);
  assert.deepEqual(namespacesForSection('images'), [
    'images',
    'shell',
    'common',
    'settings',
    'errors',
    'i18n',
  ]);
  assert.deepEqual(namespacesForSection(null), ['shell', 'common', 'settings', 'errors', 'i18n']);
  assert.deepEqual(parseLanguageCode('pt-br'), { code: 'pt-BR', name: 'Brazilian Portuguese' });
  assert.deepEqual(parseLanguageCode('en-GB'), { error: 'english' });
  assert.deepEqual(parseLanguageCode('xx-$'), { error: 'invalid' });
  assert.deepEqual(parseLanguageCode('qaa'), { error: 'unknown' });
  const options = languageOptions('en');
  assert.ok(options.some((option) => option.code === 'de' && option.name === 'German'));
  assert.deepEqual(
    filterLanguages(options, 'deut').map((option) => option.code),
    ['de'],
  );
  assert.ok(filterLanguages(options, 'francais').some((option) => option.code === 'fr'));
});
