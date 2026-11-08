// Redaction and normalization for captured errors. This module is pure (no Node built-ins) so
// the errors service and the studio's copy buttons apply the same rules. Redaction runs when an
// error is stored and again whenever it is displayed, copied, sent to OpenAI or posted to GitHub.

/** Maximum stored characters per field. Longer values keep their head and tail. */
export const ERROR_FIELD_LIMITS = Object.freeze({
  message: 2000,
  stack: 32000,
  componentStack: 8000,
  page: 300,
  context: 4000,
  note: 4000,
  suggestion: 32000,
});

const PLACEHOLDERS = Object.freeze({
  repo: '<repo>',
  projects: '<projects>',
  runtime: '<runtime>',
  home: '<home>',
});

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches a root written with either separator, doubled backslashes (JSON or JS escapes),
// URL-encoded spaces, and an optional file:// prefix. Windows paths are case-insensitive.
function rootPattern(root) {
  const parts = String(root)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part).replace(/ /g, '(?: |%20)'));
  if (!parts.length) {
    return null;
  }
  const leading = /^[\\/]/.test(root) ? '[\\\\/]+' : '';
  return new RegExp(`(?:file:/{2,3})?${leading}${parts.join('[\\\\/]+')}(?![A-Za-z0-9_.-])`, 'gi');
}

