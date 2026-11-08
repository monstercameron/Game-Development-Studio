// Client-side mirror of runtime/voice-modes.js. The server validates every limit again.
export const VOICE_MODE_LIST = ['preset', 'clone', 'design'];
// Checkpoints that must be staged before a mode can run, keyed by managed model ID.
export const VOICE_MODE_CHECKPOINTS = { clone: 'tts-base', design: 'tts-voicedesign' };
export const CLONE_REFERENCE_EXTENSIONS = ['wav', 'flac', 'mp3'];
export const CLONE_REFERENCE_MAX_BYTES = 32 * 1024 * 1024;
export const CLONE_REFERENCE_SECONDS = { min: 3, max: 30 };
export const CLONE_TRANSCRIPT_MAX = 1000;
export const VOICE_DESCRIPTION_MAX = 500;

// Field messages must match runtime/voice-modes.js word for word, so the inline message and the
// server refusal read the same.
const CLONE_REFERENCE_MESSAGE = 'Choose a WAV, FLAC or MP3 reference clip from the project.';
const CLONE_TRANSCRIPT_MESSAGE = `Enter the exact words spoken in the reference clip, in 1–${CLONE_TRANSCRIPT_MAX} characters.`;
const CLONE_CONSENT_MESSAGE =
  'Confirm that you have the right to use this voice before cloning it.';
const DESIGN_DESCRIPTION_MESSAGE = `Describe the voice in 1–${VOICE_DESCRIPTION_MAX} characters.`;

// Checks the fields of the active voice mode. Returns one message per field, or '' when valid.
// Preset voices have no required fields.
export function voiceModeFieldErrors(draft) {
  const mode = VOICE_MODE_LIST.includes(draft.voiceMode) ? draft.voiceMode : 'preset';
  const errors = { reference: '', transcript: '', consent: '', description: '' };
  if (mode === 'clone') {
    if (!String(draft.voiceReferenceId ?? '').trim()) {
      errors.reference = CLONE_REFERENCE_MESSAGE;
    } else {
      errors.reference = cloneReferenceLengthProblem(draft.voiceReferenceSeconds);
    }
    // Voice-only cloning sends no transcript, so an empty one is not an error there.
    const transcript = String(draft.voiceReferenceText ?? '').trim();
    const needsTranscript = draft.voiceCloneVoiceOnly !== true;
    if (needsTranscript && (!transcript || transcript.length > CLONE_TRANSCRIPT_MAX)) {
      errors.transcript = CLONE_TRANSCRIPT_MESSAGE;
    }
    if (draft.voiceConsent !== true) {
      errors.consent = CLONE_CONSENT_MESSAGE;
    }
  }
  if (mode === 'design') {
    const description = String(draft.voiceDescription ?? '').trim();
    if (!description || description.length > VOICE_DESCRIPTION_MAX) {
      errors.description = DESIGN_DESCRIPTION_MESSAGE;
    }
  }
  return errors;
}

// The first failing field in form order, so the top-level notice and focus agree.
export function firstVoiceModeError(errors) {
  return errors.reference || errors.transcript || errors.consent || errors.description || '';
}
// Longest wait for the browser to report a clip's duration before the check is skipped.
export const CLIP_DURATION_TIMEOUT_MS = 10000;

// Blocking message for a reference clip outside CLONE_REFERENCE_SECONDS. The worker says the same.
// An unknown duration (null, NaN, Infinity) returns no message: the worker measures the clip itself.
export function cloneReferenceLengthProblem(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  const { min, max } = CLONE_REFERENCE_SECONDS;
  if (seconds < min || seconds > max) {
    return `Reference audio must be ${min} to ${max} seconds long.`;
  }
  return '';
}

// Reads a clip's duration in the browser with an Audio element. Resolves to null when the browser
// cannot read the metadata, the duration is not finite, or the wait times out; callers then skip
// the check. Never rejects, so a failed read cannot block staging.
export function readClipDurationSeconds(file, { timeoutMs = CLIP_DURATION_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let objectUrl = '';
    let audio = null;
    let timer = 0;
    let settled = false;
    function finish(seconds) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (audio) {
        audio.onloadedmetadata = null;
        audio.onerror = null;
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      resolve(seconds);
    }
    try {
      objectUrl = URL.createObjectURL(file);
      audio = new Audio();
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const duration = audio.duration;
        finish(Number.isFinite(duration) && duration > 0 ? duration : null);
      };
      audio.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), timeoutMs);
      audio.src = objectUrl;
    } catch {
      // Some browsers refuse object URLs or audio elements; the worker still checks the clip.
      finish(null);
    }
  });
}
