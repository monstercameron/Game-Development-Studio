// Voice modes on the Qwen3-TTS worker. Each mode needs its own checkpoint; the worker holds one
// checkpoint at a time, so switching modes unloads the previous checkpoint first.
export const TTS_CHECKPOINTS = Object.freeze({
  custom_voice: {
    label: 'Qwen3-TTS CustomVoice',
    folder: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
    // Uncalibrated working budget used for admission; see tts-preparation.js.
    budgetMiB: 12 * 1024,
  },
  base: {
    label: 'Qwen3-TTS Base',
    folder: 'Qwen3-TTS-12Hz-1.7B-Base',
    budgetMiB: 8 * 1024,
  },
  voice_design: {
    label: 'Qwen3-TTS VoiceDesign',
    folder: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    budgetMiB: 8 * 1024,
  },
});
export const VOICE_MODES = Object.freeze(['preset', 'clone', 'design']);
const MODE_CHECKPOINT = Object.freeze({
  preset: 'custom_voice',
  clone: 'base',
  design: 'voice_design',
});
// Limits for cloning. The Base model card describes a 3-second clone; the upper bound is Forge's
// own choice to keep the prompt small and the request body bounded. The worker enforces the same
// range.
export const CLONE_REFERENCE_SECONDS = Object.freeze({ min: 3, max: 30 });
export const CLONE_REFERENCE_EXTENSIONS = Object.freeze(['wav', 'flac', 'mp3']);
export const CLONE_REFERENCE_PATTERN = /^[a-f0-9-]{36}\.(wav|flac|mp3)$/i;
export const CLONE_TRANSCRIPT_MAX = 1000;
export const VOICE_DESCRIPTION_MAX = 500;

// The checkpoint a voice request needs. Requests without a mode are preset voices (the original
// shape).
export function checkpointForRequest(request) {
  return MODE_CHECKPOINT[request?.mode ?? 'preset'];
}

// The worker reports loaded_variant. Workers started before this change omit it and only ever
// loaded the preset checkpoint, so a missing value means custom_voice.
export function loadedCheckpoint(health) {
  if (health?.loaded !== true) {
    return null;
  }
  return health.loaded_variant ?? 'custom_voice';
}

export function checkpointLoadedFor(health, request) {
  return loadedCheckpoint(health) === checkpointForRequest(request);
}

// Keeps only the fields that belong to a mode. Preset requests keep their original speaker and
// direction fields; cloning stores the staged reference ID and its transcript, or only the ID and
// clone_voice_only when the clone uses the speaker embedding alone; design stores the description.
// Consent is required to clone but is not stored in the request.
export function voiceModeFields(input) {
  const mode = input.mode ?? 'preset';
  if (!VOICE_MODES.includes(mode)) {
    throw Error('Choose a preset voice, clone a voice, or design a voice.');
  }
  if (mode === 'preset') {
    return { speaker: input.speaker, instruct: input.instruct };
  }
  if (mode === 'design') {
    const description =
      typeof input.voice_description === 'string' ? input.voice_description.trim() : '';
    if (!description || description.length > VOICE_DESCRIPTION_MAX) {
      throw Error(`Describe the voice in 1–${VOICE_DESCRIPTION_MAX} characters.`);
    }
    return { mode, voice_description: description };
  }
  if (input.reference_consent !== true) {
    throw Error('Confirm that you have the right to use this voice before cloning it.');
  }
  if (
    typeof input.reference_audio !== 'string' ||
    !CLONE_REFERENCE_PATTERN.test(input.reference_audio)
  ) {
    throw Error('Choose a WAV, FLAC or MP3 reference clip from the project.');
  }
  if (input.clone_voice_only !== undefined && typeof input.clone_voice_only !== 'boolean') {
    throw Error('Voice-only cloning must be true or false.');
  }
  // Voice-only cloning uses the speaker embedding alone, so the transcript is neither required
  // nor kept: a transcript sent with it would be ignored by the worker and would misdescribe the
  // render.
  if (input.clone_voice_only === true) {
    return { mode, reference_audio: input.reference_audio, clone_voice_only: true };
  }
  const transcript = typeof input.reference_text === 'string' ? input.reference_text.trim() : '';
  if (!transcript || transcript.length > CLONE_TRANSCRIPT_MAX) {
    throw Error(
      `Enter the exact words spoken in the reference clip, in 1–${CLONE_TRANSCRIPT_MAX} characters.`,
    );
  }
  return {
    mode,
    reference_audio: input.reference_audio,
    reference_text: transcript,
  };
}
