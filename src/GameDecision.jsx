import { saveProjectText } from './save-project-text';
import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Gamepad2, LoaderCircle, Save } from 'lucide-react';
import {
  decisionSummaries,
  gameDecisionRequest,
  gameQuestion,
  MAX_GAME_QUESTIONS,
  mammothStateDetail,
  presentGameDecision,
} from './game-decision-input.js';
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

function errorText(detail) {
  if (typeof detail === 'string') {
    return detail;
  }
  if (Array.isArray(detail)) {
    // FastAPI validation errors: show the messages, not the raw JSON.
    return detail.map((item) => item?.msg || JSON.stringify(item)).join(' ');
  }
  return '';
}

export default function GameDecision({ draft, project, onSaved }) {
  const [result, setResult] = useState(null),
    [summaries, setSummaries] = useState([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const [timings, setTimings] = useState(readTimings);
  // Extra questions are about the same game state; they stay in this panel and are not saved
  // with the draft.
  const [extraQuestions, setExtraQuestions] = useState([]);
  const nextExtraId = useRef(0);
  const extraBaseId = useId();
  const [service, setService] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [saving, setSaving] = useState(false),
    [savedPath, setSavedPath] = useState('');
  const runHintId = useId();
  const stopHintId = useId();
  const saveHintId = useId();
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
      // Keep the last known service and mark the model unloaded until the next status poll.
      setService((previous) =>
        previous ? { ...previous, modelLoaded: false, state: 'stopped' } : previous,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function run() {
    let request;
    try {
      request = gameDecisionRequest(draft, extraQuestions);
    } catch (error) {
      setError(error.message);
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setSummaries([]);
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
        throw Error(errorText(data.detail) || data.error || 'Mammoth could not answer.');
      }
      setSummaries(decisionSummaries(data, request));
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
  const extraErrors = extraQuestions.map((item) => {
    try {
      gameQuestion(item.mode, item.text);
      return '';
    } catch (reason) {
      return reason.message;
    }
  });
  function addExtraQuestion() {
    setExtraQuestions((previous) =>
      previous.length + 1 >= MAX_GAME_QUESTIONS
        ? previous
        : [...previous, { id: (nextExtraId.current += 1), mode: 'Choice', text: '' }],
    );
  }
  function updateExtraQuestion(id, changes) {
    setExtraQuestions((previous) =>
      previous.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  }
  function removeExtraQuestion(id) {
    setExtraQuestions((previous) => previous.filter((item) => item.id !== id));
  }
  const decisionType =
    draft.options?.[0] === 'Yes / No' ? 'noul' : draft.options?.[0]?.toLowerCase();
  const similar = timings
    .filter((item) => item.type === decisionType)
    .map((item) => item.seconds)
    .sort((a, b) => a - b);
  const decisionEstimate = similar.length ? similar[Math.floor((similar.length - 1) / 2)] : null;
  const isReady =
    service?.status === 'reachable' && service.modelLoaded === true && service.state !== 'error';
  const modelLoading = service?.state === 'loading';
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
  // Run stays enabled unless a load is in progress: observed status can be stale, so the
  // decision request is still sent. The hint says what to expect next to the button.
  const runHint = isReady
    ? null
    : modelLoading
      ? 'Mammoth is still loading. Run becomes available when loading finishes.'
      : !service ||
          statusError ||
          service.status === 'unverified' ||
          (service.status === 'reachable' && service.modelLoaded === null) ||
          service.modelLoaded === undefined
        ? 'Readiness is unconfirmed. Run will still try.'
        : 'Not ready yet. Start or load Mammoth first; Run will still try and will likely fail.';
  const stopHint = busy
    ? 'Wait for the current decision to finish.'
    : !service || service.managed
      ? null
      : service.status === 'reachable'
        ? 'This Mammoth service was started outside Forge, so Forge will not stop it.'
        : 'Nothing for Forge to stop.';
  async function saveDecision() {
    setSaving(true);
    setError('');
    try {
      const output = await saveProjectText(
        project?.id,
        'decision',
        JSON.stringify(result, null, 2),
        {
          prompt: draft.prompt,
          settings: { question_type: draft.options?.[0], result_view: draft.options?.[1] },
        },
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
        <Gamepad2 size={18} aria-hidden="true" />
      </div>
      <div
        className={`game-service-state${isReady ? ' is-ready' : ''}`}
        role="status"
        aria-live="polite"
      >
        <span className="game-service-indicator" aria-hidden="true" />
        <div>
          <strong>{serviceState}</strong>
          <span>{mammothStateDetail(service, statusError)}</span>
        </div>
      </div>
      <p className="helper">
        {draft.options?.[0] === 'Yes / No'
          ? 'Yes / No returns the probability that the answer is yes.'
          : 'Choice returns the most likely option with a probability for each option.'}
      </p>
      <fieldset className="game-extra-questions">
        <legend>Additional questions about the same state</legend>
        <p className="helper">
          Each extra question is answered in the same request, up to {MAX_GAME_QUESTIONS} questions
          in total. Choice and Score questions use the same rules as the main question. These are
          not saved with the draft.
        </p>
        {extraQuestions.map((item, index) => {
          const errorId = `${extraBaseId}-error-${item.id}`;
          const errorText = extraErrors[index];
          return (
            <div className="game-extra-question" key={item.id}>
              <label>
                Question {index + 2} type
                <select
                  value={item.mode}
                  onChange={(event) => updateExtraQuestion(item.id, { mode: event.target.value })}
                >
                  <option value="Choice">Choice</option>
                  <option value="Score">Score</option>
                  <option value="Yes / No">Yes / No</option>
                </select>
              </label>
              <label>
                Question {index + 2} text
                <textarea
                  rows={3}
                  value={item.text}
                  aria-invalid={errorText ? 'true' : undefined}
                  aria-describedby={errorText ? errorId : undefined}
                  onChange={(event) => updateExtraQuestion(item.id, { text: event.target.value })}
                />
              </label>
              {errorText && (
                <p id={errorId} className="settings-error" role="alert">
                  {errorText}
                </p>
              )}
              <button
                type="button"
                className="text-action danger"
                onClick={() => removeExtraQuestion(item.id)}
              >
                Remove question {index + 2}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="outline-button"
          onClick={addExtraQuestion}
          disabled={extraQuestions.length + 1 >= MAX_GAME_QUESTIONS}
        >
          Add question
        </button>
        {extraQuestions.length + 1 >= MAX_GAME_QUESTIONS && (
          <p className="helper">
            Mammoth accepts at most {MAX_GAME_QUESTIONS} questions per request.
          </p>
        )}
      </fieldset>
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
        <button
          className={`outline-button game-load-button${isReady ? '' : ' is-primary'}`}
          onClick={load}
          disabled={loading}
        >
          {loading && <LoaderCircle className="game-spinner" size={16} aria-hidden="true" />}
          {loading ? 'Starting or loading…' : 'Start / load Mammoth'}
        </button>
        <button
          className="outline-button game-stop-button"
          onClick={stop}
          disabled={loading || busy || !service?.managed}
          aria-describedby={stopHint ? stopHintId : undefined}
        >
          Stop managed Mammoth
        </button>
        <button
          className="game-run-button"
          onClick={run}
          disabled={busy || loading || modelLoading}
          aria-describedby={runHint ? runHintId : undefined}
        >
          {busy && <LoaderCircle className="game-spinner" size={17} aria-hidden="true" />}
          {busy ? 'Waiting for Mammoth…' : 'Run decision'}
        </button>
      </div>
      {(runHint || stopHint) && (
        <div className="game-action-hints">
          {runHint && (
            <p id={runHintId} className="helper game-action-hint">
              {runHint}
            </p>
          )}
          {stopHint && (
            <p id={stopHintId} className="helper game-action-hint">
              {stopHint}
            </p>
          )}
        </div>
      )}
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
          {summaries.map(({ name, summary }, index) =>
            summary ? (
              <p className="game-summary" role="status" key={name}>
                <strong>
                  {summaries.length > 1 ? `Question ${index + 1}: ` : ''}
                  {summary.title}
                </strong>
                {summary.detail && <span>{summary.detail}</span>}
              </p>
            ) : null,
          )}
          <p className="helper">
            {draft.options?.[1] === 'Compact'
              ? 'Showing answers only.'
              : 'Showing the complete response, including metrics.'}{' '}
            This changes the display, not the decision.
          </p>
          <pre className="game-result" tabIndex={0} aria-label="Decision result">
            {JSON.stringify(shown, null, 2)}
          </pre>
          <div className="game-decision-actions">
            <button className="outline-button" onClick={copy}>
              <Copy size={15} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy displayed result'}
            </button>
            <button
              className="outline-button"
              disabled={!project || saving}
              aria-describedby={!project ? saveHintId : undefined}
              onClick={saveDecision}
            >
              <Save size={15} aria-hidden="true" />
              {saving ? 'Saving…' : 'Save JSON to project'}
            </button>
          </div>
          {!project && (
            <p id={saveHintId} className="helper">
              Choose a project above to save this result as JSON.
            </p>
          )}
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
