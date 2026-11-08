// Public i18n API. Import from './i18n/index.js' (or '../i18n/index.js'), always with the
// explicit file name: the jsdom test loaders do not resolve directory imports.
//
//   const { t, tp } = useT();                       // in components
//   t('queue.list.empty', 'No renders yet.')
//   t('queue.item.eta', 'About {minutes} min left', { minutes })
//   tp('queue.list.count', jobs.length, { one: '{count} render', other: '{count} renders' })
//   <T id="settings.key.help" en="Add a key in <b>API keys</b>." components={{ b: <strong /> }} />
//   import { t } from './i18n/index.js';           // in helper modules, inside functions only
//
// See docs/I18N.md and docs/I18N_CONVERSION_GUIDE.md.
export {
  DEFAULT_LOCALE,
  PSEUDO_LOCALE,
  createI18nStore,
  describeLocale,
  directionFor,
  formatDate,
  formatDuration,
  formatList,
  formatNumber,
  formatRelativeTime,
  i18n,
  isRtlLocale,
  normalizeLocale,
  pluralCategoriesFor,
  t,
  tp,
} from './i18n-core.js';
export { I18nProvider, LOCALE_STORAGE_KEY, T, useLocale, useT } from './i18n-react.js';
export { namespaceOf, namespacesForSection } from './namespaces.js';
