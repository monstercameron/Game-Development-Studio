import { createLog } from './app-log.js';

// Validation for values read back from browser storage. A stored value can be damaged JSON, or
// valid JSON of the wrong shape (an array where an object is expected, a string, null) after a
// crash, a manual edit or an older version. Readers use these helpers so such a value is replaced
// by the default instead of throwing or rendering garbage. Storage keys are unchanged.

const log = createLog('ui');

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parsed JSON for `key`, or undefined when storage is unavailable, empty or damaged. */
export function readStoredJson(key, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch (error) {
    // Unavailable or damaged storage reads as "no saved value"; callers use their default.
    log.debug('ui.storage.read_failed', { settingKey: key, errorClass: error?.name });
    return undefined;
  }
}

function sanitizeOptions(saved, initial) {
  if (!Array.isArray(saved) || saved.length !== initial.length) {
    return initial;
  }
  return saved.map((value, index) =>
    ['string', 'number', 'boolean'].includes(typeof value) ? value : initial[index],
  );
}

/**
 * Merges saved drafts over the initial ones, keeping only fields of the expected type.
 * `refs` are never restored (a reference selection points at assets that may have moved).
 */
export function sanitizeDrafts(saved, initial) {
  const source = isPlainObject(saved) ? saved : {};
  return Object.fromEntries(
    Object.entries(initial).map(([key, base]) => {
      const entry = isPlainObject(source[key]) ? source[key] : {};
      // Other simple fields (a chosen model, a rig) are kept; nested values are not trusted.
      const simple = Object.fromEntries(
        Object.entries(entry).filter(([, value]) =>
          ['string', 'number', 'boolean'].includes(typeof value),
        ),
      );
      return [
        key,
        {
          ...base,
          ...simple,
          prompt: typeof entry.prompt === 'string' ? entry.prompt : base.prompt,
          second: typeof entry.second === 'string' ? entry.second : base.second,
          options: sanitizeOptions(entry.options, base.options),
          seed:
            typeof entry.seed === 'string' || Number.isFinite(entry.seed) ? entry.seed : base.seed,
          refs: [],
        },
      ];
    }),
  );
}

/** The saved draft queue: only objects that have a text id. */
export function sanitizeJobList(saved) {
  return Array.isArray(saved)
    ? saved.filter((job) => isPlainObject(job) && typeof job.id === 'string').slice(-500)
    : [];
}

/** The selected project id: a short string, otherwise none. */
export function sanitizeSelectedProject(saved) {
  return typeof saved === 'string' && saved.length > 0 && saved.length <= 100 ? saved : null;
}

/** Notification switches: only the known keys, only booleans. */
export function sanitizeSwitches(saved, defaults) {
  const source = isPlainObject(saved) ? saved : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [
      key,
      typeof source[key] === 'boolean' ? source[key] : value,
    ]),
  );
}

/** A map of asset id to rating: only plain objects with numeric ratings survive. */
export function sanitizeRatings(saved) {
  if (!isPlainObject(saved)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(saved).filter(
      ([, value]) => typeof value === 'number' && Number.isFinite(value),
    ),
  );
}
