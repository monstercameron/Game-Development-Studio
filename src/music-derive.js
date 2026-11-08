// Requests that extend or re-synthesize a finished music asset. The queue resolves the asset to the
// YuE2 render that made it, so the request names the asset and never carries audio.
const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

export function canDeriveMusic(asset) {
  return Boolean(
    asset &&
    asset.category === 'Audio' &&
    typeof asset.id === 'string' &&
    asset.id.toLowerCase().startsWith('music/'),
  );
}

function whole(value, name, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

export function deriveMusicRequest(operation, asset, values = {}) {
  if (!canDeriveMusic(asset)) {
    throw Error('Choose a music file from this project.');
  }
  const seed = isBlank(values.seed) ? undefined : whole(values.seed, 'Seed', 0, 2147483647);
  const base = { operation, source: asset.id, ...(seed === undefined ? {} : { seed }) };
  if (operation === 'extend') {
    const seconds = isBlank(values.addSeconds) ? 30 : Number(values.addSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) {
      throw Error('Seconds to add must be a number from 1 to 300.');
    }
    const lyrics = String(values.lyricsAddition ?? '').trim();
    if (lyrics.length > 5000) {
      throw Error('New lyrics must be at most 5,000 characters.');
    }
    return { ...base, add_seconds: seconds, ...(lyrics ? { lyrics_addition: lyrics } : {}) };
  }
  if (operation === 'resynth') {
    return {
      ...base,
      ...(isBlank(values.steps) ? {} : { ode_steps: whole(values.steps, 'Steps', 1, 100) }),
    };
  }
  throw Error('Choose Extend or Re-synthesize.');
}
