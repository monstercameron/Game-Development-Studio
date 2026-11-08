import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Clock3,
  Dices,
  Download,
  KeyRound,
  Plus,
  Power,
  RotateCcw,
  Sparkles,
  Trees,
} from 'lucide-react';
import PreviewArea from './PreviewArea';
import RuntimeQueue, { post } from './RuntimeQueue';
import { CreationQueueTiming } from './QueueTiming';
import { formatDuration } from './queue-timing';
import { reusePlan } from './generation-details';
import { routeDetails, updateSearch, useRouteToggle } from './useNav';
import {
  BUDGET_NAMES,
  budgetCount,
  buildRequests,
  firstProblem,
  formatCount,
  isDefaultState,
  randomSeed,
  searchFromState,
  stateFromReuse,
  stateFromSearch,
  takeReuse,
} from './vegetation-settings';
import {
  VEGETATION_BUDGETS,
  checkControlValue,
  findSpecies,
} from '../runtime/vegetation-request.js';
import { createLog } from './app-log.js';
import './vegetation-studio.css';

const GROUP_TITLES = { shape: 'Shape', leaves: 'Leaves', advanced: 'Advanced branch controls' };
const NO_NOTICE = { text: '', kind: 'error' };
const log = createLog('vegetation');

async function api(path, options) {
  // log-coverage: ignore -- /api requests are logged by the browser capture (http.request.failed).
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Error(data.error || data.message || 'Request failed.');
    error.status = response.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }
  return data;
}

const writeOptions = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'vegetation' },
  body: JSON.stringify(body),
});

// "None" is not a number, so a typed value that is not valid yet is kept as text.
function ControlRow({ control, value, typedText, onValue, onTyped }) {
  const id = `vegetation-control-${control.id}`;
  const hint =
    control.type === 'choice' || control.type === 'boolean'
      ? `Default ${
          control.type === 'boolean'
            ? control.default
              ? 'on'
              : 'off'
            : control.options.find((option) => option.value === control.default)?.label
        }`
      : `${control.min} to ${control.max} · default ${control.default}`;
  const invalid = typedText !== undefined;
  const hintId = `${id}-hint`;
  if (control.type === 'boolean') {
    return (
      <div className="vegetation-control">
        <label className="vegetation-check" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value}
            aria-describedby={hintId}
            onChange={(event) => onValue(control, event.target.checked)}
          />
          {control.name}
        </label>
        <small id={hintId}>{hint}</small>
      </div>
    );
  }
  if (control.type === 'choice') {
    return (
      <div className="vegetation-control">
        <label htmlFor={id}>{control.name}</label>
        <select
          id={id}
          value={String(value)}
          aria-describedby={hintId}
          onChange={(event) => {
            const option = control.options.find(
              (item) => String(item.value) === event.target.value,
            );
            onValue(control, option.value);
          }}
        >
          {control.options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
        <small id={hintId}>{hint}</small>
      </div>
    );
  }
  return (
    <div className="vegetation-control">
      <label htmlFor={id}>{control.name}</label>
      <div className="vegetation-number">
        <input
          type="range"
          aria-label={`${control.name} slider`}
          min={control.min}
          max={control.max}
          step={control.step}
          value={value}
          onChange={(event) => onValue(control, Number(event.target.value))}
        />
        <input
          id={id}
          type="number"
          inputMode={control.type === 'integer' ? 'numeric' : 'decimal'}
          min={control.min}
          max={control.max}
          step={control.step}
          value={invalid ? typedText : value}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={invalid ? `${hintId} ${id}-error` : hintId}
          onChange={(event) => onTyped(control, event.target.value)}
        />
      </div>
      <small id={hintId}>{hint}</small>
      {invalid && (
        <small className="vegetation-field-error" id={`${id}-error`}>
          Enter a {control.type === 'integer' ? 'whole ' : ''}number from {control.min} to{' '}
          {control.max}.
        </small>
      )}
    </div>
  );
}

