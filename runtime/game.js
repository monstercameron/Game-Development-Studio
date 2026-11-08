import { createLogger } from './app-log.js';

const log = createLogger('game');

// The decision service already isolates its model in a separate local process.
export async function decide(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !input.questions ||
    typeof input.questions !== 'object' ||
    Array.isArray(input.questions) ||
    !Object.keys(input.questions).length ||
    Object.keys(input.questions).length > 16
  ) {
    log.warn('game.decision.rejected', { reason: 'invalid_questions' });
    throw Error('Provide between 1 and 16 named questions.');
  }
  // Mammoth answers a request without state (it decided on an empty game state in a live check), so
  // Forge must refuse it here rather than return a decision about nothing.
  if (typeof input.state !== 'string' || !input.state.trim()) {
    log.warn('game.decision.rejected', { reason: 'missing_state' });
    throw Error('Provide a game state as text.');
  }
  const requestBytes = Buffer.byteLength(JSON.stringify(input));
  if (requestBytes > 210000) {
    log.warn('game.decision.rejected', { reason: 'request_too_large', requestBytes });
    throw Error('Decision request is too large.');
  }
  log.debug('game.decision.started', {
    questionCount: Object.keys(input.questions).length,
    requestBytes,
  });
  const stopDecision = log.time('game.decision.completed', { host: '127.0.0.1' });
  try {
    const response = await fetch('http://127.0.0.1:8791/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
      redirect: 'error',
    });
    const body = await response.text();
    if (body.length > 1000000) {
      throw Error('Decision response is too large.');
    }
    let result;
    try {
      result = JSON.parse(body);
    } catch {
      throw Error('Decision service returned invalid JSON.');
    }
    stopDecision({ status: response.status });
    return { status: response.status, result };
  } catch (error) {
    log.warn('game.decision.failed', {
      host: '127.0.0.1',
      status: 503,
      reason: 'service_unavailable',
      errorClass: error?.name,
      errorCode: error?.code,
    });
    return {
      status: 503,
      result: { error: `Mammoth decision service unavailable: ${error.message}` },
    };
  }
}
