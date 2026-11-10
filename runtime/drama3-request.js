// Portable validation for Fish Audio Drama 3's CUDA queue request. The GPU engine runs as a
// one-shot process; these limits keep requests bounded and do not claim an audio duration.
export const DRAMA3_MAX_TEXT = 1000;
export const DRAMA3_MAX_TOKENS = 2048;
export const DRAMA3_DEFAULT_TOKENS = 500;
const KEYS = new Set(['text', 'seed', 'max_tokens', 'temperature', 'top_p']);

/** Validate and normalize one speech request without accessing the filesystem or GPU. */
export function normalizeDrama3Request(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Error('Drama 3 settings must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) {
      throw Error(`Unsupported Drama 3 setting: ${key.slice(0, 40)}.`);
    }
  }
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > DRAMA3_MAX_TEXT) {
    throw Error(`Enter dialogue using 1–${DRAMA3_MAX_TEXT} characters.`);
  }
  const seed = input.seed;
  const maxTokens = input.max_tokens ?? DRAMA3_DEFAULT_TOKENS;
  const temperature = input.temperature ?? 1;
  const topP = input.top_p ?? 0.9;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) {
    throw Error('Seed must be a whole number from 0 to 2147483647.');
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > DRAMA3_MAX_TOKENS) {
    throw Error(`Maximum audio tokens must be from 1 to ${DRAMA3_MAX_TOKENS}.`);
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw Error('Temperature must be between 0 and 2.');
  }
  if (!Number.isFinite(topP) || topP <= 0 || topP > 1) {
    throw Error('Top-p must be greater than 0 and at most 1.');
  }
  return { text: input.text.trim(), seed, max_tokens: maxTokens, temperature, top_p: topP };
}
