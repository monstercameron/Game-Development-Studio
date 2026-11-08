const ERROR = /error|exception|traceback|failed|failure|fatal/i;
const WARN = /\bWARN(?:ING)?\b/;
const CONTINUATION =
  /^(?:\s+\S|at\s+|Traceback \(|Caused by:|During handling of|The above exception|[A-Za-z_][\w.]*(?:Error|Exception|Warning):)/;

// Bounds one error group so a runaway continuation match cannot pull an unbounded
// block into the filtered view.
const MAX_ERROR_GROUP_LINES = 30;

export function isErrorLine(line) {
  return ERROR.test(line);
}

export function isWarnLine(line) {
  return WARN.test(line) && !ERROR.test(line);
}

/**
 * Filters log lines for the diagnostics view.
 *
 * Without `errorsOnly`, returns the lines containing `query` (case-insensitive; an empty query
 * keeps every line). With `errorsOnly`, keeps each error line together with its traceback and
 * stack-frame continuation lines, so context stays with the error it explains. A group is kept
 * when any of its lines matches `query`. Always returns a new array.
 *
 * @param {string[]} lines Log lines in display order.
 * @param {{ errorsOnly?: boolean, query?: string }} [options]
 * @returns {string[]}
 */
export function filterLogLines(lines, { errorsOnly = false, query = '' } = {}) {
  const needle = query.toLowerCase();
  if (!errorsOnly) {
    return lines.filter((line) => !needle || line.toLowerCase().includes(needle));
  }
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isErrorLine(lines[i])) {
      continue;
    }
    const group = [lines[i]];
    while (
      i + 1 < lines.length &&
      group.length < MAX_ERROR_GROUP_LINES &&
      CONTINUATION.test(lines[i + 1])
    ) {
      group.push(lines[++i]);
    }
    if (!needle || group.some((line) => line.toLowerCase().includes(needle))) {
      groups.push(...group);
    }
  }
  return groups;
}
