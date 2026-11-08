// Extracts error-level lines, Node stack traces and multi-line Python tracebacks from log text.
// The parser is pure; runtime/error-scanner.js decides which files are read and from where.

const TIMESTAMP =
  /^\s*\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/;
const ERROR_LEVEL = /(?:^|[\s[|])(ERROR|FATAL|CRITICAL)(?=[\]:|\s]|$)/;
const TRACEBACK = /^Traceback \(most recent call last\):\s*$/;
const CHAIN =
  /^(?:During handling of the above exception|The above exception was the direct cause)/;
const JS_ERROR_HEAD =
  /^(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*(?:Error|Exception)|Error)(?: \[[A-Z0-9_]+\])?: \S/;
const JS_FRAME = /^\s+at\s\S/;
const MAX_BLOCK_LINES = 400;

function splitTimestamp(line) {
  const match = TIMESTAMP.exec(line);
  if (!match) {
    return { timestamp: null, text: line };
  }
  const parsed = new Date(match[1].replace(' ', 'T').replace(',', '.'));
  return {
    timestamp: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
    text: line.slice(match[0].length),
  };
}

function isIndented(line) {
  return /^\s/.test(line) && line.trim() !== '';
}

// Reads a Python traceback starting at `start`. Chained exceptions stay in one block.
function readTraceback(lines, start) {
  const block = [lines[start].text];
  let message = '';
  let index = start + 1;
  let complete = false;
  while (index < lines.length && block.length < MAX_BLOCK_LINES) {
    const text = lines[index].text;
    if (isIndented(text) || TRACEBACK.test(text) || CHAIN.test(text)) {
      block.push(text);
      index++;
      continue;
    }
    if (text.trim() === '') {
      // A blank line separates chained tracebacks; anything else ends the block.
      const next = lines[index + 1]?.text || '';
      if (CHAIN.test(next) || TRACEBACK.test(next)) {
        block.push('');
        index++;
        continue;
      }
      if (message) {
        complete = true;
        break;
      }
      index++;
      continue;
    }
    // The first non-indented line is the exception line, for example "ValueError: x".
    block.push(text);
    message = text.trim();
    index++;
    const next = lines[index]?.text || '';
    const afterBlank = lines[index + 1]?.text || '';
    if (CHAIN.test(next) || (next.trim() === '' && CHAIN.test(afterBlank))) {
      continue;
    }
    complete = true;
    break;
  }
  if (block.length >= MAX_BLOCK_LINES) {
    complete = true;
  }
  return { block, message, next: index, complete };
}

/**
 * Finds errors in log text.
 *
 * @param {string} text Complete lines of log output.
 * @param {{final?: boolean}} options final treats an unfinished traceback at the end as
 *   complete, for a log that has stopped growing.
 * @returns {{entries: Array<{message: string, stack: string, timestamp: string|null}>,
 *   safeLength: number}} safeLength is how many characters were fully parsed; an unfinished
 *   traceback at the end is left for the next read.
 */
export function extractLogErrors(text, { final = false } = {}) {
  const raw = String(text || '');
  const lines = [];
  let offset = 0;
  for (const line of raw.split('\n')) {
    lines.push({ ...splitTimestamp(line.replace(/\r$/, '')), offset });
    offset += line.length + 1;
  }
  const entries = [];
  let safeLength = raw.length;
  let lastErrorLine = -2;
  for (let index = 0; index < lines.length; index++) {
    const { text, timestamp } = lines[index];
    if (TRACEBACK.test(text.trim())) {
      const traceback = readTraceback(lines, index);
      if (!traceback.complete && !final) {
        safeLength = lines[index].offset;
        break;
      }
      const previous = entries.at(-1);
      // "ERROR: Exception in ASGI application" followed by its traceback is one error.
      if (previous && lastErrorLine === index - 1 && !previous.stack) {
        previous.context = { logLine: previous.message };
        previous.message = traceback.message || previous.message;
        previous.stack = traceback.block.join('\n');
      } else {
        entries.push({
          message: traceback.message || 'Python traceback',
          stack: traceback.block.join('\n'),
          timestamp,
        });
      }
      index = traceback.next - 1;
      continue;
    }
    const isJsHead = JS_ERROR_HEAD.test(text) && JS_FRAME.test(lines[index + 1]?.text || '');
    const level = ERROR_LEVEL.exec(text);
    if (!isJsHead && !level) {
      continue;
    }
    const frames = [];
    let next = index + 1;
    while (next < lines.length && JS_FRAME.test(lines[next].text) && frames.length < 200) {
      frames.push(lines[next].text);
      next++;
    }
    const message = (
      level ? text.slice(level.index + level[0].length).replace(/^[\]:|\s]+/, '') : text
    ).trim();
    entries.push({
      message: message || text.trim(),
      stack: frames.length ? [text.trim(), ...frames].join('\n') : '',
      timestamp,
    });
    lastErrorLine = next - 1;
    index = next - 1;
  }
  return { entries, safeLength };
}
