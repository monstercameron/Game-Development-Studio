// Client calls for the Errors review (/api/errors). Mutations carry the studio request header
// that the server checks together with Origin.

export class ErrorsApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parse(response) {
  // A non-JSON body (for example a proxy error page) is treated as empty so the
  // status-based message below still applies.
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ErrorsApiError(
      responseBody.error || `The errors service returned ${response.status}.`,
      {
        status: response.status,
        code: responseBody.code,
      },
    );
  }
  return responseBody;
}

export async function getErrors(path, { signal } = {}) {
  return parse(await fetch(`/api/errors${path}`, { signal }));
}

export async function postErrors(path, body = {}, { signal } = {}) {
  return parse(
    await fetch(`/api/errors${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'errors' },
      body: JSON.stringify(body),
      signal,
    }),
  );
}
