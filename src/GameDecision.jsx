import { saveProjectText } from './save-project-text';
import { useEffect, useState } from 'react';
import { Copy, Gamepad2, LoaderCircle, Save } from 'lucide-react';
import { gameDecisionRequest, presentGameDecision } from './game-decision-input.js';
import MemoryDialog from './MemoryDialog.jsx';
import { formatDuration } from './queue-timing.js';
import './game-decision.css';

const historyKey = 'forge-decision-timing-v1';
function readTimings() {
  try {
    const value = JSON.parse(localStorage.getItem(historyKey) || '[]');
    return Array.isArray(value)
      ? value
          .filter(
            (item) =>
              typeof item?.type === 'string' && Number.isFinite(item.seconds) && item.seconds >= 0,
          )
          .slice(-30)
      : [];
  } catch {
    return [];
  }
}

export default function GameDecision({ draft, project, onSaved }) {
  const [result, setResult] = useState(null),
    [choiceLabel, setChoiceLabel] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const [timings, setTimings] = useState(readTimings);
  const [service, setService] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [saving, setSaving] = useState(false),
    [savedPath, setSavedPath] = useState('');
  useEffect(() => setSavedPath(''), [project?.id]);
  const [loading, setLoading] = useState(false),
    [notice, setNotice] = useState(''),
    [conflict, setConflict] = useState(null),
    [memoryError, setMemoryError] = useState('');
  useEffect(() => {
    let active = true;
    let request;
    const refresh = async () => {
      request?.abort();
      request = new AbortController();
      try {
        const response = await fetch('/api/runtime/services', { signal: request.signal });
        if (!response.ok) {
          throw Error('Could not check Mammoth status.');
        }
        const data = await response.json();
        const gameService = data.services?.find((item) => item.id === 'game') || null;
        if (active) {
          setService(gameService);
          setStatusError(gameService ? '' : 'Mammoth is not listed in the runtime status.');
        }
      } catch (reason) {
        if (active && reason.name !== 'AbortError') {
          setService(null);
          setStatusError(reason.message || 'Could not check Mammoth status.');
        }
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 4000);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(interval);
    };
  }, []);
  async function load() {
    setLoading(true);
    setMemoryError('');
    setNotice('');
    setError('');
    try {
      const response = await fetch('/api/runtime/models/game/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const data = await response.json();
      if (['insufficient_gpu_memory', 'insufficient_host_memory'].includes(data.code)) {
        setConflict(data);
        return;
      }
      if (!response.ok) {
        throw Error(data.message || data.error || 'Could not load Mammoth.');
      }
      setConflict(null);
      setNotice(data.message);
    } catch (e) {
      if (conflict) {
        setMemoryError(e.message);
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
    }
  }
  async function offload(id) {
    setLoading(true);
    setMemoryError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const data = await response.json();
      if (!response.ok) {
        throw Error(data.error || 'Could not stop the model.');
      }
      await load();
    } catch (e) {
      setMemoryError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function stop() {
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/runtime/models/game/offload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const data = await response.json();
      if (!response.ok) {
        throw Error(data.error || 'Could not stop Mammoth.');
      }
      setNotice(data.message);
      setService(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function run() {
    let request;
    try {
      request = gameDecisionRequest(draft);
    } catch (error) {
      setError(error.message);
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setChoiceLabel('');
    setCopied(false);
    setSavedPath('');
    try {
      const response = await fetch('/api/runtime/game/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify(request),
      });
      const data = await response.json();
      if (!response.ok) {
        throw Error(
          typeof data.detail === 'string'
            ? data.detail
            : JSON.stringify(data.detail || data.error || data),
        );
      }
      const choice = data?.answers?.decision?.choice;
      setChoiceLabel(
        request.questions.decision.type === 'choice'
          ? request.questions.decision.criteria[choice] || ''
          : '',
      );
      const elapsed = data?.metrics?.server_ms;
      if (typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0) {
        setTimings((previous) => {
          const next = [
            ...previous,
            { type: request.questions.decision.type, seconds: elapsed / 1000 },
          ].slice(-30);
          try {
            localStorage.setItem(historyKey, JSON.stringify(next));
          } catch {
            // Timing history is optional and must not block the decision result.
          }
          return next;
        });
      }
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const shown = presentGameDecision(result, draft.options?.[1]);
  const decisionType =
    draft.options?.[0] === 'Yes / No' ? 'noul' : draft.options?.[0]?.toLowerCase();
  const similar = timings
    .filter((item) => item.type === decisionType)
    .map((item) => item.seconds)
    .sort((a, b) => a - b);
  const decisionEstimate = similar.length ? similar[Math.floor((similar.length - 1) / 2)] : null;
  const isReady =
    service?.status === 'reachable' && service.modelLoaded === true && service.state !== 'error';
  const serviceState = statusError
    ? 'Could not check Mammoth status.'
    : service?.status === 'unavailable'
      ? 'Mammoth is stopped.'
      : service?.status === 'not_configured'
        ? 'Mammoth is not configured.'
        : service?.status === 'unverified'
          ? 'Mammoth status could not be verified.'
          : service?.status !== 'reachable'
            ? 'Checking Mammoth status…'
            : service.state === 'error'
              ? 'Mammoth reported a model error.'
              : service.modelLoaded === true
                ? 'Model loaded and ready.'
                : service.modelLoaded === false
                  ? service.state === 'loading'
                    ? 'Model is loading…'
                    : 'Service running · model not loaded.'
                  : 'Service reachable · model status unknown.';
  async function saveDecision() {
    setSaving(true);
    setError('');
    try {
      const output = await saveProjectText(
        project?.id,
        'decision',
        JSON.stringify(result, null, 2),
      );
      setSavedPath(output.path);
      onSaved?.();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSaving(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(shown, null, 2));
      setCopied(true);
    } catch {
      setError('Could not copy the result.');
    }
  }
  return (
    <section className="panel runtime-queue game-decision-panel">
      <div className="panel-heading">
        <div>
          <span className="mini-label">MAMMOTH · LIVE SERVICE</span>
          <h2>Test a decision</h2>
        </div>
        <Gamepad2 size={18} />
      </div>
      <div
        className={`game-service-state${isReady ? ' is-ready' : ''}`}
        role="status"
        aria-live="polite"
      >
        <span className="game-service-indicator" aria-hidden="true" />
        <div>
          <strong>{serviceState}</strong>
          <span>
            {statusError ||
              (service?.managed === false
                ? service.state === 'error'
                  ? 'Check the Mammoth application for the load failure. Forge cannot manage this service.'
                  : 'Started outside Forge. Forge will leave this service running when you stop it.'
                : service?.managed
                  ? service.state === 'error'
                    ? 'Stop the managed service, then start Mammoth again to retry the load.'
                    : 'Managed by Forge. Stop only unloads the managed Mammoth service.'
                  : 'Start or load Mammoth before running a decision.')}
          </span>
        </div>
      </div>
      <p className="helper">
        {draft.options?.[0] === 'Yes / No'
          ? 'Enter a question above. Mammoth returns a probability for yes.'
          : 'Enter a question, then at least two choices or score levels on separate lines.'}{' '}
        Load Mammoth before running. If its observed status is stale, Forge still tries the
        decision.
      </p>
      <div className="queue-timing-summary">
        <strong>
          Estimated decision time:{' '}
          {decisionEstimate === null
            ? 'Not enough history'
            : `~${formatDuration(decisionEstimate)}`}
        </strong>
        <span>
          {decisionEstimate === null
            ? 'Run this question type to build an estimate.'
            : `Based on ${similar.length} previous ${similar.length === 1 ? 'decision' : 'decisions'} of this type; model loading is extra.`}
        </span>
      </div>
      <div className="game-decision-actions">
        <button className="outline-button" onClick={load} disabled={loading}>
          {loading && <LoaderCircle className="game-spinner" size={16} aria-hidden="true" />}
          {loading ? 'Starting or loading…' : 'Start / load Mammoth'}
        </button>
        <button
          className="outline-button game-stop-button"
          onClick={stop}
          disabled={loading || busy || !service?.managed}
          title={
            !service?.managed
              ? 'Only a Forge-managed Mammoth service can be stopped here'
              : 'Stop the Forge-managed service'
          }
        >
          Stop managed Mammoth
        </button>
        <button
          className="game-run-button"
          onClick={run}
          disabled={busy || loading || service?.state === 'loading'}
          title={service?.state === 'loading' ? 'Wait for Mammoth to finish loading' : undefined}
        >
          {busy && <LoaderCircle className="game-spinner" size={17} aria-hidden="true" />}
          {busy ? 'Waiting for Mammoth…' : 'Run decision'}
        </button>
      </div>
      {notice && (
        <p className="helper" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          {choiceLabel && (
            <p className="helper" role="status">
              Selected: <strong>{choiceLabel}</strong>
            </p>
          )}
          <p className="helper">
            {draft.options?.[1] === 'Compact'
              ? 'Showing answers only.'
              : 'Showing the complete response, including metrics.'}{' '}
            This changes the display, not the decision.
          </p>
          <pre className="game-result">{JSON.stringify(shown, null, 2)}</pre>
          <div className="game-decision-actions">
            <button className="outline-button" onClick={copy}>
              <Copy size={15} />
              {copied ? 'Copied' : 'Copy displayed result'}
            </button>
            <button
              className="outline-button"
              disabled={!project || saving}
              title={!project ? 'Choose a project first' : 'Save the complete response as JSON'}
              onClick={saveDecision}
            >
              <Save size={15} />
              {saving ? 'Saving…' : 'Save JSON to project'}
            </button>
          </div>
          {savedPath && (
            <p className="helper" role="status">
              Saved to {savedPath}
            </p>
          )}
        </>
      )}
      {conflict && (
        <MemoryDialog
          target="Mammoth"
          conflict={conflict}
          onClose={() => {
            setConflict(null);
            setMemoryError('');
          }}
          onRetry={load}
          onOffload={offload}
          working={loading}
          error={memoryError}
        />
      )}
    </section>
  );
}