function CheckoutPanel({ status, onFetch, busy }) {
  const checkout = status.checkout;
  const running = status.fetch.running;
  const label =
    checkout.action === 'update'
      ? 'Update SeedThree'
      : checkout.action === 'install'
        ? 'Install SeedThree dependencies'
        : 'Fetch SeedThree';
  return (
    <section className="panel vegetation-panel" aria-labelledby="vegetation-fetch-title">
      <div className="panel-heading">
        <div>
          <h2 id="vegetation-fetch-title">SeedThree is not ready</h2>
          <p className="helper">{checkout.message}</p>
        </div>
      </div>
      <p className="helper">
        Vegetation is made by <strong>SeedThree</strong>, an open-source ({checkout.license}) plant
        generator that stays a separate project. Forge does not download it by itself.
        {checkout.action === 'update'
          ? ' Updating checks out the version Forge is tested with.'
          : ` Fetching downloads about 1 MiB of source from ${checkout.repository.replace(/\.git$/, '')} at one pinned commit and installs its two dependencies with npm ci --ignore-scripts inside ${checkout.location}. No model and no GPU are involved.`}
      </p>
      <div className="vegetation-fetch-actions">
        <button className="primary" type="button" disabled={running || busy} onClick={onFetch}>
          <Download size={16} aria-hidden="true" /> {running ? 'Working…' : label}
        </button>
        {running && (
          <span role="status" className="vegetation-fetch-step">
            {status.fetch.step}…
          </span>
        )}
      </div>
      {status.fetch.error && (
        <p className="vegetation-notice error" role="alert">
          {status.fetch.error}
        </p>
      )}
      <p className="helper">
        Or run <code>powershell -File .\install.ps1 -Vegetation</code> in the Forge folder. Pinned
        commit <code>{checkout.expectedCommit.slice(0, 10)}</code>.
      </p>
    </section>
  );
}

