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
    throw Error('Provide between 1 and 16 named questions.');
  }
  // Mammoth answers a request without state (it decided on an empty game state in a live check), so
  // Forge must refuse it here rather than return a decision about nothing.
  if (typeof input.state !== 'string' || !input.state.trim()) {
    throw Error('Provide a game state as text.');
  }
  const bytes = Buffer.byteLength(JSON.stringify(input));
  if (bytes > 210000) {
    throw Error('Decision request is too large.');
  }
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
    return { status: response.status, result };
  } catch (error) {
    return {
      status: 503,
      result: { error: `Mammoth decision service unavailable: ${error.message}` },
    };
  }
}
