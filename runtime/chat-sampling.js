// Sampling options for chat completions. One parser serves the HTTP boundary, the MCP tool and the
// browser form, so limits cannot drift between them. Top-k and min-p are llama.cpp extensions:
// OpenAI does not accept them, so only compatible servers (including the local engine) get them.
export const CHAT_SAMPLING_LIMITS = Object.freeze({
  topP: { min: 0, max: 1, exclusiveMin: true },
  topK: { min: 1, max: 1000 },
  minP: { min: 0, max: 1 },
  presencePenalty: { min: -2, max: 2 },
  frequencyPenalty: { min: -2, max: 2 },
  seed: { min: 0, max: 2147483647 },
  stopMaxCount: 4,
  stopMaxLength: 100,
});

const LOCAL_ONLY_FIELDS = ['topK', 'minP'];

function isUnset(value) {
  return value === undefined || value === null;
}

function checkedNumber(value, label, limits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Error(`${label} must be a number.`);
  }
  const belowMinimum = limits.exclusiveMin ? value <= limits.min : value < limits.min;
  if (belowMinimum || value > limits.max) {
    const lower = limits.exclusiveMin ? `above ${limits.min}` : `from ${limits.min}`;
    throw Error(`${label} must be ${lower} up to ${limits.max}.`);
  }
  return value;
}

function checkedInteger(value, label, limits) {
  const number = checkedNumber(value, label, limits);
  if (!Number.isInteger(number)) {
    throw Error(`${label} must be a whole number.`);
  }
  return number;
}

function checkedStop(value) {
  if (!Array.isArray(value)) {
    throw Error('Stop sequences must be a list of text values.');
  }
  if (value.length > CHAT_SAMPLING_LIMITS.stopMaxCount) {
    throw Error(`Use at most ${CHAT_SAMPLING_LIMITS.stopMaxCount} stop sequences.`);
  }
  return value.map((item) => {
    if (typeof item !== 'string' || !item) {
      throw Error('Each stop sequence must be non-empty text.');
    }
    if (item.length > CHAT_SAMPLING_LIMITS.stopMaxLength) {
      throw Error(
        `Each stop sequence can be ${CHAT_SAMPLING_LIMITS.stopMaxLength} characters at most.`,
      );
    }
    return item;
  });
}

// Returns only the options that were set, using the OpenAI-compatible request field names.
// Throws an Error whose message is safe to show to the person.
export function parseChatSampling(input, { provider = 'compatible' } = {}) {
  const limits = CHAT_SAMPLING_LIMITS;
  const payload = {};
  if (provider === 'openai') {
    for (const field of LOCAL_ONLY_FIELDS) {
      if (!isUnset(input[field])) {
        throw Error('Top-k and min-p are available only for local or compatible servers.');
      }
    }
  }
  if (!isUnset(input.topP)) {
    payload.top_p = checkedNumber(input.topP, 'Top-p', limits.topP);
  }
  if (!isUnset(input.topK)) {
    payload.top_k = checkedInteger(input.topK, 'Top-k', limits.topK);
  }
  if (!isUnset(input.minP)) {
    payload.min_p = checkedNumber(input.minP, 'Min-p', limits.minP);
  }
  if (!isUnset(input.presencePenalty)) {
    payload.presence_penalty = checkedNumber(
      input.presencePenalty,
      'Presence penalty',
      limits.presencePenalty,
    );
  }
  if (!isUnset(input.frequencyPenalty)) {
    payload.frequency_penalty = checkedNumber(
      input.frequencyPenalty,
      'Frequency penalty',
      limits.frequencyPenalty,
    );
  }
  if (!isUnset(input.seed)) {
    payload.seed = checkedInteger(input.seed, 'Seed', limits.seed);
  }
  if (!isUnset(input.stop)) {
    const stop = checkedStop(input.stop);
    if (stop.length) {
      payload.stop = stop;
    }
  }
  return payload;
}
