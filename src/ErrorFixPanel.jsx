import { useEffect, useRef, useState } from 'react';
import { KeyRound, Sparkles } from 'lucide-react';
import { createLog } from './app-log.js';
import ChatMarkdown from './ChatMarkdown';
import { copyToClipboard } from './error-copy.js';
import { getErrors, postErrors } from './errors-api.js';

const log = createLog('errors');
// Provider word for GPT suggestion events. The request body and the suggestion are never logged.
const SUGGESTION_PROVIDER = 'openai';

// Whole milliseconds since startedAt, for log durations.
function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

/**
 * Optional "Suggest a fix with GPT". Nothing is sent until the user reviews the exact request
 * and presses Send; the key stays on the studio server.
 */
export default function ErrorFixPanel({ error, onUpdated, onOpenSettings, onStatus }) {
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [modelCheck, setModelCheck] = useState(null);
  const [isCheckingModel, setIsCheckingModel] = useState(false);
  const [preview, setPreview] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [failure, setFailure] = useState('');
  const sendController = useRef(null);
  const sendButton = useRef(null);

  useEffect(() => {
    let alive = true;
    getErrors('/settings')
      .then((data) => {
        if (alive) {
          setSettings(data);
          setModelDraft(data.model);
        }
      })
      .catch((reason) => {
        log.warn('errors.settings.load.failed', { errorClass: reason?.name });
        if (alive) {
          setSettingsError(reason.message);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setPreview(null);
    setPhase('idle');
    setFailure('');
    return () => sendController.current?.abort();
  }, [error.id]);

  useEffect(() => {
    if (phase === 'preview') {
      sendButton.current?.focus();
    }
  }, [phase]);

  async function saveModel() {
    setModelCheck(null);
    try {
      const data = await postErrors('/settings', { model: modelDraft.trim() });
      setSettings((current) => ({ ...current, model: data.model }));
      setPreview(null);
      setPhase('idle');
      onStatus(`Model set to ${data.model}.`);
    } catch (reason) {
      log.warn('errors.model.save.failed', { errorClass: reason?.name, errorCode: reason?.code });
      setModelCheck({ exists: false, message: reason.message, models: [] });
    }
  }

  async function checkModel() {
    setIsCheckingModel(true);
    setModelCheck(null);
    try {
      setModelCheck(await postErrors('/settings/verify-model', { model: modelDraft.trim() }));
    } catch (reason) {
      log.warn('errors.model.check.failed', { errorClass: reason?.name, errorCode: reason?.code });
      setModelCheck({ exists: false, message: reason.message, models: [] });
    } finally {
      setIsCheckingModel(false);
    }
  }

  async function showPreview() {
    setFailure('');
    setPhase('loading-preview');
    try {
      const data = await postErrors(`/${error.id}/fix-preview`);
      setPreview(data);
      setSettings((current) => (current ? { ...current, hasKey: data.hasKey } : current));
      setPhase('preview');
    } catch (reason) {
      log.warn('errors.suggestion.preview.failed', {
        errorId: error.id,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      setFailure(reason.message);
      setPhase('idle');
    }
  }

  async function send() {
    sendController.current = new AbortController();
    const startedAt = performance.now();
    log.info('errors.suggestion.requested', { errorId: error.id, provider: SUGGESTION_PROVIDER });
    setPhase('sending');
    setFailure('');
    try {
      const data = await postErrors(
        `/${error.id}/suggest-fix`,
        { digest: preview.digest },
        { signal: sendController.current.signal },
      );
      onUpdated(data.error);
      setPhase('idle');
      setPreview(null);
      onStatus('AI suggestion received. Review it before using it.');
      log.info('errors.suggestion.completed', {
        errorId: error.id,
        provider: SUGGESTION_PROVIDER,
        outcome: 'completed',
        durationMs: elapsedMs(startedAt),
      });
    } catch (reason) {
      if (reason.name === 'AbortError') {
        log.info('errors.suggestion.cancelled', {
          errorId: error.id,
          provider: SUGGESTION_PROVIDER,
          outcome: 'cancelled',
          durationMs: elapsedMs(startedAt),
        });
        setFailure('Cancelled. The request was stopped; OpenAI may still have received it.');
      } else {
        log.warn('errors.suggestion.failed', {
          errorId: error.id,
          provider: SUGGESTION_PROVIDER,
          outcome: 'failed',
          durationMs: elapsedMs(startedAt),
          errorClass: reason?.name,
          errorCode: reason?.code,
        });
        setFailure(reason.message);
        if (reason.code === 'no_key') {
          setSettings((current) => (current ? { ...current, hasKey: false } : current));
        }
      }
      setPhase('preview');
    }
  }

  function cancelPreview() {
    setPreview(null);
    setPhase('idle');
  }

  const hasKey = settings?.hasKey;
  const busy = phase === 'loading-preview' || phase === 'sending';
  return (
    <section className="errors-panel" aria-labelledby={`fix-heading-${error.id}`}>
      <h4 id={`fix-heading-${error.id}`}>
        <Sparkles size={15} aria-hidden="true" /> Suggest a fix with GPT (optional)
      </h4>
      <p className="errors-hint">
        Nothing is sent automatically. You see the exact request first and choose Send or Cancel.
      </p>
      {settingsError && (
        <p className="settings-error" role="alert">
          {settingsError}
        </p>
      )}
      {settings && !hasKey && (
        <p className="errors-key-missing">
          <KeyRound size={14} aria-hidden="true" /> No OpenAI key is saved.{' '}
          <button type="button" className="errors-link-button" onClick={onOpenSettings}>
            Add your OpenAI key in Settings
          </button>
        </p>
      )}
      {settings && (
        <details className="errors-model">
          <summary>Model: {settings.model}</summary>
          <form
            className="errors-model-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveModel();
            }}
          >
            <label htmlFor={`fix-model-${error.id}`}>OpenAI model id</label>
            <input
              id={`fix-model-${error.id}`}
              value={modelDraft}
              maxLength={100}
              list={modelCheck?.models?.length ? `fix-models-${error.id}` : undefined}
              onChange={(event) => setModelDraft(event.target.value)}
              aria-describedby={`fix-model-help-${error.id}`}
            />
            {modelCheck?.models?.length > 0 && (
              <datalist id={`fix-models-${error.id}`}>
                {modelCheck.models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            )}
            <p id={`fix-model-help-${error.id}`} className="errors-hint">
              Default {settings.defaultModel}. Check asks OpenAI whether this key can use the id.
            </p>
            <div className="errors-actions">
              <button type="submit" className="outline-button" disabled={!modelDraft.trim()}>
                Save model
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={!modelDraft.trim() || isCheckingModel}
                onClick={checkModel}
              >
                {isCheckingModel ? 'Checking…' : 'Check model'}
              </button>
            </div>
            {modelCheck && (
              <p
                className={modelCheck.exists ? 'errors-ok' : 'settings-error'}
                role={modelCheck.exists ? 'status' : 'alert'}
              >
                {modelCheck.exists === true
                  ? 'Available: '
                  : modelCheck.exists === false
                    ? 'Not available: '
                    : ''}
                {modelCheck.message}
                {modelCheck.models?.length > 0 &&
                  ` Pick another id from the ${modelCheck.models.length} suggestions in the field.`}
                {modelCheck.code === 'no_key' && (
                  <>
                    {' '}
                    <button type="button" className="errors-link-button" onClick={onOpenSettings}>
                      Open Settings
                    </button>
                  </>
                )}
              </p>
            )}
          </form>
        </details>
      )}
      {phase !== 'preview' && phase !== 'sending' && (
        <button
          type="button"
          className="outline-button"
          disabled={!settings || busy}
          onClick={showPreview}
        >
          {phase === 'loading-preview' ? 'Preparing preview…' : 'Suggest a fix with GPT'}
        </button>
      )}
      {preview && (phase === 'preview' || phase === 'sending') && (
        <div className="errors-preview" role="region" aria-label="What will be sent to OpenAI">
          <h5>What will be sent</h5>
          <p className="errors-notice">{preview.notice}</p>
          <p className="errors-hint">
            Model {preview.body.model}. Source lines:{' '}
            {preview.sourceFiles.length
              ? preview.sourceFiles
                  .map((file) => `${file.path} ${file.startLine}-${file.endLine}`)
                  .join(', ')
              : 'none (no repository frames in the stack)'}
            .
          </p>
          <pre className="errors-code" tabIndex={0} aria-label="Exact request body">
            {JSON.stringify(preview.body, null, 2)}
          </pre>
          <div className="errors-actions">
            {phase === 'sending' ? (
              <>
                <span role="status">Waiting for OpenAI…</span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => sendController.current?.abort()}
                >
                  Cancel request
                </button>
              </>
            ) : (
              <>
                <button
                  ref={sendButton}
                  type="button"
                  className="outline-button"
                  disabled={!hasKey}
                  onClick={send}
                >
                  Send to OpenAI
                </button>
                <button type="button" className="ghost-button" onClick={cancelPreview}>
                  Cancel
                </button>
                {!hasKey && (
                  <button type="button" className="errors-link-button" onClick={onOpenSettings}>
                    Add your OpenAI key in Settings
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {failure && (
        <p className="settings-error" role="alert">
          {failure}
        </p>
      )}
      {error.suggestion && (
        <div className="errors-suggestion">
          <h5>AI suggestion: review before using</h5>
          <p className="errors-hint">
            Generated by {error.suggestionModel || 'an OpenAI model'} at{' '}
            {error.suggestionAt || 'an unknown time'}. It can be wrong; Forge never applies it.
          </p>
          <ChatMarkdown content={error.suggestion} />
          <div className="errors-actions">
            <button
              type="button"
              className="ghost-button"
              onClick={async () =>
                onStatus(
                  await copyToClipboard(error.suggestion, 'AI suggestion', { includePaths: false }),
                )
              }
            >
              Copy suggestion
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
