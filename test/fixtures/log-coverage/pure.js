// Pure helper: no signals, so no logging is needed.
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
