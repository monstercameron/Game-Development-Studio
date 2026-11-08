// H3 supplies a rolling sd-cli log. Only display a recognized sampling line;
// loading bars and arbitrary worker log text are not reliable progress data.

/**
 * Builds a progress line from the last sampling line in a worker log.
 *
 * @param {unknown} details Rolling log text from the worker; non-strings yield null.
 * @param {number} steps Expected total step count for the job; lines for other totals are ignored.
 * @returns {string | null} A display line, or null when no recognized line matches.
 */
export function videoProgress(details, steps) {
  if (typeof details !== 'string' || !Number.isInteger(steps) || steps < 1) {
    return null;
  }
  // Worker logs may include ANSI escape sequences; strip them before parsing.
  // eslint-disable-next-line no-control-regex -- ANSI sequences begin with ESC.
  const clean = details.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const pattern = /\b(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+\s*s\/it\s*-\s*ETA\s+((?:\d+:){1,2}\d{2})/gi;
  let match;
  let last = null;
  while ((match = pattern.exec(clean))) {
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (total === steps && current >= 0 && current <= total) {
      last = { current, total, eta: match[3] };
    }
  }
  return last ? `Rendering video · step ${last.current}/${last.total} · ETA ${last.eta}` : null;
}
