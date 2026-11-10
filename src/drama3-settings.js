import { normalizeDrama3Request } from '../runtime/drama3-request.js';

function randomSeed() {
  if (!globalThis.crypto?.getRandomValues) {
    throw Error('Secure random seeds are unavailable in this browser.');
  }
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}
function numeric(value, fallback) {
  return value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : Number(value);
}

/** Turn the Voices form into a validated queue request; previews use a fixed seed. */
export function drama3Request(draft, { estimate = false, seedGenerator = randomSeed } = {}) {
  return normalizeDrama3Request({
    text: estimate ? draft.prompt || 'Estimate' : draft.prompt,
    seed: numeric(draft.dramaSeed, null) ?? (estimate ? 0 : seedGenerator()),
    max_tokens: numeric(draft.dramaMaxTokens, 500),
    temperature: numeric(draft.dramaTemperature, 1),
    top_p: numeric(draft.dramaTopP, 0.9),
  });
}
