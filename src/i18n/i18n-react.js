// React bindings for the i18n store: useT(), <T> rich text, I18nProvider and useLocale().
// This file has no JSX so jsdom tests can import it directly from the source tree.
import {
  Fragment,
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { createLog } from '../app-log.js';
import { DEFAULT_LOCALE, PSEUDO_LOCALE, directionFor, i18n, normalizeLocale } from './i18n-core.js';
import { PLACEHOLDER, parseRichText } from './message-format.js';

export const LOCALE_STORAGE_KEY = 'forge-locale';
const I18nContext = createContext(null);
const log = createLog('i18n');

function readStoredLocale(storage) {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY);
    return value === PSEUDO_LOCALE ? value : normalizeLocale(value);
  } catch (error) {
    // Storage can be blocked (private mode, policy); the default locale is used.
    log.debug('i18n.storage.unavailable', { errorClass: error?.name });
    return null;
  }
}

function writeStoredLocale(storage, locale) {
  try {
    if (locale === DEFAULT_LOCALE) {
      storage?.removeItem(LOCALE_STORAGE_KEY);
    } else {
      storage?.setItem(LOCALE_STORAGE_KEY, locale);
    }
  } catch (error) {
    // Storage can be blocked; the server-side preference still records the choice.
    log.debug('i18n.storage.unavailable', { errorClass: error?.name });
  }
}

/**
 * Re-renders the calling component when the locale or a catalog changes. The returned functions
 * are stable, so they are safe in effect dependency lists.
 */
export function useT() {
  useSyncExternalStore(i18n.subscribe, i18n.getVersion, i18n.getVersion);
  const locale = i18n.getLocale();
  return {
    t: i18n.t,
    tp: i18n.tp,
    formatNumber: i18n.formatNumber,
    formatDate: i18n.formatDate,
    formatRelativeTime: i18n.formatRelativeTime,
    formatList: i18n.formatList,
    formatDuration: i18n.formatDuration,
    locale,
    dir: directionFor(locale),
  };
}

function interpolateNodes(text, params, keyPrefix) {
  if (!params) {
    return [text];
  }
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!Object.hasOwn(params, name) || params[name] === undefined || params[name] === null) {
      continue;
    }
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    const value = params[name];
    nodes.push(
      isValidElement(value)
        ? cloneElement(value, { key: `${keyPrefix}-${match.index}` })
        : String(value),
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function renderNodes(nodes, params, components, prefix = 'n') {
  return nodes.flatMap((node, index) => {
    const key = `${prefix}${index}`;
    if (typeof node === 'string') {
      return interpolateNodes(node, params, key);
    }
    const children = renderNodes(node.children, params, components, `${key}-`);
    const component = components?.[node.tag];
    if (isValidElement(component)) {
      return [
        children.length
          ? cloneElement(component, { key }, ...children)
          : cloneElement(component, { key }),
      ];
    }
    if (typeof component === 'function') {
      return [createElement(component, { key }, ...children)];
    }
    // An unknown tag keeps its text; markup is never created from a translation.
    return [createElement(Fragment, { key }, ...children)];
  });
}

/**
 * Rich text without concatenated fragments:
 * <T id="queue.notice.openSettings" en="Add a key in <link>Settings</link>." components={{
 *   link: <a href="/?dialog=settings" /> }} params={{ name }} />
 * Tags map to elements in `components`; `{name}` placeholders may be strings or elements.
 */
export function T({ id, en, params, components }) {
  useT();
  const template = i18n.template(id, en);
  const nodes = parseRichText(template) || parseRichText(en) || [String(en)];
  return createElement(Fragment, null, ...renderNodes(nodes, params, components));
}

/** Loads shipped catalogs from an import.meta.glob map of './locales/<lang>/<ns>.json'. */
export function shippedCatalogLoader(globMap = {}) {
  const files = new Map();
  for (const [file, importer] of Object.entries(globMap)) {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/.exec(file);
    if (match && match[1] !== DEFAULT_LOCALE) {
      files.set(`${match[1]}/${match[2]}`, importer);
    }
  }
  return async (locale, namespace) => {
    const importer = files.get(`${locale}/${namespace}`);
    if (!importer) {
      return null;
    }
    const module = await importer();
    return { entries: module?.default ?? module };
  };
}

/**
 * Loads cached machine translations and personal overrides from the local i18n service.
 * Rejects when the service answers with a non-OK status.
 */
export function serverCatalogLoader(fetchImpl) {
  return async (locale, namespace) => {
    const query = new URLSearchParams({ lang: locale, ns: namespace });
    // log-coverage: ignore -- /api responses are logged by the fetch wrapper in src/app-log.js.
    const response = await fetchImpl(`/api/i18n/catalog?${query}`);
    if (!response.ok) {
      throw Error(`Catalog ${namespace} is unavailable (${response.status}).`);
    }
    const catalogPayload = await response.json();
    return {
      entries: catalogPayload.entries || {},
      machine: catalogPayload.machine || null,
    };
  };
}

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
    // log-coverage: ignore -- runs once per mount inside useMemo during render; a blocked read returns null.
  } catch {
    return null;
  }
}

