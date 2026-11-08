// The i18n store: active locale, lazily loaded catalogs, t()/tp() and locale-bound formatters.
//
// English text lives in the code as the default argument of t()/tp()/<T>. With the default locale
// ('en'), no catalog is loaded and every call returns exactly that English text, so the studio
// works and existing tests pass without a provider. Other locales load one namespace catalog at a
// time on first use; a missing or stale string falls back to the English default.
import { createLog } from '../app-log.js';
import { isValidKey, namespaceOf } from './namespaces.js';
import { interpolate, pseudoLocalize, PLURAL_CATEGORIES } from './message-format.js';

export const DEFAULT_LOCALE = 'en';
export const PSEUDO_LOCALE = 'en-XA';

// Right-to-left scripts. Intl.Locale#getTextInfo is used when available; this list covers
// runtimes without it.
const RTL_LANGUAGES = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']);
const REVERSE_LIMIT = 4000;
// t() and tp() run on every render, so they never log; only catalog and locale outcomes do.
const log = createLog('i18n');

/** Canonical BCP-47 tag, or null when the input is not a valid language tag. */
export function normalizeLocale(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 35) {
    return null;
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(input.trim());
    return canonical || null;
    // log-coverage: ignore -- malformed tags are expected input; isRtlLocale runs on every render.
  } catch {
    return null;
  }
}

export function isRtlLocale(locale) {
  const canonical = normalizeLocale(locale);
  if (!canonical) {
    return false;
  }
  const language = canonical.split('-')[0].toLowerCase();
  if (RTL_LANGUAGES.has(language)) {
    return true;
  }
  try {
    const intlLocale = new Intl.Locale(canonical);
    const textInfo =
      typeof intlLocale.getTextInfo === 'function' ? intlLocale.getTextInfo() : intlLocale.textInfo;
    return textInfo?.direction === 'rtl';
    // log-coverage: ignore -- runs on every render through directionFor(); unsupported runtimes read LTR.
  } catch {
    return false;
  }
}

export function directionFor(locale) {
  return isRtlLocale(locale) ? 'rtl' : 'ltr';
}

/** English display name and native name of a locale, falling back to the tag itself. */
export function describeLocale(locale) {
  if (locale === PSEUDO_LOCALE) {
    return { code: locale, name: 'Pseudo-locale (testing)', nativeName: 'Pseudo-locale' };
  }
  const read = (displayLocale) => {
    try {
      return new Intl.DisplayNames([displayLocale], { type: 'language' }).of(locale);
      // log-coverage: ignore -- describeLocale runs on every render of the language menu; the tag is the fallback.
    } catch {
      return '';
    }
  };
  return { code: locale, name: read('en') || locale, nativeName: read(locale) || locale };
}

function sameSource(source, english) {
  if (source === undefined || source === null) {
    return true;
  }
  if (typeof source === 'string' || typeof english === 'string') {
    return source === english;
  }
  const keys = Object.keys(english).sort();
  return (
    keys.length === Object.keys(source).sort().length &&
    keys.every((key) => source[key] === english[key])
  );
}

const pluralRules = new Map();
function pluralCategory(locale, count) {
  const tag = locale === PSEUDO_LOCALE ? DEFAULT_LOCALE : locale;
  if (!pluralRules.has(tag)) {
    let rules;
    try {
      rules = new Intl.PluralRules(tag);
      // log-coverage: ignore -- tp() runs on every render; an unsupported tag uses the default rules.
    } catch {
      rules = new Intl.PluralRules(DEFAULT_LOCALE);
    }
    pluralRules.set(tag, rules);
  }
  const number = Number(count);
  return Number.isFinite(number) ? pluralRules.get(tag).select(number) : 'other';
}

/** The CLDR plural categories a language needs, for example ['one', 'other'] for English. */
export function pluralCategoriesFor(locale) {
  try {
    return new Intl.PluralRules(locale)
      .resolvedOptions()
      .pluralCategories.sort((a, b) => PLURAL_CATEGORIES.indexOf(a) - PLURAL_CATEGORIES.indexOf(b));
    // log-coverage: ignore -- an unknown locale tag is expected; the English plural rules apply.
  } catch {
    return ['one', 'other'];
  }
}

