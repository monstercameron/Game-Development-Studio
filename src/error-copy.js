// Clipboard helper for the Errors review. Every copy gets a final client-side redaction pass, so
// a value cannot leave through the clipboard with a key or email even if a rule changed.
import { redactText } from '../runtime/error-redaction.js';
import { createLog } from './app-log.js';

const log = createLog('errors');

/** Returns the text that will be copied. Local paths stay only when the user asked for them. */
export function prepareCopy(text, { includePaths = false } = {}) {
  return redactText(String(text || ''), {}, { keepPaths: includePaths });
}

// The label is a fixed word such as "Markdown", optionally with a count. Only that word is
// logged, never the copied text.
function copyKindOf(label) {
  const word = String(label ?? '').replace(/^\d+\s+/, '');
  return word.trim().toLowerCase().replace(/\s+/g, '-') || 'copy';
}

/** Copies text and returns a short status message for an aria-live region. */
export async function copyToClipboard(text, label, options) {
  const kind = copyKindOf(label);
  try {
    if (!navigator.clipboard?.writeText) {
      throw Error('Clipboard unavailable.');
    }
    await navigator.clipboard.writeText(prepareCopy(text, options));
    log.info('errors.copy.succeeded', { kind });
    return `${label} copied.`;
  } catch (error) {
    log.warn('errors.copy.failed', { kind, errorClass: error?.name });
    return 'Copy is unavailable in this browser. Select the text and copy it instead.';
  }
}
