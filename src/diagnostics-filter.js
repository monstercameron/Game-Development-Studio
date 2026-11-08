const ERROR = /error|exception|traceback|failed|failure|fatal/i;
const WARN = /\bWARN(?:ING)?\b/;
const CONTINUATION =
  /^(?:\s+\S|at\s+|Traceback \(|Caused by:|During handling of|The above exception|[A-Za-z_][\w.]*(?:Error|Exception|Warning):)/;

export function isErrorLine(line) {
  return ERROR.test(line);
}

export function isWarnLine(line) {
  return WARN.test(line) && !ERROR.test(line);
}

// Keep traceback and stack-frame context together when filtering errors.
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
    while (i + 1 < lines.length && group.length < 30 && CONTINUATION.test(lines[i + 1])) {
      group.push(lines[++i]);
    }
    if (!needle || group.some((line) => line.toLowerCase().includes(needle))) {
      groups.push(...group);
    }
  }
  return groups;
}
