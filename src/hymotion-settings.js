// Blank or missing values use the fallback. Any other value must be a number or numeric string
// that Number() converts to a finite value in range (a whole number when integer is set).
function readBoundedNumber(value, fallback, label, min, max, integer = false) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }
  const expectation = `${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`;
  if (!['number', 'string'].includes(typeof value)) {
    throw Error(`${label} must be ${expectation}`);
  }
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    (integer && !Number.isInteger(result))
  ) {
    throw Error(`${label} must be ${expectation}`);
  }
  return result;
}

// Variations are queued as separate jobs, so the count stays out of the engine request.
export function hyMotionVariationCount(draft) {
  return readBoundedNumber(draft.motionVariations, 1, 'Variations', 1, 4, true);
}

export function hyMotionRequest(draft) {
  return {
    model: 'hy-motion',
    prompt: draft.prompt,
    duration: readBoundedNumber(draft.motionDuration, 3, 'Duration', 1, 12),
    steps: readBoundedNumber(draft.motionSteps, 50, 'Steps', 1, 100, true),
    guidance: readBoundedNumber(draft.motionGuidance, 5, 'Guidance', 0, 20),
    seed: readBoundedNumber(draft.seed, 123, 'Seed', 0, 2147483647, true),
  };
}
