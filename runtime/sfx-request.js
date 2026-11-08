import { isAudioSourceId, readAudioSource } from './references.js';

// The Stable Audio Lab app ignores unknown fields, so a Lab that predates audio input would
// silently render a plain text-to-sound result. Its status reports `audio_input` once patched.
export async function requireAudioInput(baseUrl, fetcher = fetch) {
  let response, status;
  try {
    response = await fetcher(`${baseUrl}/api/status`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    status = await response.json();
  } catch (error) {
    throw Error(
      'Could not check whether Stable Audio Lab accepts source sounds. Make sure it is running, then queue a new render.',
      { cause: error },
    );
  }
  if (!response.ok || status.audio_input !== true) {
    throw Error(
      'The running Stable Audio Lab does not accept source sounds yet. Restart it so the updated app.py loads (see the Studio guide).',
    );
  }
}

// The staged source sound travels as base64 inside the Lab request; Forge keeps only its ID.
export async function soundPayload(request, projectFolder) {
  const { source_audio: sourceAudio, ...rest } = request;
  if (!sourceAudio) {
    return rest;
  }
  let bytes;
  try {
    bytes = await readAudioSource(projectFolder, sourceAudio);
  } catch (error) {
    // The raw filesystem error names a local path; say what to do instead.
    throw Error(
      error?.code === 'ENOENT'
        ? 'The staged source sound is no longer available. Choose the sound again and queue a new render.'
        : `The source sound cannot be used: ${error.message}`,
      { cause: error },
    );
  }
  return { ...rest, source_audio: bytes.toString('base64') };
}

export const SOUND_EDIT_MODES = ['variation', 'replace', 'continue'];
export const INIT_NOISE_LEVEL = { min: 0.05, max: 1, fallback: 0.9 };

// Fields that start a sound from an existing one. `variation` re-renders the source with the
// prompt (audio-to-audio), `replace` regenerates one region, and `continue` extends the source to
// the requested duration. Returns only the fields that apply, in the stored request shape.
export function normalizeSoundSource(request, duration) {
  const {
    source_audio: sourceAudio = null,
    edit_mode: editMode = null,
    init_noise_level: initNoiseLevel = null,
    inpaint_start: inpaintStart = null,
    inpaint_end: inpaintEnd = null,
  } = request;
  const others = [editMode, initNoiseLevel, inpaintStart, inpaintEnd];
  if (sourceAudio === null) {
    if (others.some((value) => value !== null)) {
      throw Error('Source sound options need a staged source sound.');
    }
    return {};
  }
  if (!isAudioSourceId(sourceAudio)) {
    throw Error('Provide a staged source sound ID.');
  }
  if (!SOUND_EDIT_MODES.includes(editMode)) {
    throw Error('Choose variation, replace, or continue for the source sound.');
  }
  if (editMode === 'variation') {
    const level = initNoiseLevel ?? INIT_NOISE_LEVEL.fallback;
    if (
      !Number.isFinite(level) ||
      level < INIT_NOISE_LEVEL.min ||
      level > INIT_NOISE_LEVEL.max ||
      inpaintStart !== null ||
      inpaintEnd !== null
    ) {
      throw Error('Change amount must be from 0.05 to 1, and a variation has no replaced region.');
    }
    return { source_audio: sourceAudio, edit_mode: 'variation', init_noise_level: level };
  }
  if (initNoiseLevel !== null) {
    throw Error('Change amount applies only to a variation of the source sound.');
  }
  if (editMode === 'continue') {
    if (inpaintStart !== null || inpaintEnd !== null) {
      throw Error('Continuing a sound has no replaced region.');
    }
    return { source_audio: sourceAudio, edit_mode: 'continue' };
  }
  if (
    !Number.isFinite(inpaintStart) ||
    !Number.isFinite(inpaintEnd) ||
    inpaintStart < 0 ||
    inpaintEnd <= inpaintStart ||
    inpaintEnd > duration
  ) {
    throw Error(
      'Replace needs a start and end in seconds: 0 up to the sound duration, end after start.',
    );
  }
  return {
    source_audio: sourceAudio,
    edit_mode: 'replace',
    inpaint_start: inpaintStart,
    inpaint_end: inpaintEnd,
  };
}
