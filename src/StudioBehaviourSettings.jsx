import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { createLog } from './app-log.js';
import { t, useT } from './i18n/index.js';
import './studio-behaviour-settings.css';

const log = createLog('settings');

// Settings and groups come from the studio's typed registry (runtime/core-settings.js), the same
// list the MCP tools use. Labels and descriptions are English text from the server; the controls
// and messages around them go through the interface language layer.
const EFFECT_LABELS = {
  get live() {
    return t('settings.studioBehaviour.effectLive', 'Applies now');
  },
  get 'next-job'() {
    return t('settings.studioBehaviour.effectNextJob', 'Next render');
  },
  get 'restart-required'() {
    return t('settings.studioBehaviour.effectRestart', 'Restart needed');
  },
};
const SOURCE_LABELS = {
  get default() {
    return t('settings.studioBehaviour.sourceDefault', 'Using the default');
  },
  get override() {
    return t('settings.studioBehaviour.sourceOverride', 'Changed by you');
  },
  get environment() {
    return t('settings.studioBehaviour.sourceEnvironment', 'Set by the environment');
  },
  get store() {
    return t('settings.studioBehaviour.sourceStore', 'Saved');
  },
};
const GROUP_LABELS = {
  get engines() {
    return t('settings.studioBehaviour.groupEngines', 'Engines');
  },
  get memory() {
    return t('settings.studioBehaviour.groupMemory', 'Memory');
  },
  get queue() {
    return t('settings.studioBehaviour.groupQueue', 'Render queue');
  },
  get speech() {
    return t('settings.studioBehaviour.groupSpeech', 'Speech');
  },
  get ai() {
    return t('settings.studioBehaviour.groupAi', 'AI assist');
  },
  get interface() {
    return t('settings.studioBehaviour.groupInterface', 'Interface');
  },
  get app() {
    return t('settings.studioBehaviour.groupApp', 'Studio app');
  },
};

