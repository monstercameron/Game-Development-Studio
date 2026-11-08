import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import './ai-assist-settings.css';

const PROVIDER_LABELS = { openai: 'OpenAI (cloud)', local: 'Local (Qwen engine)' };
const FEATURE_NOTES = {
  'error-fix': 'Used by “Suggest a fix with GPT” in the Errors review. It supports OpenAI only.',
  'vegetation-describe': 'Used by “Describe it” on the Vegetation page.',
  'ui-translate':
    'Used by “Translate this page with ChatGPT…” in the language menu. It supports OpenAI only; the local provider is not supported for this feature.',
};

async function verifyTranslationModel(model) {
  const response = await fetch('/api/i18n/verify-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'i18n' },
    body: JSON.stringify({ model }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(data.error || 'The model could not be checked.');
  }
  return data;
}

async function request(method, body) {
  const response = await fetch('/api/ai-assist/settings', {
    method,
    headers:
      method === 'POST'
        ? { 'Content-Type': 'application/json', 'X-Forge-Request': 'ai-assist' }
        : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(data.error || 'AI assist settings are unavailable.');
  }
  return data;
}

/** Settings section listing the provider and model id each optional AI feature uses. */
export default function AiAssistSettings() {
  const [features, setFeatures] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    request('GET')
      .then((data) => {
        if (alive) {
          setFeatures(data.features);
          setDrafts(Object.fromEntries(data.features.map((item) => [item.feature, item])));
        }
      })
      .catch((reason) => {
        if (alive) {
          setError(reason.message);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // Only interface translation has a check here; error fix checks its model in the Errors review.
  async function checkModel(feature) {
    setBusy(feature);
    setError('');
    setMessage('');
    try {
      const result = await verifyTranslationModel(drafts[feature].model.trim());
      setMessage(result.message);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  }

  async function save(feature) {
    setBusy(feature);
    setError('');
    setMessage('');
    try {
      const { provider, model } = drafts[feature];
      const data = await request('POST', { feature, provider, model });
      setFeatures((current) =>
        current.map((item) => (item.feature === feature ? data.feature : item)),
      );
      setDrafts((current) => ({ ...current, [feature]: data.feature }));
      setMessage(`${data.feature.label} will use ${data.feature.model}.`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="settings-section ai-assist-settings">
      <div className="settings-title">
        <div className="settings-symbol">
          <Sparkles size={18} />
        </div>
        <div>
          <strong>AI assist</strong>
          <p>
            Optional AI features and the model each one uses. Nothing is sent until you ask. The
            OpenAI key is saved under API keys.
          </p>
        </div>
      </div>
      {!features && !error && <p className="settings-hint">Loading…</p>}
      {features?.map((item) => {
        const draft = drafts[item.feature] || item;
        const changed = draft.provider !== item.provider || draft.model !== item.model;
        return (
          <form
            key={item.feature}
            className="ai-assist-row"
            onSubmit={(event) => {
              event.preventDefault();
              save(item.feature);
            }}
          >
            <strong>{item.label}</strong>
            <p className="settings-hint">{FEATURE_NOTES[item.feature]}</p>
            <label htmlFor={`ai-provider-${item.feature}`}>Provider</label>
            <select
              id={`ai-provider-${item.feature}`}
              value={draft.provider}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [item.feature]: { ...draft, provider: event.target.value },
                }))
              }
            >
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label htmlFor={`ai-model-${item.feature}`}>Model id</label>
            <input
              id={`ai-model-${item.feature}`}
              value={draft.model}
              maxLength={80}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [item.feature]: { ...draft, model: event.target.value },
                }))
              }
            />
            <p className="settings-hint">
              Default {PROVIDER_LABELS[item.defaultProvider]} · {item.defaultModel}
            </p>
            <button
              type="submit"
              className="outline-button"
              aria-label={`Save AI assist model for ${item.label}`}
              disabled={!!busy || !changed || !draft.model.trim()}
            >
              {busy === item.feature ? 'Saving…' : 'Save'}
            </button>
            {item.feature === 'ui-translate' && (
              <button
                type="button"
                className="ghost-button"
                aria-label={`Check that OpenAI offers the model for ${item.label}`}
                disabled={!!busy || !draft.model.trim()}
                onClick={() => checkModel(item.feature)}
              >
                Check model
              </button>
            )}
          </form>
        );
      })}
      {message && (
        <p className="credential-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
