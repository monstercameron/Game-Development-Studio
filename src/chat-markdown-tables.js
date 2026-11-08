// GitHub-style pipe tables. react-markdown is used without the GFM plugin (no extra dependency),
// so tables are split out of the text here and rendered by ChatMarkdown as real tables.
export const MAX_TABLE_ROWS = 200;
export const MAX_TABLE_COLUMNS = 20;

const SEPARATOR_CELL = /^:?-{1,}:?$/;
const FENCE = /^\s{0,3}(```|~~~)/;

function splitCells(line) {
  let text = line.trim();
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|') && !text.endsWith('\\|')) {
    text = text.slice(0, -1);
  }
  const cells = [];
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\' && text[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (text[index] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += text[index];
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignmentOf(cell) {
  if (cell.startsWith(':') && cell.endsWith(':')) {
    return 'center';
  }
  if (cell.endsWith(':')) {
    return 'right';
  }
  return cell.startsWith(':') ? 'left' : null;
}

function separatorAlignments(line) {
  if (!line.includes('-') || !line.includes('|')) {
    return null;
  }
  const cells = splitCells(line);
  return cells.every((cell) => SEPARATOR_CELL.test(cell)) ? cells.map(alignmentOf) : null;
}

/**
 * Splits Markdown text into plain Markdown segments and table segments. Fenced code is never
 * searched for tables. A table needs a header row and a matching separator row.
 * @param {string} content
 * @returns {Array<object>} Segments: `{ type: 'markdown', text }` or
 *   `{ type: 'table', header, align, rows }`.
 */
export function splitMarkdownTables(content) {
  const lines = String(content).split(/\r?\n/);
  const segments = [];
  let buffer = [];
  let fence = null;
  const flush = () => {
    if (buffer.length) {
      segments.push({ type: 'markdown', text: buffer.join('\n') });
      buffer = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1];
      } else if (fence === fenceMatch[1]) {
        fence = null;
      }
      buffer.push(line);
      continue;
    }
    const canStart = fence === null && line.includes('|');
    const align = canStart ? separatorAlignments(lines[index + 1] ?? '') : null;
    const header = align ? splitCells(line) : null;
    if (!align || header.length !== align.length || header.length > MAX_TABLE_COLUMNS) {
      buffer.push(line);
      continue;
    }
    const rows = [];
    let next = index + 2;
    while (next < lines.length && lines[next].trim() && lines[next].includes('|')) {
      const cells = splitCells(lines[next]);
      rows.push(header.map((_, column) => cells[column] ?? ''));
      next += 1;
    }
    if (rows.length > MAX_TABLE_ROWS) {
      buffer.push(line);
      continue;
    }
    flush();
    segments.push({ type: 'table', header, align, rows });
    index = next - 1;
  }
  flush();
  return segments;
}