// Throws an Error whose `problems` array carries per-key validation failures from the server.
async function request(path, { method = 'GET', body } = {}) {
  // log-coverage: ignore -- failed /api calls are already logged by app-log-install (http.request.failed)
  const response = await fetch(path, {
    method,
    headers:
      method === 'GET'
        ? undefined
        : { 'Content-Type': 'application/json', 'X-Forge-Request': 'settings' },
    body: body ? JSON.stringify({ ...body, via: 'ui' }) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = Error(
      data.error || t('settings.studioBehaviour.unavailable', 'Settings are unavailable.'),
    );
    failure.problems = data.problems || [];
    throw failure;
  }
  return data;
}

function showValue(item, value) {
  if (value === null || value === undefined || value === '') {
    return t('settings.studioBehaviour.valueNone', 'None');
  }
  if (typeof value === 'boolean') {
    return value
      ? t('settings.studioBehaviour.valueOn', 'On')
      : t('settings.studioBehaviour.valueOff', 'Off');
  }
  return item.unit ? `${value} ${item.unit}` : String(value);
}

// Returns { value } for an acceptable draft, or { message } with the problem to show beside the field.
function checkDraft(item, text) {
  if (item.type === 'integer') {
    const number = Number(text);
    if (text.trim() === '' || !Number.isInteger(number) || number < item.min || number > item.max) {
      return {
        message: t(
          'settings.studioBehaviour.rangeError',
          'Enter a whole number from {min} to {max}.',
          { min: item.min, max: item.max },
        ),
      };
    }
    return { value: number };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return item.nullable
      ? { value: null }
      : { message: t('settings.studioBehaviour.requiredError', 'Enter a value.') };
  }
  if (trimmed.length > item.maxLength) {
    return {
      message: t('settings.studioBehaviour.lengthError', 'Use at most {max} characters.', {
        max: item.maxLength,
      }),
    };
  }
  return { value: trimmed };
}

function SettingRow({ item, error, onApply, onReset }) {
  const { t } = useT();
  const id = useId();
  const hintId = `${id}-hint`;
  const stateId = `${id}-state`;
  const errorId = `${id}-error`;
  const [edited, setEdited] = useState(null);
  const [localError, setLocalError] = useState('');
  const [isResetArmed, setIsResetArmed] = useState(false);
  const resetButton = useRef(null);
  const control = useRef(null);
  const canEdit = item.mutable && item.available && !item.locked;
  const draft = edited ?? String(item.value ?? '');
  const shownError = localError || error;
  const describedBy = [hintId, stateId, shownError ? errorId : ''].filter(Boolean).join(' ');

  const stateParts = [];
  if (item.locked) {
    stateParts.push(
      t(
        'settings.studioBehaviour.lockedBy',
        'Locked by the environment variable {variable}. Change it there and restart the studio to unlock.',
        { variable: item.lockedBy },
      ),
      t('settings.studioBehaviour.lockedValue', 'Current value: {value}', {
        value: showValue(item, item.value),
      }),
    );
  } else {
    stateParts.push(
      SOURCE_LABELS[item.source] ?? item.source,
      t('settings.studioBehaviour.defaultValue', 'Default: {value}', {
        value: showValue(item, item.default),
      }),
    );
    if (!item.mutable) {
      stateParts.push(t('settings.studioBehaviour.readOnly', 'Read-only'));
    } else if (!item.available) {
      stateParts.push(t('settings.studioBehaviour.notAvailable', 'Not available in this process'));
    }
  }

  function commitDraft(event) {
    event.preventDefault();
    const checked = checkDraft(item, draft);
    if (checked.message) {
      setLocalError(checked.message);
      return;
    }
    setLocalError('');
    onApply(item.key, checked.value)
      .then((saved) => {
        if (saved) {
          setEdited(null);
        }
      })
      .catch((reason) => {
        log.warn('settings.value.apply.failed', { settingKey: item.key, errorClass: reason?.name });
      });
  }

  function closeReset() {
    log.debug('settings.value.reset.cancelled', { settingKey: item.key });
    setIsResetArmed(false);
    setTimeout(() => resetButton.current?.focus(), 0);
  }

  let field;
  if (item.type === 'boolean') {
    field = (
      <label className="behaviour-switch" htmlFor={`${id}-control`}>
        <input
          ref={control}
          id={`${id}-control`}
          type="checkbox"
          role="switch"
          checked={item.value === true}
          disabled={!canEdit}
          aria-describedby={describedBy}
          aria-invalid={shownError ? true : undefined}
          onChange={(event) => onApply(item.key, event.target.checked)}
        />
        <span>{item.label}</span>
      </label>
    );
  } else if (item.type === 'enum') {
    field = (
      <>
        <label htmlFor={`${id}-control`}>{item.label}</label>
        <select
          ref={control}
          id={`${id}-control`}
          value={String(item.value)}
          disabled={!canEdit}
          aria-describedby={describedBy}
          aria-invalid={shownError ? true : undefined}
          onChange={(event) =>
            onApply(
              item.key,
              item.values.find((value) => String(value) === event.target.value),
            )
          }
        >
          {item.values.map((value) => (
            <option key={String(value)} value={String(value)}>
              {showValue(item, value)}
            </option>
          ))}
        </select>
      </>
    );
  } else {
    field = (
      <form className="behaviour-draft" onSubmit={commitDraft} noValidate>
        <label htmlFor={`${id}-control`}>{item.label}</label>
        <div className="behaviour-draft-line">
          <input
            ref={control}
            id={`${id}-control`}
            type={item.type === 'integer' ? 'number' : 'text'}
            inputMode={item.type === 'integer' ? 'numeric' : undefined}
            min={item.type === 'integer' ? item.min : undefined}
            max={item.type === 'integer' ? item.max : undefined}
            step={item.type === 'integer' ? 1 : undefined}
            maxLength={item.type === 'string' ? item.maxLength : undefined}
            dir={item.type === 'string' ? 'ltr' : undefined}
            value={draft}
            disabled={!canEdit}
            aria-describedby={describedBy}
            aria-invalid={shownError ? true : undefined}
            onChange={(event) => {
              setEdited(event.target.value);
              setLocalError('');
            }}
          />
          {item.unit && <span className="behaviour-unit">{item.unit}</span>}
          <button
            type="submit"
            className="outline-button"
            aria-label={t('settings.studioBehaviour.saveLabel', 'Save {label}', {
              label: item.label,
            })}
            disabled={!canEdit || edited === null || edited === String(item.value ?? '')}
          >
            {t('common.action.save', 'Save')}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="behaviour-row" data-setting={item.key}>
      <div className="behaviour-main">
        {field}
        <span className="behaviour-badge" data-effect={item.effect}>
          {EFFECT_LABELS[item.effect] ?? item.effect}
        </span>
      </div>
      <p id={hintId} className="settings-hint behaviour-hint">
        {item.description}
      </p>
      <p id={stateId} className="settings-hint behaviour-state">
        {stateParts.join(' · ')}
      </p>
      {shownError && (
        <p id={errorId} className="settings-error behaviour-error" role="alert">
          {shownError}
        </p>
      )}
      <div className="behaviour-actions">
        {isResetArmed ? (
          <span
            className="reset-confirm"
            role="group"
            aria-label={t('settings.studioBehaviour.confirmReset', 'Confirm reset')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeReset();
              }
            }}
          >
            <span>
              {t('settings.studioBehaviour.resetQuestion', 'Reset {label}?', {
                label: item.label,
              })}
            </span>
            <button
              type="button"
              className="text-action danger"
              autoFocus
              onClick={() => {
                log.info('settings.value.reset.confirmed', { settingKey: item.key });
                setIsResetArmed(false);
                setEdited(null);
                setLocalError('');
                onReset(item.key)
                  .then(() => control.current?.focus())
                  .catch((reason) => {
                    log.warn('settings.value.reset.failed', {
                      settingKey: item.key,
                      errorClass: reason?.name,
                    });
                  });
              }}
            >
              {t('settings.studioBehaviour.yesReset', 'Yes, reset')}
            </button>
            <button type="button" className="text-action" onClick={closeReset}>
              {t('common.action.cancel', 'Cancel')}
            </button>
          </span>
        ) : (
          <button
            ref={resetButton}
            type="button"
            className="text-action behaviour-reset"
            aria-label={t('settings.studioBehaviour.resetLabel', 'Reset {label} to its default', {
              label: item.label,
            })}
            disabled={!canEdit || item.isDefault}
            title={
              item.isDefault
                ? t('settings.studioBehaviour.resetNothing', 'Already using the default')
                : undefined
            }
            onClick={() => setIsResetArmed(true)}
          >
            {t('settings.studioBehaviour.resetButton', 'Reset to default')}
          </button>
        )}
      </div>
    </div>
  );
}

