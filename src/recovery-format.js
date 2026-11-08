// Small formatting helpers for the Recovery panel. They return plain numbers and unit codes so
// the component can put the words through t().

/**
 * Splits a byte count into a binary (1024-based) value and unit. Non-finite or negative input
 * counts as 0. Values under 10 keep one decimal place; the value is a display rounding, not an
 * exact size.
 *
 * @param {number} bytes
 * @returns {{ value: string, unit: 'B'|'KiB'|'MiB'|'GiB' }}
 */
export function sizeParts(bytes) {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (size < 1024) {
    return { value: String(Math.round(size)), unit: 'B' };
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return { value: value.toFixed(value >= 10 ? 0 : 1), unit: units[index] };
}

/**
 * Shows an age in whole hours below 48 hours, then in whole days. Non-finite or negative input
 * counts as 0 hours.
 *
 * @param {number} hours
 * @returns {{ value: number, unit: 'h'|'d' }}
 */
export function ageParts(hours) {
  const age = Number.isFinite(hours) && hours > 0 ? hours : 0;
  return age < 48
    ? { value: Math.max(1, Math.round(age)), unit: 'h' }
    : { value: Math.round(age / 24), unit: 'd' };
}

export const UNSAFE_KINDS = new Set(['unknown_outcome']);
