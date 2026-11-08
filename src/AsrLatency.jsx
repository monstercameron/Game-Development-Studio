import { useEffect, useId, useState } from 'react';

const modes = [
  [80, '80 ms · fastest replies'],
  [160, '160 ms · default'],
  [560, '560 ms · more accurate'],
  [1120, '1120 ms · most accurate'],
];

async function call(method, body) {
  const response = await fetch('/api/runtime/asr/latency', {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || 'Request failed.');
  }
  return result;
}

// Streaming latency of the speech engine. It is read when the engine starts, so applying a change
// restarts an idle engine; while a transcription is running the control is disabled.
export default function AsrLatency({ disabled = false }) {
  const id = useId();
  const [saved, setSaved] = useState(null);
  const [choice, setChoice] = useState(160);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    call('GET')
      .then((result) => {
        if (active) {
          setSaved(result.latencyMs);
          setChoice(result.latencyMs);
        }
      })
      .catch(() => {
        // Without a reading the control still works; it just cannot show the saved value.
      });
    return () => {
      active = false;
    };
  }, []);

  async function apply() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await call('POST', { latencyMs: choice });
      setSaved(result.latencyMs);
      setMessage(result.message);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="speech-latency">
      <label htmlFor={`${id}-latency`}>
        <span>Latency</span>
        <select
          id={`${id}-latency`}
          aria-describedby={`${id}-latency-help`}
          value={choice}
          disabled={disabled || busy}
          onChange={(event) => setChoice(Number(event.target.value))}
        >
          {modes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="outline-button"
        disabled={disabled || busy || choice === saved}
        onClick={apply}
      >
        {busy ? 'Applying…' : 'Apply'}
      </button>
      <small id={`${id}-latency-help`}>
        How much audio the engine listens to before it answers. Smaller replies sooner; larger is
        usually more accurate. Applying restarts the speech engine when it is idle and running.
      </small>
      {message && <small role="status">{message}</small>}
      {error && (
        <small className="speech-latency-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
