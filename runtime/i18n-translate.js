// Builds OpenAI Responses API requests that translate shipped English UI strings, and validates
// every returned string before it is stored. Only catalog strings (key + English text) are ever
// placed in a request; nothing here reads projects, prompts, files or any user content.
import { createLogger } from './app-log.js';
import {
  PLURAL_CATEGORIES,
  parseRichText,
  placeholdersOf,
  samePlaceholders,
  tagsOf,
} from '../src/i18n/message-format.js';
import { PROTECTED_TERMS, glossaryFor } from './i18n-glossary.js';

const log = createLogger('i18n');

export const CHUNK_SIZE = 80;
export const TRANSLATE_TIMEOUT_MS = 90000;
export const MAX_OUTPUT_TOKENS = 16000;

export const REJECTION_REASONS = Object.freeze({
  missing: 'missing from the response',
  type: 'wrong value type',
  empty: 'empty translation',
  placeholder: 'placeholder mismatch',
  tags: 'rich-text tag mismatch',
  markup: 'unexpected markup or script',
  control: 'unexpected control characters or line breaks',
  length: 'length out of range',
  product: 'product or model name changed',
  plural: 'plural forms do not match the language',
});

/** CLDR plural categories needed by a target language, in canonical order. */
export function pluralCategoriesFor(locale) {
  try {
    const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    return PLURAL_CATEGORIES.filter((category) => categories.includes(category));
  } catch (failure) {
    log.debug('i18n.plural.rules.failed', { locale, errorClass: failure?.name });
    return ['one', 'other'];
  }
}

export function chunk(items, size = CHUNK_SIZE) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

const INSTRUCTIONS = [
  'You translate the user interface of Forge, a desktop game asset studio, from English.',
  'Return only a JSON object that maps every given key to its translation, with no other keys.',
  'Rules:',
  '- Keep every {placeholder} exactly as written, including its name; you may move it.',
  '- Keep rich-text tags such as <b>…</b>, <link>…</link> and <br/> with the same names, around',
  '  the matching words. Do not add HTML, Markdown, quotes or explanations.',
  '- Keep product, model and format names untranslated (for example Forge, GPU, CUDA, OpenAI,',
  '  TRELLIS.2, Hunyuan3D, HY-Motion, Megascans, SAM 3.1, PNG, MiB).',
  '- Use the glossary terms when they appear. Keep units and numbers as written.',
  '- Be concise: these are buttons, labels and short messages. Use the tone of a polished',
  '  desktop application and the formal register where the language distinguishes one.',
  '- For plural entries return an object with exactly the listed categories; use {count} where',
  '  the number belongs.',
].join('\n');

/**
 * Builds the exact Responses API body for one chunk.
 * @param {{ locale: string, languageName: string, model: string,
 *   items: Array<{ key: string, value: string | Record<string, string> }> }} options
 */
export function buildTranslationRequest({ locale, languageName, model, items }) {
  const categories = pluralCategoriesFor(locale);
  const strings = {};
  const properties = {};
  for (const item of items) {
    if (typeof item.value === 'string') {
      strings[item.key] = item.value;
      properties[item.key] = { type: 'string' };
    } else {
      strings[item.key] = { plural: true, categories, english: item.value };
      properties[item.key] = {
        type: 'object',
        properties: Object.fromEntries(
          categories.map((category) => [category, { type: 'string' }]),
        ),
        required: categories,
        additionalProperties: false,
      };
    }
  }
  const input = JSON.stringify(
    {
      target_language: `${languageName} (${locale})`,
      glossary: glossaryFor(locale),
      strings,
    },
    null,
    1,
  );
  return {
    model,
    instructions: INSTRUCTIONS,
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
    text: {
      format: {
        type: 'json_schema',
        name: 'ui_translations',
        strict: true,
        schema: {
          type: 'object',
          properties,
          required: Object.keys(properties),
          additionalProperties: false,
        },
      },
    },
  };
}

// Control characters other than tab (9) and line feed (10).
function hasControlCharacter(text) {
  return [...text].some((char) => {
    const code = char.codePointAt(0);
    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });
}
const MARKUP = /<\s*\/?\s*[A-Za-z!?]|javascript:|\bon[a-z]+\s*=|&#|&[a-z]+;/i;

function sortedTags(text) {
  const tags = tagsOf(text);
  return tags ? [...tags].sort().join(',') : null;
}

