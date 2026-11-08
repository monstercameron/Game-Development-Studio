// Imported for its side effects from src/main.jsx. Forwards uncaught browser errors to the
// studio's client log endpoint.

// Fire-and-forget: a failed upload must not raise another unhandled error, so the rejection
// is deliberately ignored.
function report(message) {
  fetch('/api/client-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'client-log' },
    body: JSON.stringify({ message: String(message).slice(0, 4000) }),
  }).catch(() => {});
}
window.addEventListener('error', (event) =>
  report(event.error?.stack || event.message || 'Unknown browser error'),
);
window.addEventListener('unhandledrejection', (event) =>
  report(event.reason?.stack || event.reason || 'Unhandled browser rejection'),
);
