import {
  cloneReferenceLengthProblem,
  firstVoiceModeError,
  voiceModeFieldErrors,
} from './voice-modes.js';

// Convert the creator's audio settings to the exact durable queue request.
// Optional custom values override presets only when the creator enters them.
const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';
function numberSetting(value, fallback, { name, min, max, integer = false }) {
  if (isBlank(value)) {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) {
    throw Error(
      `${name} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`,
    );
  }
  return n;
}
const sampleSwitch = (value) => (value === 'on' ? true : value === 'off' ? false : null);
function randomSeed() {
  if (!globalThis.crypto?.getRandomValues) {
    throw Error('Secure random seeds are unavailable in this browser.');
  }
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}
// Starting from an existing sound. The source was staged when it was chosen, so the draft holds
// only its ID; nothing is sent unless one is set.
export function soundSourceFields(draft, duration) {
  const source = String(draft.soundSourceId ?? '').trim();
  if (!source) {
    return {};
  }
  const mode = ['variation', 'replace', 'continue'].includes(draft.soundEditMode)
    ? draft.soundEditMode
    : 'variation';
  if (mode === 'variation') {
    return {
      source_audio: source,
      edit_mode: mode,
      init_noise_level: numberSetting(draft.soundInitLevel, 0.9, {
        name: 'Change amount',
        min: 0.05,
        max: 1,
      }),
    };
  }
  if (mode === 'continue') {
    return { source_audio: source, edit_mode: mode };
  }
  const start = numberSetting(draft.soundRegionStart, null, {
    name: 'Replace from',
    min: 0,
    max: 380,
  });
  const end = numberSetting(draft.soundRegionEnd, null, { name: 'Replace to', min: 0, max: 380 });
  if (start === null || end === null || end <= start || end > duration) {
    throw Error(
      'Enter where the replaced part starts and ends, in seconds: the end must come after the start and fit inside the sound duration.',
    );
  }
  return { source_audio: source, edit_mode: mode, inpaint_start: start, inpaint_end: end };
}
export function audioPayload(type, projectId, draft, { seedGenerator = randomSeed } = {}) {
  const options = draft.options || [];
  if (type === 'music') {
    const presets = { 'Full arrangement': 'full', Melody: 'melody', Off: 'off' };
    const guidance = numberSetting(draft.musicGuidance, null, {
      name: 'Guidance',
      min: 0,
      max: 20,
    });
    const seed = isBlank(draft.seed)
      ? seedGenerator()
      : numberSetting(draft.seed, 0, {
          name: 'Seed',
          min: 0,
          max: 2147483647,
          integer: true,
        });
    const score = String(draft.musicScore ?? '').trim();
    const cot = presets[options[1]] || 'full';
    if (score && cot === 'off') {
      throw Error('A melody score needs Planning set to Full arrangement or Melody.');
    }
    // Sampling overrides are sent only when entered, so the engine keeps its own defaults.
    const sampling = {
      temperature: numberSetting(draft.musicTemperature, null, {
        name: 'Temperature',
        min: 0,
        max: 5,
      }),
      top_p: numberSetting(draft.musicTopP, null, { name: 'Top-p', min: 0.01, max: 1 }),
      top_k: numberSetting(draft.musicTopK, null, {
        name: 'Top-k',
        min: 1,
        max: 1000,
        integer: true,
      }),
      repetition_penalty: numberSetting(draft.musicRepetition, null, {
        name: 'Repetition penalty',
        min: 1,
        max: 2,
      }),
    };
    return {
      type,
      projectId,
      request: {
        style: draft.prompt,
        lyrics: draft.second,
        duration_seconds: numberSetting(draft.musicDuration, Number.parseFloat(options[0]) || 15, {
          name: 'Music duration',
          min: 1,
          max: 600,
        }),
        cot,
        seed,
        ode_steps: numberSetting(draft.musicSteps, 32, {
          name: 'Music steps',
          min: 1,
          max: 100,
          integer: true,
        }),
        title: draft.musicTitle || '',
        negative: draft.musicNegative || '',
        cfg_scale: guidance,
        ...(score ? { abc: score } : {}),
        ...Object.fromEntries(Object.entries(sampling).filter(([, value]) => value !== null)),
      },
    };
  }
  if (type === 'sfx') {
    const quality = { 'Balanced · 8 steps': 8, 'Draft · 4 steps': 4, 'Detailed · 20 steps': 20 };
    const duration = numberSetting(draft.soundDuration, Number.parseFloat(options[0]) || 5, {
      name: 'Sound duration',
      min: 1,
      max: 380,
    });
    return {
      type,
      projectId,
      request: {
        prompt: draft.prompt,
        duration,
        ...soundSourceFields(draft, duration),
        steps: numberSetting(draft.soundSteps, quality[options[1]] || 8, {
          name: 'Sound steps',
          min: 1,
          max: 50,
          integer: true,
        }),
        seed: numberSetting(draft.seed, -1, {
          name: 'Seed',
          min: 0,
          max: 2147483647,
          integer: true,
        }),
      },
    };
  }
  if (type === 'voices') {
    const speakers = [
      'Ryan',
      'Aiden',
      'Vivian',
      'Serena',
      'Uncle_Fu',
      'Dylan',
      'Eric',
      'Ono_Anna',
      'Sohee',
    ];
    const languages = [
      'Auto',
      'English',
      'Chinese',
      'Japanese',
      'Korean',
      'German',
      'French',
      'Russian',
      'Portuguese',
      'Spanish',
      'Italian',
    ];
    const voiceSampling = {
      temperature: numberSetting(draft.voiceTemperature, null, {
        name: 'Voice temperature',
        min: 0.05,
        max: 2,
      }),
      top_p: numberSetting(draft.voiceTopP, null, { name: 'Voice top-p', min: 0.01, max: 1 }),
      top_k: numberSetting(draft.voiceTopK, null, {
        name: 'Voice top-k',
        min: 1,
        max: 1000,
        integer: true,
      }),
      repetition_penalty: numberSetting(draft.voiceRepetition, null, {
        name: 'Voice repetition penalty',
        min: 1,
        max: 2,
      }),
      subtalker_temperature: numberSetting(draft.voiceSubTemperature, null, {
        name: 'Fine-detail temperature',
        min: 0.05,
        max: 2,
      }),
      subtalker_top_p: numberSetting(draft.voiceSubTopP, null, {
        name: 'Fine-detail top-p',
        min: 0.01,
        max: 1,
      }),
      subtalker_top_k: numberSetting(draft.voiceSubTopK, null, {
        name: 'Fine-detail top-k',
        min: 1,
        max: 1000,
        integer: true,
      }),
    };
    // Switches are sent only when chosen: 'on' samples, 'off' decodes greedily.
    const switches = {
      do_sample: sampleSwitch(draft.voiceDoSample),
      subtalker_dosample: sampleSwitch(draft.voiceSubDoSample),
    };
    const language = languages.includes(options[1]) ? options[1] : 'English';
    const shared = {
      text: draft.prompt,
      language,
      max_new_tokens: numberSetting(draft.voiceMaxTokens, 1024, {
        name: 'Voice token limit',
        min: 64,
        max: 4096,
        integer: true,
      }),
      seed: isBlank(draft.seed)
        ? seedGenerator()
        : numberSetting(draft.seed, 0, {
            name: 'Seed',
            min: 0,
            max: 2147483647,
            integer: true,
          }),
      // Sampling overrides are sent only when entered, so the model keeps its own defaults.
      ...Object.fromEntries(
        Object.entries({ ...voiceSampling, ...switches }).filter(([, value]) => value !== null),
      ),
    };
    const speaker = speakers.includes(options[0]) ? options[0] : 'Ryan';
    return { type, projectId, request: voiceModeRequest(draft, shared, speaker) };
  }
  throw Error('Unsupported audio workflow.');
}
// The mode decides which fields are sent. Preset voices keep their original request shape.
function voiceModeRequest(draft, shared, speaker) {
  const mode =
    draft.voiceMode === 'clone' || draft.voiceMode === 'design' ? draft.voiceMode : 'preset';
  if (mode !== 'preset') {
    // Same messages as runtime/voice-modes.js, so a refusal here reads like the worker's.
    const error = firstVoiceModeError(voiceModeFieldErrors(draft));
    if (error) {
      throw Error(error);
    }
  }
  if (mode === 'design') {
    const description = String(draft.voiceDescription ?? '').trim();
    return { ...shared, mode, voice_description: description };
  }
  if (mode === 'clone') {
    const reference = String(draft.voiceReferenceId ?? '').trim();
    const lengthProblem = cloneReferenceLengthProblem(draft.voiceReferenceSeconds);
    if (lengthProblem) {
      throw Error(lengthProblem);
    }
    return {
      ...shared,
      mode,
      reference_audio: reference,
      reference_text: String(draft.voiceReferenceText ?? ''),
      reference_consent: true,
    };
  }
  return { ...shared, speaker, instruct: draft.second || '' };
}