// One stable function, so effects that depend on it do not rerun on every render. It reads the
// global fetch at call time, which keeps test stubs working.
// log-coverage: ignore -- a pass-through; the fetch wrapper in src/app-log.js logs /api failures.
const globalFetch = (...args) => globalThis.fetch(...args);

function defaultFetch() {
  return typeof globalThis.fetch === 'function' ? globalFetch : null;
}

/**
 * Applies the saved locale, loads catalogs on demand and keeps <html lang dir> in sync.
 * @param {{ catalogs?: Record<string, () => Promise<unknown>>, fetchImpl?: typeof fetch,
 *   storage?: Storage | null, children?: unknown }} props `catalogs` is the import.meta.glob
 *   map of shipped locale files; `fetchImpl` reaches the local /api/i18n service.
 */
export function I18nProvider({ children, catalogs, fetchImpl, storage }) {
  // Both are resolved once per prop value: a new function each render would reload catalogs.
  const request = useMemo(
    () => (fetchImpl === undefined ? defaultFetch() : fetchImpl),
    [fetchImpl],
  );
  const store = useMemo(() => (storage === undefined ? defaultStorage() : storage), [storage]);
  useSyncExternalStore(i18n.subscribe, i18n.getVersion, i18n.getVersion);

  useLayoutEffect(() => {
    const loaders = [shippedCatalogLoader(catalogs)];
    if (request) {
      loaders.push(serverCatalogLoader(request));
    }
    i18n.setLoaders(loaders);
    const saved = readStoredLocale(store);
    if (saved) {
      i18n.setLocale(saved);
      return undefined;
    }
    if (!request) {
      return undefined;
    }
    // Only a local preference read; nothing is sent to a translation provider.
    let active = true;
    request('/api/i18n/preference')
      .then((response) => (response.ok ? response.json() : null))
      .then((preference) => {
        const savedLocale = preference?.locale;
        const locale = savedLocale === PSEUDO_LOCALE ? savedLocale : normalizeLocale(savedLocale);
        if (active && locale) {
          i18n.setLocale(locale);
        }
      })
      .catch((error) => {
        // The service may be unavailable (static preview, tests); English stays active.
        log.debug('i18n.preference.read.failed', { errorClass: error?.name });
      });
    return () => {
      active = false;
    };
  }, [catalogs, request, store]);

  const locale = i18n.getLocale();
  useLayoutEffect(() => {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (root) {
      root.lang = locale;
      root.dir = directionFor(locale);
    }
  }, [locale]);

  const setLocale = useCallback(
    async (next) => {
      const applied = i18n.setLocale(next);
      writeStoredLocale(store, applied);
      if (!request) {
        return applied;
      }
      const response = await request('/api/i18n/preference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'i18n' },
        body: JSON.stringify({ locale: applied }),
      });
      if (!response.ok) {
        log.warn('i18n.preference.save.failed', { locale: applied, status: response.status });
        throw Error('The language was changed here but could not be saved for the studio.');
      }
      return applied;
    },
    [request, store],
  );

  const showOriginal = i18n.isShowingOriginal();
  const value = useMemo(
    () => ({
      locale,
      dir: directionFor(locale),
      setLocale,
      showOriginal,
      setShowOriginal: i18n.setShowOriginal,
      reloadCatalogs: i18n.invalidate,
      fetchImpl: request,
    }),
    [locale, setLocale, showOriginal, request],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

/** Locale controls for the language menu. Works without a provider (English, no saving). */
export function useLocale() {
  useSyncExternalStore(i18n.subscribe, i18n.getVersion, i18n.getVersion);
  const context = useContext(I18nContext);
  if (context) {
    return context;
  }
  const locale = i18n.getLocale();
  return {
    locale,
    dir: directionFor(locale),
    setLocale: async (next) => i18n.setLocale(next),
    showOriginal: i18n.isShowingOriginal(),
    setShowOriginal: i18n.setShowOriginal,
    reloadCatalogs: i18n.invalidate,
    fetchImpl: defaultFetch(),
  };
}
