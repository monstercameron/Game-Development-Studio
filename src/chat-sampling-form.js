import { parseChatSampling } from '../runtime/chat-sampling.js';

// Form state keeps every value as text so a half-typed number is shown, not silently dropped.
export const EMPTY_SAMPLING = Object.freeze({
  topP: '',
  topK: '',
  minP: '',
  presencePenalty: '',
  frequencyPenalty: '',
  seed: '',
  stop: '',
});

// Field copy and HTML constraints for the Advanced sampling controls. Limits match the server.
export const SAMPLING_FIELDS = Object.freeze([
  {
    key: 'topP',
    label: 'Top-p',
    min: '0.01',
    max: '1',
    step: '0.01',
    help: 'Keep the smallest set of likely tokens whose probabilities reach this share (0 to 1).',
  },
  {
    key: 'topK',
    label: 'Top-k (local and compatible servers)',
    min: '1',
    max: '1000',
    step: '1',
    help: 'Consider only the k most likely tokens (1 to 1,000).',
  },
  {
    key: 'minP',
    label: 'Min-p (local and compatible servers)',
    min: '0',
    max: '1',
    step: '0.01',
    help: 'Drop tokens less likely than this fraction of the most likely token (0 to 1).',
  },
  {
    key: 'presencePenalty',
    label: 'Presence penalty',
    min: '-2',
    max: '2',
    step: '0.1',
    help: 'Positive values discourage repeating any token already used (-2 to 2).',
  },
  {
    key: 'frequencyPenalty',
    label: 'Frequency penalty',
    min: '-2',
    max: '2',
    step: '0.1',
    help: 'Positive values discourage tokens in proportion to how often they appear (-2 to 2).',
  },
  {
    key: 'seed',
    label: 'Seed',
    min: '0',
    max: '2147483647',
    step: '1',
    help: 'The same seed and settings aim to repeat a response. Blank lets the server choose.',
  },
  {
    key: 'stop',
    label: 'Stop sequences',
    help: 'One per line, up to 4, each up to 100 characters. Generation ends when one appears.',
  },
]);

// Converts the text form into request options (camelCase, as the server expects) and per-field
// messages. Blank fields are omitted so the server default applies. Options are withheld while any
// field has an error, so a partly valid form is never sent.
export function samplingFromForm(form, provider) {
  const options = {};
  const errors = {};
  for (const field of SAMPLING_FIELDS) {
    const raw = form[field.key] ?? '';
    if (field.key === 'stop') {
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length) {
        options.stop = lines;
      }
      continue;
    }
    if (!raw.trim()) {
      continue;
    }
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) {
      errors[field.key] = `${field.label} must be a number.`;
      continue;
    }
    options[field.key] = value;
  }
  for (const key of Object.keys(options)) {
    try {
      parseChatSampling({ [key]: options[key] }, { provider });
      // log-coverage: ignore -- called during render (Chat.jsx); the message is shown in the form.
    } catch (error) {
      errors[key] = error.message;
    }
  }
  return { options: Object.keys(errors).length ? {} : options, errors };
}
