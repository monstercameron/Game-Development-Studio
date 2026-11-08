// Translation namespaces. A key is `<namespace>.<component>.<name>`; the namespace decides which
// catalog file holds the string (src/i18n/locales/<lang>/<namespace>.json), so a page can be
// loaded or machine-translated on its own. Keep this list in sync with docs/I18N.md.

/** Page namespaces match the route section ids in src/useNav.js. */
export const PAGE_NAMESPACES = Object.freeze([
  'overview',
  'chat',
  'images',
  '3d',
  'vegetation',
  'world',
  'motion',
  'video',
  'music',
  'sfx',
  'voices',
  'segmentation',
  'game',
  'queue',
  'assets',
  'megascans',
  'models',
  'diagnostics',
]);

/** Shared namespaces for UI that is not owned by one page. */
export const SHARED_NAMESPACES = Object.freeze([
  'common',
  'shell',
  'settings',
  'errors',
  'projects',
  'viewer',
  'i18n',
]);

export const NAMESPACES = Object.freeze([...SHARED_NAMESPACES, ...PAGE_NAMESPACES]);

const NAMESPACE_SET = new Set(NAMESPACES);

// Strings on every page: the frame, shared widgets, the top-bar dialogs and the language menu.
const ALWAYS_VISIBLE = Object.freeze(['shell', 'common', 'settings', 'errors', 'i18n']);

// `ns.component.name`, optionally one or two more segments. Segments are code identifiers.
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}(\.[A-Za-z][A-Za-z0-9_]{0,63}){2,4}$/;

export function isKnownNamespace(namespace) {
  return NAMESPACE_SET.has(namespace);
}

export function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key) && isKnownNamespace(namespaceOf(key));
}

export function namespaceOf(key) {
  const dot = typeof key === 'string' ? key.indexOf('.') : -1;
  return dot > 0 ? key.slice(0, dot) : '';
}

/** Namespaces whose strings can appear on a route section, page namespace first. */
export function namespacesForSection(section) {
  const page = PAGE_NAMESPACES.includes(section) ? [section] : [];
  // The asset library page also shows project folders.
  const extra = section === 'assets' ? ['projects', 'viewer'] : [];
  return [...new Set([...page, ...extra, ...ALWAYS_VISIBLE])];
}