function protectedTermsIn(text) {
  return PROTECTED_TERMS.filter((term) =>
    new RegExp(
      `(?<![A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`,
    ).test(text),
  );
}

/** Checks one translated string against its English source; returns a reason key or ''. */
export function checkText(english, translated, { allowMissingCount = false } = {}) {
  if (typeof translated !== 'string') {
    return 'type';
  }
  if (!translated.trim()) {
    return 'empty';
  }
  if (hasControlCharacter(translated) || (/\n/.test(translated) && !/\n/.test(english))) {
    return 'control';
  }
  const englishTags = sortedTags(english);
  const translatedTags = sortedTags(translated);
  if (translatedTags === null || translatedTags !== englishTags) {
    return 'tags';
  }
  // With the known tags removed, nothing that looks like markup may remain.
  const tree = parseRichText(translated);
  const plain = [];
  const collect = (nodes) =>
    nodes.forEach((node) => (typeof node === 'string' ? plain.push(node) : collect(node.children)));
  collect(tree);
  if (MARKUP.test(plain.join(' '))) {
    return 'markup';
  }
  if (allowMissingCount) {
    const expected = new Set(placeholdersOf(english).filter((name) => name !== 'count'));
    const actual = placeholdersOf(translated).filter((name) => name !== 'count');
    if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) {
      return 'placeholder';
    }
  } else if (!samePlaceholders(english, translated)) {
    return 'placeholder';
  }
  const englishLength = english.length;
  if (
    translated.length > Math.max(englishLength * 4 + 20, 40) ||
    (englishLength >= 20 && translated.length < englishLength * 0.15)
  ) {
    return 'length';
  }
  if (protectedTermsIn(english).some((term) => !protectedTermsIn(translated).includes(term))) {
    return 'product';
  }
  return '';
}

/** Validates a translated value (string or plural forms) for a target locale. */
export function validateTranslation(englishValue, translated, locale) {
  if (typeof englishValue === 'string') {
    return checkText(englishValue, translated);
  }
  const categories = pluralCategoriesFor(locale);
  if (!translated || typeof translated !== 'object' || Array.isArray(translated)) {
    return 'type';
  }
  const keys = Object.keys(translated);
  if (
    keys.length !== categories.length ||
    categories.some((category) => !keys.includes(category))
  ) {
    return 'plural';
  }
  for (const category of categories) {
    const source = englishValue[category] || englishValue.other;
    const reason = checkText(source, translated[category], {
      allowMissingCount: category !== 'other',
    });
    if (reason) {
      return reason;
    }
  }
  return '';
}

// UI fragments can rely on a leading or trailing space; the English edges are kept as written.
function keepEdges(english, translated) {
  const lead = /^\s*/.exec(english)[0];
  const trail = /\s*$/.exec(english)[0];
  const core = translated.trim();
  return core ? `${lead}${core}${trail}` : core;
}

/**
 * Parses the model's JSON and validates every requested key. Extra keys are ignored and
 * reported; each invalid string is rejected on its own and the others are kept.
 */
export function parseTranslationOutput(text, items, locale) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (failure) {
    // The caller rejects every key as missing; log the cause without the model output.
    log.warn('i18n.output.parse.failed', {
      locale,
      reason: 'invalid_json',
      errorClass: failure?.name,
    });
    data = null;
  }
  const accepted = new Map();
  const rejected = [];
  const wanted = new Set(items.map((item) => item.key));
  const extraKeys =
    data && typeof data === 'object' ? Object.keys(data).filter((key) => !wanted.has(key)) : [];
  for (const item of items) {
    if (!data || typeof data !== 'object' || !Object.hasOwn(data, item.key)) {
      rejected.push({ key: item.key, reason: 'missing' });
      continue;
    }
    const raw = data[item.key];
    const englishEdge = typeof item.value === 'string' ? item.value : item.value.other;
    const value =
      typeof raw === 'string'
        ? keepEdges(englishEdge, raw)
        : raw && typeof raw === 'object' && !Array.isArray(raw)
          ? Object.fromEntries(
              Object.entries(raw).map(([category, form]) => [
                category,
                typeof form === 'string' ? keepEdges(englishEdge, form) : form,
              ]),
            )
          : raw;
    const reason = validateTranslation(item.value, value, locale);
    if (reason) {
      rejected.push({ key: item.key, reason });
    } else {
      accepted.set(item.key, value);
    }
  }
  return { accepted, rejected, extraKeys, isJson: Boolean(data) };
}
