// Source sounds the Stable Audio Lab can read (libsndfile); Opus is not supported there.
export const SOUND_SOURCE_EXTENSIONS = ['wav', 'flac', 'mp3', 'ogg'];
export const SOUND_SOURCE_MAX_BYTES = 32 * 1024 * 1024;

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

// The sound length the draft will request, in seconds: a custom value wins over the preset.
export function soundDurationSeconds(draft) {
  const custom = Number(draft.soundDuration);
  if (!isBlank(draft.soundDuration) && Number.isFinite(custom)) {
    return custom;
  }
  return Number.parseFloat(draft.options?.[0]) || 5;
}

// Empty text means the value is acceptable (or not entered yet); otherwise it says what to fix.
export function changeAmountProblem(value) {
  if (isBlank(value)) {
    return '';
  }
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0.05 && amount <= 1
    ? ''
    : 'Enter a number from 0.05 to 1.';
}

export function regionProblems(draft) {
  const problems = { start: '', end: '' };
  const start = isBlank(draft.soundRegionStart) ? null : Number(draft.soundRegionStart);
  const end = isBlank(draft.soundRegionEnd) ? null : Number(draft.soundRegionEnd);
  if (start !== null && (!Number.isFinite(start) || start < 0)) {
    problems.start = 'Enter 0 or more seconds.';
  }
  if (end !== null && (!Number.isFinite(end) || end <= 0)) {
    problems.end = 'Enter a number of seconds above 0.';
  } else if (end !== null && !problems.start && start !== null && end <= start) {
    problems.end = 'The end must be after the start.';
  } else if (end !== null && end > soundDurationSeconds(draft)) {
    problems.end = `The end must be within the sound duration (${soundDurationSeconds(draft)} s).`;
  }
  return problems;
}
