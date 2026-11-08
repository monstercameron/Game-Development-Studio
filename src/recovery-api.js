// Client calls for the Recovery report (/api/recovery). Actions carry the studio request header
// that the server checks together with Origin.

export class RecoveryApiError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.status = status;
  }
}

async function parse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new RecoveryApiError(data.error || `The recovery service returned ${response.status}.`, {
      status: response.status,
    });
  }
  return data;
}

export async function getRecovery({ signal } = {}) {
  return parse(await fetch('/api/recovery', { signal }));
}

/** @param {{ action: string }} body one of the actions listed in runtime/recovery-report.js */
export async function postRecovery(body, { signal } = {}) {
  return parse(
    await fetch('/api/recovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'recovery' },
      body: JSON.stringify(body),
      signal,
    }),
  );
}
