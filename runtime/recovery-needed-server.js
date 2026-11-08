// What answers on the studio port after the supervisor stopped restarting a crashing studio host
// (runtime/crash-loop.js). A dead port would look like "nothing happened"; this tiny responder
// says that Forge stopped on purpose and what to do. It serves no studio data and no scripts.
import http from 'node:http';

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * @param {{ port: number, component: string, count: number, windowMs: number }} options
 * @returns {Promise<http.Server | null>} null when the port could not be bound
 */
export function startRecoveryNeededServer({ port, component, count, windowMs }) {
  const windowMinutes = Math.max(1, Math.round(windowMs / 60000));
  const message =
    `Forge Studio stopped its ${component} after ${count} crashes in ${windowMinutes} minutes, ` +
    'instead of restarting it again. Your queued renders, projects and models were not changed, ' +
    'and engines that were running still are. Open Diagnostics logs, or run the studio from a ' +
    'terminal to see the error, fix the cause, then start the studio again. After the restart the ' +
    'Recovery panel lists anything that needs a decision.';
  const server = http.createServer((req, res) => {
    if (!LOOPBACK_HOST.test(req.headers.host || '')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"Local studio requests only."}');
      return;
    }
    const wantsJson = (req.url || '').startsWith('/api/');
    res.writeHead(503, {
      'Content-Type': wantsJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '60',
    });
    if (wantsJson) {
      res.end(JSON.stringify({ error: 'recovery_needed', component, count, windowMs, message }));
      return;
    }
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Forge Studio: recovery needed</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>Recovery needed</h1><p role="alert">${escapeHtml(message)}</p></body></html>`,
    );
  });
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