function RecentChanges({ changes, items }) {
  const { t, formatDate } = useT();
  const labels = new Map(items.map((item) => [item.key, item.label]));
  return (
    <details className="behaviour-recent">
      <summary>{t('settings.studioBehaviour.recentTitle', 'Recent changes')}</summary>
      {changes.length === 0 ? (
        <p className="settings-hint">
          {t('settings.studioBehaviour.recentEmpty', 'No changes yet.')}
        </p>
      ) : (
        <ul>
          {changes.map((change) => (
            <li key={`${change.at}-${change.key}-${change.via}`}>
              <strong>{labels.get(change.key) ?? change.key}</strong>
              {': '}
              {`${String(change.old ?? '')} → ${String(change.new ?? '')} (${
                change.via === 'mcp'
                  ? t('settings.studioBehaviour.viaMcp', 'MCP')
                  : t('settings.studioBehaviour.viaStudio', 'Studio')
              }, ${formatDate(change.at, { dateStyle: 'short', timeStyle: 'short' })})`}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** Settings section for engine, memory, queue and app behaviour toggles. */
export default function StudioBehaviourSettings() {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [rowErrors, setRowErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const latest = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const snapshot = await request('/api/settings');
      if (ticket === latest.current) {
        setData(snapshot);
        setLoadError('');
      }
    } catch (reason) {
      log.warn('settings.list.failed', { errorClass: reason?.name });
      if (ticket === latest.current) {
        setLoadError(reason.message);
      }
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  function describeResult(item, result) {
    if (!result.changed) {
      return t('settings.studioBehaviour.noChange', '{label} already had that value.', {
        label: item.label,
      });
    }
    if (result.restartRequired) {
      return t(
        'settings.studioBehaviour.savedRestart',
        'Saved {label}. Restart needed to apply it.',
        {
          label: item.label,
        },
      );
    }
    if (result.effect === 'next-job') {
      return t(
        'settings.studioBehaviour.savedNext',
        'Saved {label}. It applies to the next render.',
        {
          label: item.label,
        },
      );
    }
    return t('settings.studioBehaviour.savedLive', 'Saved {label}. It applies now.', {
      label: item.label,
    });
  }

  // Runs one request and shows its outcome. Resolves true when the server accepted it.
  async function send(key, path, body) {
    if (inFlight.current) {
      return false;
    }
    inFlight.current = true;
    const isReset = path === '/api/settings/reset';
    log.info(isReset ? 'settings.value.reset.requested' : 'settings.value.change.requested', {
      settingKey: key,
    });
    const ticket = ++latest.current;
    setBusy(true);
    setMessage('');
    setRowErrors((current) => ({ ...current, [key]: '' }));
    try {
      const outcome = await request(path, { method: 'POST', body });
      if (ticket !== latest.current) {
        return true;
      }
      const item = data?.settings.find((entry) => entry.key === key);
      const result = outcome.results.find((entry) => entry.key === key);
      log.info(isReset ? 'settings.value.reset.completed' : 'settings.value.change.completed', {
        settingKey: key,
        isChanged: result?.changed === true,
      });
      setData({
        groups: outcome.groups,
        settings: outcome.settings,
        recentChanges: outcome.recentChanges,
      });
      if (item && result) {
        setMessage(describeResult(item, result));
      }
      return true;
    } catch (reason) {
      log.warn(isReset ? 'settings.value.reset.failed' : 'settings.value.change.failed', {
        settingKey: key,
        errorClass: reason?.name,
      });
      if (ticket === latest.current) {
        const problem = reason.problems?.find((entry) => entry.key === key);
        setRowErrors((current) => ({ ...current, [key]: problem?.message || reason.message }));
      }
      return false;
    } finally {
      inFlight.current = false;
      if (ticket === latest.current) {
        setBusy(false);
      }
    }
  }

  const apply = (key, value) => send(key, '/api/settings', { changes: [{ key, value }] });
  const reset = (key) => send(key, '/api/settings/reset', { key });

  const groups = data?.groups ?? [];
  return (
    <div className="settings-section studio-behaviour" aria-busy={busy}>
      <div className="settings-title">
        <div className="settings-symbol">
          <SlidersHorizontal size={18} />
        </div>
        <div>
          <strong>{t('settings.studioBehaviour.title', 'Studio behaviour')}</strong>
          <p>
            {t(
              'settings.studioBehaviour.intro',
              'Switches for how the queue starts engines, checks memory and more. Agents can read and change the same list through MCP. The badge shows when a change applies.',
            )}
          </p>
        </div>
      </div>
      {!data && !loadError && (
        <p className="settings-hint" role="status">
          {t('settings.studioBehaviour.loading', 'Loading…')}
        </p>
      )}
      {loadError && (
        <div className="behaviour-load-error">
          <p className="settings-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="outline-button" onClick={load}>
            {t('common.action.retry', 'Retry')}
          </button>
        </div>
      )}
      {groups.map((group) => {
        const items = data.settings.filter((item) => item.group === group.id);
        if (!items.length) {
          return null;
        }
        return (
          <details key={group.id} className="behaviour-group" open={group.id === 'engines'}>
            <summary>
              <span>{GROUP_LABELS[group.id] ?? group.label}</span>
              <span className="behaviour-count">{items.length}</span>
            </summary>
            <div className="behaviour-list">
              {items.map((item) => (
                <SettingRow
                  key={item.key}
                  item={item}
                  error={rowErrors[item.key] || ''}
                  onApply={apply}
                  onReset={reset}
                />
              ))}
            </div>
          </details>
        );
      })}
      {data && <RecentChanges changes={data.recentChanges} items={data.settings} />}
      <p className="credential-message" role="status">
        {message}
      </p>
    </div>
  );
}