const SECRET_PATTERNS = [
  [/\bsk-(?:proj-|svcacct-|admin-|ant-)?[A-Za-z0-9_-]{16,}/g, '[redacted-key]'],
  [/\bhf_[A-Za-z0-9]{16,}/g, '[redacted-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted-key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [
    /([?&](?:token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|auth|sig|signature|password|pass|secret|client_secret|code|session|sessionid|x-amz-signature|x-amz-credential)=)[^&\s#"'<>]+/gi,
    '$1[redacted]',
  ],
  [
    /((?<![A-Za-z0-9_])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|hf[_-]?token|token|password|passwd|secret|client[_-]?secret|x-lab-session|cookie|set-cookie|authorization)["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"',;}&]+/gi,
    '$1[redacted]',
  ],
  // Bounded and anchored to the start of a run so long unbroken text stays linear-time.
  [
    /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
    '<email>',
  ],
];

// Windows absolute paths outside the known roots. Each folder may contain spaces; the final
// segment may not, so "C:\Program Files\x\y.py is missing" stops after "y.py".
const WINDOWS_PATH =
  /(?:file:\/{2,3})?\b[A-Za-z]:(?:\\\\|\\|\/)(?:[^\\/\r\n"'<>|:*?()[\]]+(?:\\\\|\\|\/))*[^\\/\r\n"'<>|:*?()[\]\s]*/g;

// Keeps only the path inside site-packages, or the last two segments, so local install folders
// do not appear in copied errors.
function shortenAbsolutePath(match) {
  const separator = match.includes('/') && !match.includes('\\') ? '/' : '\\';
  const parts = match.split(/[\\/]+/).filter(Boolean);
  const sitePackages = parts.findIndex((part) => /^(site|dist)-packages$/i.test(part));
  if (sitePackages >= 0) {
    return ['<site-packages>', ...parts.slice(sitePackages + 1)].join(separator);
  }
  if (parts.length <= 1) {
    return '<path>';
  }
  return ['<path>', ...parts.slice(-2)].join(separator);
}

/**
 * Redacts secrets, emails, user names and absolute local paths.
 *
 * @param {unknown} value Text to redact; non-strings become ''.
 * @param {{repo?: string, projects?: string, runtime?: string, home?: string, user?: string}} roots
 *   Known local roots, replaced by placeholders such as <repo> so file:line stays useful.
 * @param {{keepPaths?: boolean}} options keepPaths leaves paths but still removes secrets.
 */
export function redactText(value, roots = {}, { keepPaths = false } = {}) {
  if (typeof value !== 'string' || !value) {
    return '';
  }
  let text = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (keepPaths) {
    return text;
  }
  const known = Object.entries(PLACEHOLDERS)
    .filter(([key]) => typeof roots[key] === 'string' && roots[key].length > 3)
    .sort((a, b) => roots[b[0]].length - roots[a[0]].length);
  for (const [key, placeholder] of known) {
    const pattern = rootPattern(roots[key]);
    if (pattern) {
      text = text.replace(pattern, placeholder);
    }
  }
  text = text
    .replace(
      /(?:file:\/{2,3})?\b[A-Za-z]:(?:\\\\|\\|\/)(?:Users|Documents and Settings)(?:\\\\|\\|\/)[^\\/\r\n"'<>|:*?\s]+/gi,
      '<home>',
    )
    .replace(/(?<![A-Za-z0-9_.-])\/(?:home|Users)\/[^/\s"'<>]+/g, '<home>')
    .replace(WINDOWS_PATH, shortenAbsolutePath)
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/gi, '<studio>');
  const user = typeof roots.user === 'string' ? roots.user.trim() : '';
  if (user.length >= 3) {
    text = text.replace(
      new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(user)}(?![A-Za-z0-9_])`, 'gi'),
      '<user>',
    );
  }
  return text;
}

/** Reverses only the known-root placeholders, for the opt-in "Include local paths" view. */
export function expandPlaceholders(value, roots = {}) {
  if (typeof value !== 'string') {
    return '';
  }
  let text = value;
  for (const [key, placeholder] of Object.entries(PLACEHOLDERS)) {
    if (typeof roots[key] === 'string' && roots[key]) {
      text = text.split(placeholder).join(roots[key]);
    }
  }
  return text;
}

/**
 * Keeps the head and tail of a long value. Python's innermost frame is at the end.
 *
 * @param {unknown} value Text to shorten; non-strings become ''.
 * @param {number} limit Maximum length in characters. The marker counts toward it when there is
 *   room; a smaller limit returns only the marker.
 */
export function truncateMiddle(value, limit) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) {
    return text;
  }
  const marker = `\n… [${text.length - limit} characters truncated] …\n`;
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room * 0.3);
  return text.slice(0, head) + marker + text.slice(text.length - (room - head));
}

/** Removes ids, numbers and hashes so repeats of the same failure share a fingerprint. */
export function normalizeForFingerprint(value) {
  return String(value || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/-[A-Za-z0-9_]{6,12}\.(m?js|css)\b/g, '.$1')
    .replace(/\?[^\s:)'"]*/g, '')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

const PYTHON_FRAME_PATTERN = /^\s*File "([^"]+)", line \d+, in (\S+)/;
const JS_FRAME_PATTERN = /^\s*at (?:(.+?) \()?(.+?):\d+(?::\d+)?\)?\s*$/;

/** Returns up to `count` normalized innermost stack frames (file and function, no line numbers). */
export function topFrames(stack, count = 5) {
  const python = [];
  const javascript = [];
  for (const line of String(stack || '').split(/\r?\n/)) {
    const pythonMatch = PYTHON_FRAME_PATTERN.exec(line);
    if (pythonMatch) {
      python.push(`${pythonMatch[1]}:${pythonMatch[2]}`);
      continue;
    }
    const javascriptMatch = JS_FRAME_PATTERN.exec(line);
    if (javascriptMatch) {
      javascript.push(`${javascriptMatch[2]}:${javascriptMatch[1] || ''}`);
    }
  }
  // Python prints the innermost frame last; V8 prints it first.
  const frames = python.length ? python.slice(-count) : javascript.slice(0, count);
  return frames.map(normalizeForFingerprint);
}

/** The text hashed into an error fingerprint. */
export function fingerprintSource({ source, kind = '', message, stack }) {
  return [source, kind, normalizeForFingerprint(message), ...topFrames(stack)].join('\n');
}
