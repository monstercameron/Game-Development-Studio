// Languages offered by "Translate this page…". Any other valid BCP 47 code can be typed in.
import { PSEUDO_LOCALE, normalizeLocale } from './i18n-core.js';

export const COMMON_LANGUAGE_CODES = Object.freeze([
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'es-419',
  'et',
  'fa',
  'fi',
  'fil',
  'fr',
  'fr-CA',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'nb',
  'nl',
  'pl',
  'pt-BR',
  'pt-PT',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh-Hans',
  'zh-Hant',
]);

function displayName(code, displayLocale) {
  try {
    return new Intl.DisplayNames([displayLocale], { type: 'language', fallback: 'none' }).of(code);
    // log-coverage: ignore -- pure helper; a display name is optional and the code is the fallback.
  } catch {
    return undefined;
  }
}

/** { code, name, nativeName } with the name in the UI language, sorted by name. */
export function languageOptions(displayLocale = 'en', codes = COMMON_LANGUAGE_CODES) {
  const uiLocale = displayLocale === PSEUDO_LOCALE ? 'en' : displayLocale;
  return codes
    .map((code) => ({
      code,
      name: displayName(code, uiLocale) || displayName(code, 'en') || code,
      nativeName: displayName(code, code) || code,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, uiLocale));
}

/**
 * Checks a typed language code. Returns { code, name } for a known target language, or
 * { error } with 'empty', 'invalid', 'english' or 'unknown'.
 */
export function parseLanguageCode(input) {
  if (!String(input || '').trim()) {
    return { error: 'empty' };
  }
  const code = normalizeLocale(input);
  if (!code) {
    return { error: 'invalid' };
  }
  const language = code.split('-')[0].toLowerCase();
  if (language === 'en') {
    return { error: 'english' };
  }
  const name =
    displayName(language, 'en') && (displayName(code, 'en') || displayName(language, 'en'));
  return name ? { code, name } : { error: 'unknown' };
}

/** Filters options by name, native name or code, case- and accent-insensitively. */
export function filterLanguages(options, query) {
  const fold = (text) => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const needle = fold(query).trim();
  if (!needle) {
    return options;
  }
  return options.filter((option) =>
    [option.code, option.name, option.nativeName].some((value) => fold(value).includes(needle)),
  );
}
