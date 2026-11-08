// Message syntax shared by the browser, the translation service and the i18n tools.
//
// - `{name}` is a placeholder. Names are code identifiers; any other brace text is literal.
// - `<name>…</name>` and `<name/>` are rich-text tags, used only by the <T> component.
// - Plurals are separate strings per CLDR category ({ one, other, … }), chosen by tp().
// The functions here never produce HTML: React renders the result as text.

export const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)\s*(\/?)>/g;
const TOKEN = /(\{[A-Za-z_][A-Za-z0-9_]*\}|<\/?[A-Za-z][A-Za-z0-9]*\s*\/?>)/;

export const PLURAL_CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);

/** Placeholder names in order of appearance, duplicates kept. */
export function placeholdersOf(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]);
}

/** Same placeholders, ignoring order: translations may reorder them. */
export function samePlaceholders(left, right) {
  const leftNames = placeholdersOf(left).sort();
  const rightNames = placeholdersOf(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index])
  );
}

/**
 * Replaces `{name}` with String(params[name]). Unknown placeholders stay as written, so a missing
 * parameter is visible instead of silently disappearing. Numbers are not reformatted: call
 * formatNumber() explicitly when the original code did.
 */
export function interpolate(template, params) {
  const text = String(template ?? '');
  if (!params) {
    return text;
  }
  return text.replace(PLACEHOLDER, (whole, name) =>
    Object.hasOwn(params, name) && params[name] !== undefined && params[name] !== null
      ? String(params[name])
      : whole,
  );
}

/**
 * Parses rich text into nodes: strings and { tag, children } objects. Returns null when the tags
 * are not balanced, so callers can fall back to plain text.
 */
export function parseRichText(text) {
  const root = { tag: null, children: [] };
  const stack = [root];
  let last = 0;
  const source = String(text ?? '');
  for (const match of source.matchAll(TAG)) {
    if (match.index > last) {
      stack.at(-1).children.push(source.slice(last, match.index));
    }
    last = match.index + match[0].length;
    const [, closing, name, selfClosing] = match;
    if (selfClosing) {
      stack.at(-1).children.push({ tag: name, children: [] });
    } else if (closing) {
      if (stack.length < 2 || stack.at(-1).tag !== name) {
        return null;
      }
      stack.pop();
    } else {
      const node = { tag: name, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
    }
  }
  if (stack.length !== 1) {
    return null;
  }
  if (last < source.length) {
    root.children.push(source.slice(last));
  }
  return root.children;
}

/** Tag names in document order (opening and self-closing tags only), or null if unbalanced. */
export function tagsOf(text) {
  const tree = parseRichText(text);
  if (!tree) {
    return null;
  }
  const names = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (typeof node !== 'string') {
        names.push(node.tag);
        walk(node.children);
      }
    }
  };
  walk(tree);
  return names;
}

/** Plain text of rich text: tags removed, their content kept. */
export function stripTags(text) {
  return String(text ?? '').replace(TAG, '');
}

const ACCENTS = {
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

/**
 * The en-XA pseudo-locale: accented letters, about 40% longer, wrapped in brackets. Placeholders
 * and tags are kept intact. Hard-coded English stays plain and truncated text loses its bracket.
 */
export function pseudoLocalize(text) {
  const source = String(text ?? '');
  if (!source.trim()) {
    return source;
  }
  let letters = 0;
  const body = source
    .split(TOKEN)
    .map((part) => {
      if (TOKEN.test(part)) {
        return part;
      }
      return part.replace(/[A-Za-z]/g, (letter) => {
        letters += 1;
        return ACCENTS[letter];
      });
    })
    .join('');
  const padding = Math.max(1, Math.ceil(letters * 0.4));
  return `[${body} ${'·'.repeat(padding)}]`;
}

/** 32-bit FNV-1a as 8 hex digits; stable in browsers and Node for generated keys. */
export function shortHash(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Generated key for a field-help tooltip: `<section>.tooltip.<slug>_<hash>`. The label is the
 * English key in src/tooltips/pages/<section>.js; the hash keeps similar labels distinct.
 */
export function tooltipKey(section, label) {
  const slug =
    String(label)
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .slice(0, 40)
      .replace(/_+$/, '') || 'label';
  const safe = /^[a-z]/.test(slug) ? slug : `x${slug}`;
  return `${section}.tooltip.${safe}_${shortHash(label).slice(0, 6)}`;
}
