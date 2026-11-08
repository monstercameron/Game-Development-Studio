function number(value, fallback, label, min, max, integer = false) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }
  if (!['number', 'string'].includes(typeof value)) {
    throw Error(
      `${label} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`,
    );
  }
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    (integer && !Number.isInteger(result))
  ) {
    throw Error(
      `${label} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`,
    );
  }
  return result;
}

// Variations are queued as separate jobs, so the count stays out of the engine request.
export function hyMotionVariationCount(draft) {
  return number(draft.motionVariations, 1, 'Variations', 1, 4, true);
}

export function hyMotionRequest(draft) {
  return {
    model: 'hy-motion',
    prompt: draft.prompt,
    duration: number(draft.motionDuration, 3, 'Duration', 1, 12),
    steps: number(draft.motionSteps, 50, 'Steps', 1, 100, true),
    guidance: number(draft.motionGuidance, 5, 'Guidance', 0, 20),
    seed: number(draft.seed, 123, 'Seed', 0, 2147483647, true),
  };
}