function DescribePanel({ status, species, speciesName, onApplied, onOpenSettings, refreshStatus }) {
  const [text, setText] = useState('');
  const [letChoose, setLetChoose] = useState(false);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [check, setCheck] = useState(null);
  const describe = status.describe;
  const needsKey = describe.state === 'needs_key';
  const localStopped = describe.provider === 'local' && describe.localChatRunning === false;
  const providerName = describe.provider === 'openai' ? 'OpenAI' : 'the local Qwen3.8 chat model';

  async function run(event) {
    event.preventDefault();
    if (!text.trim()) {
      setError('Describe the plant first.');
      return;
    }
    setBusy('describe');
    setError('');
    setResult(null);
    const stopDescribe = log.time('vegetation.describe.completed', { provider: describe.provider });
    log.info('vegetation.describe.requested', { provider: describe.provider });
    try {
      const data = await api(
        '/api/vegetation/describe',
        writeOptions({ description: text, species: letChoose ? null : species }),
      );
      setResult(data.suggestion);
      onApplied(data.suggestion);
      stopDescribe();
    } catch (reason) {
      log.warn('vegetation.describe.failed', { provider: describe.provider, error: reason });
      setError(reason.message);
      if (reason.code === 'chat_model_unavailable') {
        refreshStatus();
      }
    } finally {
      setBusy('');
    }
  }
  async function startChat() {
    setBusy('chat');
    setError('');
    try {
      const data = await api('/api/runtime/models/chat/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      setResult(null);
      setCheck({
        ok: true,
        text: data.message || 'The chat model is starting. This can take a minute.',
      });
      refreshStatus();
    } catch (reason) {
      log.warn('vegetation.chat.load.failed', { error: reason });
      setError(reason.message);
    } finally {
      setBusy('');
    }
  }
  async function checkModel() {
    setBusy('check');
    setCheck(null);
    try {
      const data = await api('/api/vegetation/describe/check', writeOptions({}));
      setCheck({
        ok: data.exists === true,
        text:
          data.exists === false && data.models?.length
            ? `${data.message} Models this key can use include: ${data.models.slice(0, 8).join(', ')}.`
            : data.message,
      });
    } catch (reason) {
      log.warn('vegetation.model.check.failed', {
        provider: describe.provider,
        error: reason,
      });
      setCheck({ ok: false, text: reason.message });
    } finally {
      setBusy('');
    }
  }
  return (
    // Not a <form>: it sits inside the page form, and nested forms are invalid HTML.
    <div className="vegetation-describe">
      <div className="vegetation-field">
        <label htmlFor="vegetation-description">Describe the plant</label>
        <textarea
          id="vegetation-description"
          value={text}
          maxLength={describe.maxChars}
          rows={3}
          placeholder="A tall, weathered pine with a thin crown and few low branches"
          onChange={(event) => setText(event.target.value)}
        />
        <small>
          {text.length} of {describe.maxChars} characters. Uses {providerName}
          {describe.provider === 'openai' ? ` · ${describe.model}` : ''}. Change this in Settings,
          AI assist.
        </small>
      </div>
      <label className="vegetation-check">
        <input
          type="checkbox"
          checked={letChoose}
          onChange={(event) => setLetChoose(event.target.checked)}
        />
        Let the model choose the species (otherwise {speciesName} is kept)
      </label>
      {needsKey && (
        <p className="vegetation-notice info" role="status">
          <KeyRound size={15} aria-hidden="true" /> Add your OpenAI key in Settings to use this, or
          switch Describe it to the local chat model.{' '}
          <button type="button" className="text-action" onClick={onOpenSettings}>
            Add your OpenAI key in Settings
          </button>
        </p>
      )}
      {localStopped && (
        <p className="vegetation-notice info" role="status">
          The local chat model is not running. Starting it uses GPU and system memory, and Forge
          checks that first.{' '}
          <button type="button" className="outline-button" disabled={!!busy} onClick={startChat}>
            <Power size={14} aria-hidden="true" />{' '}
            {busy === 'chat' ? 'Starting…' : 'Start chat model'}
          </button>
        </p>
      )}
      <div className="vegetation-describe-actions">
        <button
          type="button"
          className="outline-button"
          disabled={!!busy || needsKey || localStopped}
          onClick={run}
        >
          <Sparkles size={15} aria-hidden="true" />{' '}
          {busy === 'describe' ? 'Describing…' : 'Describe'}
        </button>
        {describe.provider === 'openai' && !needsKey && (
          <button type="button" className="text-action" disabled={!!busy} onClick={checkModel}>
            Check model id
          </button>
        )}
        <small id="vegetation-describe-notice">{describe.notice}</small>
      </div>
      {check && (
        <p className={`vegetation-notice ${check.ok ? 'success' : 'info'}`} role="status">
          {check.text}
        </p>
      )}
      {error && (
        <p className="vegetation-notice error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="vegetation-suggestion" role="status">
          <strong>Suggestion applied to the controls below. Nothing is queued yet.</strong>
          <span>
            {result.model} ({result.provider === 'openai' ? 'OpenAI' : 'local'}): species{' '}
            {speciesName}, {Object.keys(result.params).length} control
            {Object.keys(result.params).length === 1 ? '' : 's'} changed
            {result.seed ? `, seed ${result.seed}` : ''}.
          </span>
          {result.adjusted.length > 0 && (
            <span>Brought into range: {result.adjusted.join(', ')}.</span>
          )}
          {result.ignored.length > 0 && (
            <span>Ignored (not available for this species): {result.ignored.join(', ')}.</span>
          )}
        </div>
      )}
    </div>
  );
}

export default function Vegetation({ project, projects, onRefresh, onOpenLibrary, onNewProject }) {
  const [params, setParams] = useSearchParams();
  const [describeOpen, setDescribeOpen] = useRouteToggle('describe');
  const [tuneOpen, setTuneOpen] = useRouteToggle('tune');
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [fetchBusy, setFetchBusy] = useState(false);
  const [typed, setTyped] = useState({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(NO_NOTICE);
  const [attempted, setAttempted] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState(false);
  const [version, setVersion] = useState(0);
  const [resetArmed, setResetArmed] = useState(false);
  const wasFetching = useRef(false);
  const focusField = (id) => setTimeout(() => document.getElementById(id)?.focus(), 0);
  const setMessage = (text, kind = 'error') => setNotice(text ? { text, kind } : NO_NOTICE);

  const refreshStatus = useCallback(async () => {
    try {
      const data = await api('/api/vegetation/status');
      setStatus(data);
      setLoadError('');
      return data;
    } catch (reason) {
      log.debug('vegetation.status.failed', { error: reason });
      setLoadError(reason.message);
      return null;
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const ready = status?.checkout.state === 'ready';
  useEffect(() => {
    if (!ready || catalog) {
      return undefined;
    }
    let alive = true;
    api('/api/vegetation/schema')
      .then((data) => {
        if (alive) {
          setCatalog(data);
        }
      })
      .catch((reason) => {
        log.warn('vegetation.schema.load.failed', { error: reason });
        if (alive) {
          setLoadError(reason.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [ready, catalog]);

  // While a fetch runs, follow its progress; when it ends, read the new state once.
  const fetching = status?.fetch.running === true;
  useEffect(() => {
    if (!fetching) {
      if (wasFetching.current) {
        wasFetching.current = false;
        refreshStatus();
      }
      return undefined;
    }
    wasFetching.current = true;
    log.debug('vegetation.fetch.followed');
    const timer = setInterval(refreshStatus, 1000);
    return () => clearInterval(timer);
  }, [fetching, refreshStatus]);

  const schema = catalog?.schema || null;
  const measured = catalog?.measured || null;
  const state = useMemo(() => (schema ? stateFromSearch(params, schema) : null), [params, schema]);
  const speciesEntry = schema && state ? findSpecies(schema, state.species) : null;

  // Settings of a reused asset arrive once through session storage and move into the address bar.
  const reusedOnce = useRef(false);
  useEffect(() => {
    if (!schema || reusedOnce.current) {
      return;
    }
    reusedOnce.current = true;
    const reused = takeReuse();
    const next = reused && stateFromReuse(reused, schema);
    if (next) {
      updateSearch(setParams, searchFromState(next, schema), { replace: true });
      setMessage('Settings reused from the asset.', 'info');
    }
  }, [schema, setParams]);

  function commit(next, options = {}) {
    updateSearch(setParams, searchFromState(next, schema), options);
  }
  function chooseSpecies(key) {
    setTyped({});
    commit({ ...state, species: key, params: {} });
  }
  function setParam(control, value) {
    const checked = checkControlValue(control, value);
    if (checked.error) {
      return;
    }
    setTyped((current) => {
      const rest = { ...current };
      delete rest[control.id];
      return rest;
    });
    const next = { ...state.params };
    if (checked.value === control.default) {
      delete next[control.id];
    } else {
      next[control.id] = checked.value;
    }
    commit({ ...state, params: next }, { replace: true });
  }
  function typeParam(control, text) {
    const number = Number(text);
    const valid =
      text.trim() !== '' && Number.isFinite(number) && !checkControlValue(control, number).error;
    if (valid) {
      setParam(control, number);
    } else {
      setTyped((current) => ({ ...current, [control.id]: text }));
    }
  }
  function applySuggestion(suggestion) {
    setTyped({});
    const species = findSpecies(schema, suggestion.species);
    if (!species) {
      return;
    }
    commit(
      {
        ...state,
        species: species.key,
        seed: suggestion.seed ?? state.seed,
        params: suggestion.params,
      },
      {},
    );
    if (
      Object.keys(suggestion.params).some(
        (id) => species.controls.find((c) => c.id === id)?.group === 'advanced',
      )
    ) {
      setTuneOpen(true);
    }
  }

  const projectId = project?.id;
  const requests = useMemo(
    () => (state && schema && !firstProblem(state, schema) ? buildRequests(state) : null),
    [state, schema],
  );
  const estimateRequest = requests?.[0];
  const estimateKey = estimateRequest
    ? JSON.stringify({ ...estimateRequest, variation_group: null })
    : '';
  useEffect(() => {
    let active = true;
    setEstimate(null);
    setEstimateError(false);
    if (!projectId || !estimateRequest) {
      return undefined;
    }
    const timer = setTimeout(() => {
      post('/api/runtime/estimate', {
        type: 'vegetation',
        projectId,
        request: {
          ...estimateRequest,
          variation_group: undefined,
          variation_index: undefined,
          variation_count: undefined,
        },
      })
        .then((result) => active && setEstimate(result))
        .catch((error) => {
          log.debug('vegetation.estimate.failed', { error });
          if (active) {
            setEstimateError(true);
          }
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // The key stands for the request without its random group id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, estimateKey, version]);

  // Editing the design clears an old error or confirmation (opening a section does not).
  const designKey = state && schema ? JSON.stringify(searchFromState(state, schema)) : '';
  useEffect(() => {
    setNotice((current) => (current.kind === 'info' ? current : NO_NOTICE));
  }, [projectId, designKey]);

  async function enqueue(event) {
    event.preventDefault();
    if (!project) {
      setMessage('Choose or create a project first.');
      return;
    }
    setAttempted(true);
    const problem = firstProblem(state, schema, typed);
    if (problem) {
      setMessage(problem.message);
      const invalidControl = speciesEntry.controls.find(
        (control) => problem.id === `vegetation-control-${control.id}`,
      );
      if (invalidControl?.group === 'advanced') {
        setTuneOpen(true);
      }
      focusField(problem.id);
      return;
    }
    setBusy(true);
    setMessage('');
    let queued = 0;
    const speciesId = state.species;
    const variationCount = state.variations;
    const stopEnqueue = log.time('vegetation.enqueue.completed', { speciesId, variationCount });
    log.info('vegetation.enqueue.requested', { speciesId, variationCount });
    try {
      for (const request of buildRequests(state)) {
        await post('/api/runtime/jobs', { type: 'vegetation', projectId: project.id, request });
        queued += 1;
      }
      stopEnqueue({ queuedCount: queued });
      setVersion((v) => v + 1);
      setMessage(
        queued > 1
          ? `${queued} plants added to the render queue.`
          : 'Plant added to the render queue.',
        'success',
      );
    } catch (error) {
      log.warn('vegetation.enqueue.failed', {
        speciesId,
        variationCount,
        queuedCount: queued,
        error,
      });
      const total = state.variations;
      setMessage(
        `${queued ? `${queued} of ${total} queued before an error. ` : ''}${error.message}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function startFetch() {
    setFetchBusy(true);
    log.info('vegetation.fetch.requested');
    try {
      const data = await api('/api/vegetation/fetch', writeOptions({}));
      setStatus((current) => ({ ...current, fetch: data.fetch }));
    } catch (reason) {
      log.warn('vegetation.fetch.failed', { error: reason });
      setLoadError(reason.message);
    } finally {
      setFetchBusy(false);
    }
  }
  const openSettings = () => updateSearch(setParams, { dialog: 'settings' });

  const isDirty =
    schema && state ? !isDefaultState(state, schema) || Object.keys(typed).length > 0 : false;
  const resetToDefaults = () => {
    setTyped({});
    setAttempted(false);
    setMessage('');
    updateSearch(setParams, { species: null, seed: null, budget: null, n: null, tune: null });
    setResetArmed(false);
    focusField('vegetation-species');
  };
  const cancelReset = () => {
    setResetArmed(false);
    focusField('vegetation-reset');
  };

  let estimateLabel = 'Select a project';
  if (projectId) {
    if (estimateError) {
      estimateLabel = 'Estimate unavailable';
    } else if (!estimate) {
      estimateLabel = 'Checking estimate…';
    } else if (estimate.available) {
      estimateLabel = `About ${formatDuration(estimate.typicalSeconds)} each`;
    } else {
      estimateLabel = 'Not enough history yet';
    }
  }

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const control of speciesEntry?.controls || []) {
      if (!groups.has(control.group)) {
        groups.set(control.group, []);
      }
      groups.get(control.group).push(control);
    }
    return groups;
  }, [speciesEntry]);

  const problem = state && schema && attempted ? firstProblem(state, schema, typed) : null;
  const biomes = useMemo(() => {
    const out = new Map();
    for (const species of schema?.species || []) {
      const key = species.biome || 'other';
      out.set(key, [...(out.get(key) || []), species]);
    }
    return [...out.entries()];
  }, [schema]);

  return (
    <div className="page vegetation-page">
      <div className="vegetation-heading">
        <div>
          <div className="overline">
            <span className="overline-line" /> PROCEDURAL PLANTS
          </div>
          <h1>
            Vegetation<em>.</em>
          </h1>
          <p className="lead">
            Grow trees and shrubs with SeedThree. It runs on the CPU in a separate process: no
            model, no GPU memory.
          </p>
        </div>
        <Trees size={28} aria-hidden="true" />
      </div>
      {!project && (
        <div className="vegetation-project-note">
          <span>Choose a project in the sidebar to keep your plants together.</span>
          <button className="outline-button" onClick={onNewProject}>
            <Plus size={15} aria-hidden="true" /> Create project
          </button>
        </div>
      )}
      <div className="vegetation-layout">
        <div className="vegetation-main">
          {!status && !loadError && (
            <p className="helper" role="status">
              Checking SeedThree…
            </p>
          )}
          {loadError && (
            <p className="vegetation-notice error" role="alert">
              {loadError}
            </p>
          )}
          {status && !ready && (
            <CheckoutPanel status={status} onFetch={startFetch} busy={fetchBusy} />
          )}
          {status && ready && !schema && !loadError && (
            <p className="helper" role="status">
              Reading SeedThree’s species…
            </p>
          )}
          {status && ready && schema && state && speciesEntry && (
            <section className="panel vegetation-panel" aria-labelledby="vegetation-title">
              <div className="panel-heading">
                <div>
                  <h2 id="vegetation-title">Design a plant</h2>
                  <p className="helper">
                    SeedThree {schema.seedthree.version} · {status.checkout.license} licence · the
                    same species, seed and settings always give the same plant.
                  </p>
                </div>
              </div>
              <form className="vegetation-form" onSubmit={enqueue} noValidate>
                <details
                  className="vegetation-advanced"
                  {...routeDetails(describeOpen, setDescribeOpen)}
                >
                  <summary>
                    <span className="vegetation-advanced-heading">Describe it</span>
                    <span className="vegetation-advanced-hint">
                      Suggest settings from a description
                    </span>
                  </summary>
                  <div className="vegetation-advanced-body">
                    <DescribePanel
                      status={status}
                      species={state.species}
                      speciesName={speciesEntry.name}
                      onApplied={applySuggestion}
                      onOpenSettings={openSettings}
                      refreshStatus={refreshStatus}
                    />
                  </div>
                </details>
                <div className="vegetation-field">
                  <label htmlFor="vegetation-species">Species</label>
                  <select
                    id="vegetation-species"
                    value={state.species}
                    onChange={(event) => chooseSpecies(event.target.value)}
                  >
                    {biomes.map(([biome, list]) => (
                      <optgroup key={biome} label={biome[0].toUpperCase() + biome.slice(1)}>
                        {list.map((species) => (
                          <option key={species.key} value={species.key}>
                            {species.name}
                            {species.latin ? ` (${species.latin})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="vegetation-settings">
                  <div className="vegetation-field">
                    <label htmlFor="vegetation-seed">Seed</label>
                    <div className="vegetation-seed">
                      <input
                        id="vegetation-seed"
                        type="number"
                        min={schema.seed.min}
                        max={schema.seed.max}
                        step="1"
                        value={state.seed}
                        aria-invalid={problem?.id === 'vegetation-seed' ? 'true' : undefined}
                        onChange={(event) => {
                          const number = Number(event.target.value);
                          if (
                            Number.isInteger(number) &&
                            number >= schema.seed.min &&
                            number <= schema.seed.max
                          ) {
                            commit({ ...state, seed: number }, { replace: true });
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="outline-button"
                        aria-label="Pick a random seed"
                        onClick={() => commit({ ...state, seed: randomSeed(schema) })}
                      >
                        <Dices size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className="vegetation-field">
                    <label htmlFor="vegetation-variations">Variations</label>
                    <input
                      id="vegetation-variations"
                      type="number"
                      min="1"
                      max="4"
                      step="1"
                      value={state.variations}
                      onChange={(event) => {
                        const number = Number(event.target.value);
                        if (Number.isInteger(number) && number >= 1 && number <= 4) {
                          commit({ ...state, variations: number }, { replace: true });
                        }
                      }}
                    />
                  </div>
                </div>
                <fieldset className="vegetation-budgets">
                  <legend>Triangle budget</legend>
                  <div className="vegetation-budget-options">
                    {VEGETATION_BUDGETS.map((budget) => {
                      const count = budgetCount(measured, state.species, budget);
                      return (
                        <label
                          key={budget}
                          className={
                            state.budget === budget
                              ? 'vegetation-budget selected'
                              : 'vegetation-budget'
                          }
                        >
                          <input
                            type="radio"
                            name="vegetation-budget"
                            value={budget}
                            checked={state.budget === budget}
                            onChange={() => commit({ ...state, budget })}
                          />
                          <strong>{BUDGET_NAMES[budget]}</strong>
                          <small>
                            {count === null ? 'not measured' : `${formatCount(count)} triangles`}
                          </small>
                        </label>
                      );
                    })}
                  </div>
                  <small>
                    Measured for the default {speciesEntry.name} at seed 1. Your settings change the
                    count; the finished model reports its own.
                  </small>
                </fieldset>
                {[...grouped.entries()]
                  .filter(([group]) => group !== 'advanced')
                  .map(([group, controls]) => (
                    <div
                      key={group}
                      className="vegetation-group"
                      role="group"
                      aria-label={GROUP_TITLES[group]}
                    >
                      <h3>{GROUP_TITLES[group]}</h3>
                      <div className="vegetation-controls">
                        {controls.map((control) => (
                          <ControlRow
                            key={`${state.species}-${control.id}`}
                            control={control}
                            value={
                              Object.hasOwn(state.params, control.id)
                                ? state.params[control.id]
                                : control.default
                            }
                            typedText={typed[control.id]}
                            onValue={setParam}
                            onTyped={typeParam}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                {grouped.get('advanced') && (
                  <details className="vegetation-advanced" {...routeDetails(tuneOpen, setTuneOpen)}>
                    <summary>
                      <span className="vegetation-advanced-heading">{GROUP_TITLES.advanced}</span>
                      <span className="vegetation-advanced-hint">
                        {Object.keys(state.params).filter((id) =>
                          grouped.get('advanced').some((c) => c.id === id),
                        ).length
                          ? 'Some changed'
                          : 'SeedThree’s per-level controls'}
                      </span>
                    </summary>
                    <div className="vegetation-advanced-body vegetation-controls">
                      {grouped.get('advanced').map((control) => (
                        <ControlRow
                          key={`${state.species}-${control.id}`}
                          control={control}
                          value={
                            Object.hasOwn(state.params, control.id)
                              ? state.params[control.id]
                              : control.default
                          }
                          typedText={typed[control.id]}
                          onValue={setParam}
                          onTyped={typeParam}
                        />
                      ))}
                    </div>
                  </details>
                )}
                <p className="helper" role="note">
                  Exports are plain GLB models with standard materials: no textures, no wind
                  animation and no billboard levels of detail. A SeedThree preset is saved beside
                  each model so you can open the design in the SeedThree app.
                </p>
                <CreationQueueTiming estimate={estimate} />
                <div className="vegetation-action">
                  <div className="vegetation-submit">
                    <div>
                      <span className="estimate-label">
                        <Clock3 size={15} aria-hidden="true" /> Estimated render time
                      </span>
                      <strong>{estimateLabel}</strong>
                    </div>
                    <button className="primary" disabled={busy} type="submit">
                      <Plus size={16} aria-hidden="true" />
                      {busy
                        ? 'Queuing…'
                        : state.variations > 1
                          ? `Add ${state.variations} plants to queue`
                          : 'Add plant to queue'}
                    </button>
                  </div>
                  <div className="vegetation-reset">
                    {resetArmed ? (
                      <span
                        className="reset-confirm"
                        role="group"
                        aria-label="Confirm reset"
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            cancelReset();
                          }
                        }}
                      >
                        <span>Discard this page&apos;s settings?</span>
                        <button
                          type="button"
                          className="text-action danger"
                          onClick={resetToDefaults}
                          autoFocus
                        >
                          Yes, reset
                        </button>
                        <button type="button" className="text-action" onClick={cancelReset}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        id="vegetation-reset"
                        type="button"
                        className="text-action reset-defaults"
                        disabled={!isDirty || busy}
                        title={
                          isDirty
                            ? 'Restore every setting on this page to its default'
                            : 'Nothing to reset: this page already uses its defaults'
                        }
                        onClick={() => setResetArmed(true)}
                      >
                        <RotateCcw size={14} aria-hidden="true" /> Reset to defaults
                      </button>
                    )}
                  </div>
                  {notice.text && (
                    <p
                      className={`vegetation-notice ${notice.kind}`}
                      role={notice.kind === 'error' ? 'alert' : 'status'}
                    >
                      {notice.text}
                    </p>
                  )}
                </div>
              </form>
            </section>
          )}
        </div>
        <div className="right-column">
          <PreviewArea
            section="vegetation"
            project={project}
            onRefresh={onRefresh}
            onOpenLibrary={onOpenLibrary}
            onQueued={() => setVersion((v) => v + 1)}
            onReuse={(meta) => {
              const plan = reusePlan(meta);
              const next = plan?.vegetation && schema && stateFromReuse(plan.vegetation, schema);
              if (next) {
                setTyped({});
                updateSearch(setParams, searchFromState(next, schema));
                setMessage('Settings reused from the asset.', 'info');
              }
            }}
            refreshKey={version}
          />
          <RuntimeQueue refreshKey={version} projects={projects} />
        </div>
      </div>
    </div>
  );
}
