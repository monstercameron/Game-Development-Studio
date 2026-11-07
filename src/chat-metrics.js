// TTFT measures from submitting the completion request to the first text or
// reasoning delta; model startup happens before the request and is excluded.
export function createResponseMetrics(startedAt) {
  let first = null,
    last = null,
    tokens = null,
    serverRate = null;
  return {
    observe(part, at) {
      const delta = part?.choices?.[0]?.delta;
      if (
        [delta?.content, delta?.reasoning_content, delta?.reasoning].some(
          (value) => typeof value === 'string' && value.length > 0,
        ) &&
        Number.isFinite(at)
      ) {
        if (first === null) {
          first = at;
        }
        last = at;
      }
      if (
        Number.isSafeInteger(part?.usage?.completion_tokens) &&
        part.usage.completion_tokens >= 0
      ) {
        tokens = part.usage.completion_tokens;
      }
      if (
        Number.isFinite(part?.timings?.predicted_per_second) &&
        part.timings.predicted_per_second > 0
      ) {
        serverRate = part.timings.predicted_per_second;
      }
    },
    finish() {
      const ttftMs =
        first !== null && Number.isFinite(startedAt) ? Math.max(0, first - startedAt) : null;
      const duration = last !== null && first !== null ? last - first : 0;
      // The first token arrived at the start of this interval. A single chunk or
      // a zero interval is insufficient to derive a reliable client-side rate.
      const clientRate = tokens > 1 && duration > 0 ? ((tokens - 1) * 1000) / duration : null;
      return {
        ttftMs,
        outputTokens: tokens,
        tokensPerSecond: serverRate ?? clientRate,
        rateSource: serverRate !== null ? 'server' : clientRate !== null ? 'client' : null,
      };
    },
  };
}
