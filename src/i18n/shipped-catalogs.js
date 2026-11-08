// Shipped (human-reviewed) locale catalogs, loaded lazily per namespace by Vite. English is not
// loaded in the browser: the English text is the default argument in the code. Only main.jsx
// imports this module, because import.meta.glob exists only in Vite builds.
export const shippedCatalogs = import.meta.glob(['./locales/*/*.json', '!./locales/en/*.json']);
