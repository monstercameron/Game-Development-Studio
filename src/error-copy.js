// Clipboard helper for the Errors review. Every copy gets a final client-side redaction pass, so
// a value cannot leave through the clipboard with a key or email even if a rule changed.
import { redactText } from '../runtime/error-redaction.js';

/** Returns the text that will be copied. Local paths stay only when the user asked for them. */
export function prepareCopy(text, { includePaths = false } = {}) {
  return redactText(String(text || ''), {}, { keepPaths: includePaths });
}

/** Copies text and returns a short status message for an aria-live region. */
export async function copyToClipboard(text, label, options) {
  try {
    if (!navigator.clipboard?.writeText) {
      throw Error('Clipboard unavailable.');
    }
    await navigator.clipboard.writeText(prepareCopy(text, options));
    return `${label} copied.`;
  } catch {
    return 'Copy is unavailable in this browser. Select the text and copy it instead.';
  }
}