function pickForm(forms, category) {
  if (!forms || typeof forms !== 'object') {
    return '';
  }
  return forms[category] ?? forms.other ?? '';
}

/**
 * A catalog loader (set with setLoaders) resolves `{ entries, machine? }` for (locale, namespace).
 * An entry is either the translated value (string, or plural forms object) or
 * `{ value, source?, kind?, model? }` where `source` is the English text it was translated from;
 * an entry whose source differs from the current English default is ignored.
 *
 * @param {{ locale?: string }} [options] Initial locale. An invalid tag falls back to 'en'.
 */
export function createI18nStore({ locale = DEFAULT_LOCALE } = {}) {
  let activeLocale = normalizeLocale(locale) || DEFAULT_LOCALE;
  let showOriginal = false;
  let version = 0;
  let loaders = [];
  // locale -> namespace -> { status, entries: Map, machine, promise? } (promise while loading)
  const catalogs = new Map();
  const listeners = new Set();
  const reverse = new Map();
  const pending = new Set();
  let flushScheduled = false;

  function emit() {
    version += 1;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function remember(shown, english) {
    if (shown === english) {
      return;
    }
    if (reverse.size >= REVERSE_LIMIT) {
      reverse.delete(reverse.keys().next().value);
    }
    reverse.set(shown, english);
  }

  function isTranslating() {
    return activeLocale !== DEFAULT_LOCALE && !showOriginal;
  }

  function catalogFor(localeTag, namespace) {
    return catalogs.get(localeTag)?.get(namespace);
  }

  async function load(localeTag, namespace) {
    const merged = new Map();
    let machine = null;
    let failures = 0;
    for (const loader of loaders) {
      try {
        const result = await loader(localeTag, namespace);
        if (!result) {
          continue;
        }
        machine ||= result.machine || null;
        for (const [key, raw] of Object.entries(result.entries || {})) {
          const entry =
            raw && typeof raw === 'object' && Object.hasOwn(raw, 'value')
              ? raw
              : { value: raw, kind: 'shipped' };
          const existing = merged.get(key);
          // A personal override always wins; a shipped translation wins over a machine one.
          if (!existing || entry.kind === 'override' || existing.kind === 'machine') {
            merged.set(key, entry);
          }
        }
      } catch (error) {
        failures += 1;
        log.debug('i18n.loader.failed', { locale: localeTag, errorClass: error?.name });
      }
    }
    const status = failures && failures === loaders.length ? 'failed' : 'ready';
    if (status === 'failed') {
      log.warn('i18n.catalog.failed', {
        locale: localeTag,
        loaderCount: loaders.length,
        failureCount: failures,
      });
    } else {
      log.debug('i18n.catalog.loaded', {
        locale: localeTag,
        entryCount: merged.size,
        hasMachine: Boolean(machine),
      });
    }
    if (!catalogs.has(localeTag)) {
      catalogs.set(localeTag, new Map());
    }
    catalogs.get(localeTag).set(namespace, { status, entries: merged, machine });
  }

  function flush() {
    flushScheduled = false;
    const pendingWork = [...pending];
    pending.clear();
    Promise.all(pendingWork.map((item) => item.promise))
      .then(() => {
        if (pendingWork.some((item) => item.locale === activeLocale)) {
          emit();
        }
      })
      .catch((error) => {
        log.warn('i18n.catalog.flush.failed', { errorClass: error?.name });
      });
  }

  /** Starts loading a namespace for a locale once; resolves when it is ready or failed. */
  function ensureNamespace(namespace, localeTag = activeLocale) {
    if (localeTag === DEFAULT_LOCALE || localeTag === PSEUDO_LOCALE || !loaders.length) {
      return Promise.resolve();
    }
    const existing = catalogFor(localeTag, namespace);
    if (existing) {
      return existing.promise || Promise.resolve();
    }
    if (!catalogs.has(localeTag)) {
      catalogs.set(localeTag, new Map());
    }
    const promise = load(localeTag, namespace);
    catalogs.get(localeTag).set(namespace, { status: 'loading', entries: new Map(), promise });
    pending.add({ locale: localeTag, promise });
    if (!flushScheduled) {
      flushScheduled = true;
      // Loading is requested during render; the re-render is scheduled after it, never inside.
      queueMicrotask(flush);
    }
    return promise;
  }

  function lookup(key, english) {
    const namespace = namespaceOf(key);
    const catalog = catalogFor(activeLocale, namespace);
    if (!catalog) {
      ensureNamespace(namespace);
      return null;
    }
    const entry = catalog.entries.get(key);
    if (!entry || !sameSource(entry.source, english)) {
      return null;
    }
    return entry.value;
  }

  /**
   * Translates `key`, falling back to the English default. `params` fill `{name}` placeholders.
   * @param {string} key `<namespace>.<component>.<name>`
   * @param {string} english The English text, exactly as the UI showed it before translation.
   * @param {Record<string, unknown>} [params]
   */
  function t(key, english, params) {
    const englishText = interpolate(english, params);
    if (!isTranslating()) {
      return englishText;
    }
    if (activeLocale === PSEUDO_LOCALE) {
      const shown = interpolate(pseudoLocalize(english), params);
      remember(shown, englishText);
      return shown;
    }
    const value = isValidKey(key) ? lookup(key, english) : null;
    if (typeof value !== 'string' || !value) {
      return englishText;
    }
    const shown = interpolate(value, params);
    remember(shown, englishText);
    return shown;
  }

  /**
   * Plural-aware translation. `forms` holds English CLDR forms, at least `one` and `other`;
   * `{count}` is filled with String(count) unless params.count is given.
   */
  function tp(key, count, forms, params) {
    const values = { count, ...params };
    const englishForm = pickForm(forms, pluralCategory(DEFAULT_LOCALE, count));
    const englishText = interpolate(englishForm, values);
    if (!isTranslating()) {
      return englishText;
    }
    if (activeLocale === PSEUDO_LOCALE) {
      const shown = interpolate(pseudoLocalize(englishForm), values);
      remember(shown, englishText);
      return shown;
    }
    const translated = isValidKey(key) ? lookup(key, forms) : null;
    const form =
      translated && typeof translated === 'object'
        ? pickForm(translated, pluralCategory(activeLocale, count))
        : '';
    if (!form) {
      return englishText;
    }
    const shown = interpolate(form, values);
    remember(shown, englishText);
    return shown;
  }

  /** Translated rich-text template (tags kept) for <T>; params are applied by the caller. */
  function template(key, english) {
    if (!isTranslating()) {
      return english;
    }
    if (activeLocale === PSEUDO_LOCALE) {
      return pseudoLocalize(english);
    }
    const value = isValidKey(key) ? lookup(key, english) : null;
    return typeof value === 'string' && value ? value : english;
  }

  // Formatting uses the browser's own locale while English is active, so replacing an existing
  // toLocaleString() call with these helpers does not change what an English user sees.
  function formatLocale() {
    return !isTranslating() || activeLocale === PSEUDO_LOCALE ? undefined : activeLocale;
  }

  function formatNumber(value, options) {
    return new Intl.NumberFormat(formatLocale(), options).format(value);
  }

  function formatDate(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return new Intl.DateTimeFormat(formatLocale(), options).format(date);
  }

  /** `value` units of `unit` from now; negative is in the past, e.g. (-5, 'minute'). */
  function formatRelativeTime(value, unit, options = { numeric: 'auto' }) {
    return new Intl.RelativeTimeFormat(formatLocale(), options).format(value, unit);
  }

  function formatList(items, options = { type: 'conjunction' }) {
    return new Intl.ListFormat(formatLocale(), options).format(items.map(String));
  }

  /**
   * A duration in seconds as hours, minutes and seconds ("1 hr, 5 min" in English, short style).
   * Uses Intl.DurationFormat when present and a unit list otherwise. Unknown values return ''.
   */
  function formatDuration(seconds, { style = 'short' } = {}) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0) {
      return '';
    }
    const rounded = Math.round(total);
    const parts = {
      hours: Math.floor(rounded / 3600),
      minutes: Math.floor((rounded % 3600) / 60),
      seconds: rounded % 60,
    };
    if (typeof Intl.DurationFormat === 'function') {
      const shown = Object.fromEntries(Object.entries(parts).filter(([, amount]) => amount));
      return new Intl.DurationFormat(formatLocale(), { style }).format(
        Object.keys(shown).length ? shown : { seconds: 0 },
      );
    }
    const units = Object.entries(parts)
      .filter(([, amount]) => amount)
      .map(([unit, amount]) =>
        new Intl.NumberFormat(formatLocale(), {
          style: 'unit',
          unit: unit.slice(0, -1),
          unitDisplay: style === 'long' ? 'long' : 'short',
        }).format(amount),
      );
    return units.length ? formatList(units, { type: 'unit', style }) : formatNumber(0);
  }

  function setLocale(next) {
    const canonical = next === PSEUDO_LOCALE ? PSEUDO_LOCALE : normalizeLocale(next);
    const value = canonical || DEFAULT_LOCALE;
    if (value === activeLocale) {
      return activeLocale;
    }
    activeLocale = value;
    log.info('i18n.locale.changed', { locale: activeLocale });
    reverse.clear();
    emit();
    return activeLocale;
  }

  return {
    t,
    tp,
    template,
    formatNumber,
    formatDate,
    formatRelativeTime,
    formatList,
    formatDuration,
    setLocale,
    ensureNamespace,
    getLocale: () => activeLocale,
    getDirection: () => directionFor(activeLocale),
    getVersion: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Loaders are tried in order; see createI18nStore for the result shape. */
    setLoaders(next) {
      loaders = [...next];
      catalogs.clear();
      reverse.clear();
      emit();
    },
    /** Drops cached catalogs (all, or one locale) so they load again on next use. */
    invalidate(localeTag) {
      if (localeTag) {
        catalogs.delete(localeTag);
      } else {
        catalogs.clear();
      }
      reverse.clear();
      emit();
    },
    /** Shows the English source while keeping the chosen locale ("Show original English"). */
    setShowOriginal(value) {
      if (showOriginal !== Boolean(value)) {
        showOriginal = Boolean(value);
        reverse.clear();
        emit();
      }
    },
    isShowingOriginal: () => showOriginal,
    /** The English text a translated string was shown for, or the text itself. */
    englishFor(text) {
      return reverse.get(text) ?? text;
    },
    /** Machine-translation details for loaded namespaces of the active locale. */
    machineInfo(namespaces) {
      for (const namespace of namespaces) {
        const machine = catalogFor(activeLocale, namespace)?.machine;
        if (machine) {
          return machine;
        }
      }
      return null;
    },
    namespaceStatus(namespace, localeTag = activeLocale) {
      return catalogFor(localeTag, namespace)?.status || 'not-loaded';
    },
  };
}

/** The studio-wide store used by useT(), <T> and helper modules. */
export const i18n = createI18nStore();

// Non-hook API for helper modules. Call these when the text is shown (inside a function), never
// at module scope: a module-scope call runs once, before the user's locale is known.
export const t = (key, english, params) => i18n.t(key, english, params);
export const tp = (key, count, forms, params) => i18n.tp(key, count, forms, params);
export const formatNumber = (value, options) => i18n.formatNumber(value, options);
export const formatDate = (value, options) => i18n.formatDate(value, options);
export const formatRelativeTime = (value, unit, options) =>
  i18n.formatRelativeTime(value, unit, options);
export const formatList = (items, options) => i18n.formatList(items, options);
export const formatDuration = (seconds, options) => i18n.formatDuration(seconds, options);
