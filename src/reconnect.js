// Delay before the next poll of the studio. While the studio answers, the normal period applies.
// After consecutive failures the retry starts quickly (a restart usually takes a few seconds) and
// backs off to a ceiling so a studio that stays down is not hammered.
export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 15000;

/**
 * @param {number} failures consecutive failed polls so far (0 when the last poll succeeded)
 * @param {number} [normalMs] delay while healthy
 * @returns {number} milliseconds to wait
 */
export function pollDelayMs(failures, normalMs = 5000) {
  if (!Number.isFinite(failures) || failures <= 0) {
    return normalMs;
  }
  return Math.min(RECONNECT_FIRST_MS * 2 ** (Math.min(failures, 10) - 1), RECONNECT_MAX_MS);
}
