import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Clock3, Dices, Globe2, ImagePlus, Layers3, Plus, RotateCcw, X } from 'lucide-react';
import AssetPicker from './AssetPicker';
import { IMAGE_EXTENSIONS } from './asset-picker';
import PreviewArea from './PreviewArea';
import RuntimeQueue, { post } from './RuntimeQueue';
import { CreationQueueTiming } from './QueueTiming';
import { formatDuration } from './queue-timing';
import { reusePlan } from './generation-details';
import { routeDetails, updateSearch, useRouteToggle } from './useNav';
import { createLog } from './app-log.js';
import './world-studio.css';

const WORLDGEN_SIZES = [1024, 1600, 2048];
const HY_SIZES = [336, 518, 700, 952];
const SPLAT_LIMITS = [250000, 500000, 1000000, 2000000, 5000000];
const MAX_SEED = 2147483647;
const NO_NOTICE = { text: '', kind: 'error' };
const log = createLog('world');
// Library pages hand a reused world to this page through the session, as it can be a long prompt.
const REUSE_KEY = 'forge-world-reuse';

// Every field is validated here as the backend validates it (runtime/jobs.js and world_worker.py).
const seedProblem = (value) =>
  value === '' || (/^\d+$/.test(value) && Number(value) <= MAX_SEED)
    ? ''
    : 'Enter a whole number from 0 to 2,147,483,647, or leave blank for a random seed.';
const stepsProblem = (value) =>
  /^\d+$/.test(value) && Number(value) >= 10 && Number(value) <= 60
    ? ''
    : 'Enter a whole number from 10 to 60.';
const guidanceProblem = (value) =>
  value === '' || (/^\d+(\.\d+)?$/.test(value) && Number(value) >= 1 && Number(value) <= 50)
    ? ''
    : 'Enter a number from 1 to 50, or leave blank for the default.';
const confidenceProblem = (value) =>
  /^\d+(\.\d+)?$/.test(value) && Number(value) <= 50 ? '' : 'Enter a number from 0 to 50.';
const fileKey = (file, index) => `${file.name}-${file.lastModified}-${index}`;
const formatCount = (count) =>
  count >= 1e6 ? `${(count / 1e6).toFixed(1)}M` : `${Math.round(count / 1000)}k`;

function ReferencePreview({ file, index, panorama, onRemove, onShape }) {
  const [url, setUrl] = useState(''),
    [dimensions, setDimensions] = useState(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setDimensions(null);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const wrongRatio =
    panorama && dimensions && Math.abs(dimensions.width / dimensions.height - 2) > 0.03;
  return (
    <div className="world-reference">
      {url && (
        <img
          src={url}
          alt={`Reference ${index + 1}: ${file.name}`}
          onLoad={(event) => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            setDimensions({ width, height });
            onShape?.(width / height);
          }}
        />
      )}
      <div>
        <strong title={file.name}>{file.name}</strong>
        <span>
          {dimensions ? `${dimensions.width} × ${dimensions.height} px` : 'Reading image…'}
        </span>
        {wrongRatio && (
          <span className="world-reference-warning">
            A 2:1 panorama works best; this image will be stretched.
          </span>
        )}
      </div>
      <button
        type="button"
        className="icon-btn"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function WorldStudio({ project, projects, onRefresh, onOpenLibrary, onNewProject }) {
  const [params, setParams] = useSearchParams();
  const [tuneOpen, setTuneOpen] = useRouteToggle('tune');
  const model = params.get('model') === 'hy-world' ? 'hy-world' : 'worldgen';
  const mode = ['image', 'panorama'].includes(params.get('mode')) ? params.get('mode') : 'text';
  const [prompt, setPrompt] = useState(''),
    [output, setOutput] = useState('splat'),
    [size, setSize] = useState(1600),
    [seed, setSeed] = useState(''),
    [steps, setSteps] = useState('50'),
    [guidance, setGuidance] = useState(''),
    [savePanorama, setSavePanorama] = useState(false),
    [splatLimit, setSplatLimit] = useState(1000000),
    [removeSky, setRemoveSky] = useState(false),
    [confidence, setConfidence] = useState('10'),
    [files, setFiles] = useState([]),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(NO_NOTICE),
    [attempted, setAttempted] = useState(false),
    [estimate, setEstimate] = useState(null),
    [estimateError, setEstimateError] = useState(false),
    [version, setVersion] = useState(0);
  const [resetArmed, setResetArmed] = useState(false);
  const focusField = (id) => setTimeout(() => document.getElementById(id)?.focus(), 0);
  const [shapes, setShapes] = useState({});
  const message = notice.text,
    messageKind = notice.kind;
  const setMessage = (text, kind = 'error') => setNotice(text ? { text, kind } : NO_NOTICE);
  // Gated reset: disabled while everything is at its default, and an enabled click only arms a confirmation.
  const isDirty =
    prompt !== '' ||
    output !== 'splat' ||
    size !== 1600 ||
    seed !== '' ||
    steps !== '50' ||
    guidance !== '' ||
    savePanorama ||
    splatLimit !== 1000000 ||
    removeSky ||
    confidence !== '10' ||
    files.length > 0 ||
    params.has('mode') ||
    params.has('model');
  const resetToDefaults = () => {
    setPrompt('');
    setOutput('splat');
    setSize(1600);
    setSeed('');
    setSteps('50');
    setGuidance('');
    setSavePanorama(false);
    setSplatLimit(1000000);
    setRemoveSky(false);
    setConfidence('10');
    setFiles([]);
    setMessage('');
    setAttempted(false);
    updateSearch(setParams, { model: null, mode: null });
    setResetArmed(false);
    // The confirmation buttons disappear, so focus moves to the first field of the clean form.
    focusField('world-mode');
  };
  const cancelReset = () => {
    setResetArmed(false);
    focusField('world-reset');
  };
  const actualMode = model === 'hy-world' ? (mode === 'panorama' ? 'panorama' : 'image') : mode,
    actualSize =
      model === 'hy-world'
        ? HY_SIZES.includes(size)
          ? size
          : 518
        : WORLDGEN_SIZES.includes(size)
          ? size
          : 1600,
    actualOutput = model === 'hy-world' ? 'splat' : output;
  const usesGeneration = model === 'worldgen' && actualMode !== 'panorama';
  const maxViews = model === 'hy-world' && actualMode === 'image' ? 8 : 1;
  const hasAdvanced = model === 'hy-world' || usesGeneration;
  const selectModel = (value) => {
    if (value === model) {
      return;
    }
    if (
      files.length &&
      !window.confirm('Changing generators removes the selected images. Continue?')
    ) {
      return;
    }
    updateSearch(setParams, {
      model: value === 'worldgen' ? null : value,
      mode: null,
      picker: null,
    });
    setFiles([]);
    setSize(value === 'hy-world' ? 518 : 1600);
    setMessage('');
    setAttempted(false);
  };
  const picker = params.get('picker') === 'world';
  // Closing the library hands focus back to the button that opened it.
  const pickerWasOpen = useRef(false);
  useEffect(() => {
    if (pickerWasOpen.current && !picker) {
      document.getElementById('world-library-button')?.focus();
    }
    pickerWasOpen.current = picker;
  }, [picker]);
  const addFiles = (added) => {
    const multi = actualMode === 'image' && model === 'hy-world';
    const next = multi ? [...files, ...added].slice(0, 8) : added.slice(0, 1);
    setFiles(next);
    setMessage(
      multi && files.length + added.length > 8 ? 'A maximum of eight views can be selected.' : '',
    );
  };
  // Restore the settings of a finished world. Reference files are never attached again.
  const applyWorld = useCallback(
    (settings) => {
      const hy = settings.model === 'hy-world';
      const sizes = hy ? HY_SIZES : WORLDGEN_SIZES;
      setPrompt(settings.prompt || '');
      setOutput(['mesh', 'glb'].includes(settings.output) ? settings.output : 'splat');
      setSize(sizes.includes(settings.resolution) ? settings.resolution : hy ? 518 : 1600);
      setSeed(Number.isSafeInteger(settings.seed) ? String(settings.seed) : '');
      setSteps(String(settings.steps ?? 50));
      setGuidance(
        settings.guidance === null || settings.guidance === undefined
          ? ''
          : String(settings.guidance),
      );
      setSavePanorama(settings.save_panorama === true);
      setSplatLimit(settings.splat_limit ?? 1000000);
      setRemoveSky(settings.remove_sky === true);
      setConfidence(String(settings.confidence_percentile ?? 10));
      setFiles([]);
      setAttempted(false);
      updateSearch(setParams, {
        model: hy ? 'hy-world' : null,
        mode: (hy ? ['panorama'] : ['image', 'panorama']).includes(settings.mode)
          ? settings.mode
          : null,
        picker: null,
      });
      setNotice({
        kind: 'info',
        text:
          hy || settings.mode !== 'text'
            ? 'Settings restored from the asset. Choose the reference images again before queuing.'
            : 'Settings restored from the asset.',
      });
    },
    [setParams],
  );
  useEffect(() => {
    let stored = null;
    try {
      stored = window.sessionStorage.getItem(REUSE_KEY);
      window.sessionStorage.removeItem(REUSE_KEY);
    } catch (error) {
      // Session storage can be unavailable; the model is still selected from the address.
      log.debug('world.reuse.take.failed', { error });
    }
    if (stored) {
      try {
        applyWorld(JSON.parse(stored));
      } catch (error) {
        // A damaged hand-off is ignored.
        log.warn('world.reuse.restore.failed', { error });
      }
    }
  }, [applyWorld]);
  const buildRequest = useCallback(
    (references) => {
      const request = {
        model,
        mode: actualMode,
        prompt: usesGeneration ? prompt.trim() : '',
        output: actualOutput,
        resolution: actualSize,
        references,
      };
      // Only valid values are sent, so a half-typed field never breaks the time estimate.
      if (usesGeneration) {
        request.seed = seed !== '' && !seedProblem(seed) ? Number(seed) : null;
        request.steps = stepsProblem(steps) ? 50 : Number(steps);
        if (guidance !== '' && !guidanceProblem(guidance)) {
          request.guidance = Number(guidance);
        }
        if (savePanorama) {
          request.save_panorama = true;
        }
      }
      if (model === 'hy-world') {
        request.splat_limit = splatLimit;
        request.remove_sky = removeSky;
        request.confidence_percentile = confidenceProblem(confidence) ? 10 : Number(confidence);
      }
      return request;
    },
    [
      model,
      actualMode,
      usesGeneration,
      prompt,
      actualOutput,
      actualSize,
      seed,
      steps,
      guidance,
      savePanorama,
      splatLimit,
      removeSky,
      confidence,
    ],
  );
  const projectId = project?.id;
  useEffect(() => {
    let active = true;
    setEstimate(null);
    setEstimateError(false);
    if (!projectId) {
      return;
    }
    const placeholder = Array.from(
      { length: actualMode === 'text' ? 0 : Math.max(1, files.length) },
      () => '00000000-0000-0000-0000-000000000000.png',
    );
    const request = buildRequest(placeholder);
    request.prompt ||= 'estimate';
    const timer = setTimeout(() => {
      post('/api/runtime/estimate', { type: 'world', projectId, request })
        .then((result) => {
          if (active) {
            setEstimate(result);
          }
        })
        .catch((error) => {
          log.debug('world.estimate.failed', { error });
          if (active) {
            setEstimateError(true);
          }
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, buildRequest, actualMode, files.length, version]);
  useEffect(() => {
    // Editing clears an old error or confirmation, but keeps the note about restored settings.
    setNotice((current) => (current.kind === 'info' ? current : NO_NOTICE));
  }, [projectId, model, mode, prompt, output, size, seed, steps, guidance, confidence]);
  // The first problem in page order, with the field that should receive focus.
  const firstProblem = () => {
    if (actualMode !== 'text' && !files.length) {
      return { text: 'Choose a reference image first.', id: 'world-files' };
    }
    if (
      files.some((file) => file.size > 10 * 1024 * 1024) ||
      files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024
    ) {
      return { text: 'Use images up to 10 MiB each and 40 MiB total.', id: 'world-files' };
    }
    if (actualMode === 'text' && !prompt.trim()) {
      return { text: 'Describe the world you want to create.', id: 'world-prompt' };
    }
    if (usesGeneration && stepsProblem(steps)) {
      return { text: stepsProblem(steps), id: 'world-steps' };
    }
    if (usesGeneration && seedProblem(seed)) {
      return { text: seedProblem(seed), id: 'world-seed' };
    }
    if (usesGeneration && guidanceProblem(guidance)) {
      return { text: guidanceProblem(guidance), id: 'world-guidance', tune: true };
    }
    if (model === 'hy-world' && confidenceProblem(confidence)) {
      return { text: confidenceProblem(confidence), id: 'world-confidence', tune: true };
    }
    return null;
  };
  async function enqueue(event) {
    event.preventDefault();
    if (!project) {
      // Field errors would only distract from the one thing that blocks every field.
      setMessage('Choose or create a project first.');
      return;
    }
    setAttempted(true);
    const problem = firstProblem();
    if (problem) {
      setMessage(problem.text);
      if (problem.tune) {
        setTuneOpen(true);
      }
      if (problem.id) {
        focusField(problem.id);
      }
      return;
    }
    setBusy(true);
    setMessage('');
    let submittingJob = false;
    const stopSubmit = log.time('world.submit.completed', { model, mode: actualMode });
    log.info('world.submit.requested', {
      model,
      mode: actualMode,
      referenceCount: actualMode === 'text' ? 0 : files.length,
    });
    try {
      const ids = [];
      for (const file of actualMode === 'text' ? [] : files) {
        // log-coverage: ignore -- /api requests are logged by the browser capture (http.request.failed).
        const response = await fetch(`/api/projects/${project.id}/references`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Forge-Request': 'project',
          },
          body: file,
        });
        const data = await response.json();
        if (!response.ok) {
          throw Error(data.error || 'Could not save reference.');
        }
        ids.push(data.reference.id);
      }
      submittingJob = true;
      await post('/api/runtime/jobs', {
        type: 'world',
        projectId: project.id,
        request: buildRequest(ids),
      });
      stopSubmit();
      setVersion((v) => v + 1);
      setMessage('World added to the render queue.', 'success');
    } catch (error) {
      const isOutcomeUnknown = submittingJob && error.status === undefined;
      log.warn('world.submit.failed', {
        reason: isOutcomeUnknown ? 'outcome_unknown' : 'not_queued',
        hasSubmittedJob: submittingJob,
        status: error.status,
        error,
      });
      setMessage(
        submittingJob && error.status === undefined
          ? 'The connection ended before Forge could confirm the queue result. Check the render queue before submitting again.'
          : error.message,
      );
    } finally {
      setBusy(false);
    }
  }
  let estimateLabel = 'Select a project';
  if (projectId) {
    if (estimateError) {
      estimateLabel = 'Estimate unavailable';
    } else if (!estimate) {
      estimateLabel = 'Checking estimate…';
    } else if (estimate.available) {
      estimateLabel = `About ${formatDuration(estimate.typicalSeconds)}`;
    } else {
      estimateLabel = 'Not enough history yet';
    }
  }
  // HY-World rejects views of different proportions; the worker crops them to the first one.
  const ratios = files.map((file, index) => shapes[fileKey(file, index)]).filter(Boolean);
  const mixedShapes =
    model === 'hy-world' &&
    actualMode === 'image' &&
    ratios.some((ratio) => Math.abs(ratio / ratios[0] - 1) > 0.01);
  const promptInvalid = attempted && actualMode === 'text' && !prompt.trim(),
    filesInvalid = attempted && actualMode !== 'text' && !files.length,
    stepsError = stepsProblem(steps),
    seedError = seedProblem(seed),
    guidanceError = guidanceProblem(guidance),
    confidenceError = confidenceProblem(confidence);
  const panoramaWidth =
    actualMode === 'panorama'
      ? `The image is resized to ${actualSize} × ${actualSize / 2} px, so use a 2:1 panorama. `
      : `Generates a 2:1 panorama of ${actualSize} × ${actualSize / 2} px. `;
  const advancedChanged = [
    guidance !== '' && usesGeneration && 'guidance',
    savePanorama && usesGeneration && 'saved panorama',
    model === 'hy-world' && splatLimit !== 1000000 && 'splat limit',
    model === 'hy-world' && removeSky && 'sky removed',
    model === 'hy-world' && confidence !== '10' && 'confidence filter',
  ].filter(Boolean);
  return (
    <div className="page world-page">
      <div className="world-heading">
        <div>
          <div className="overline">
            <span className="overline-line" /> WORLD GENERATION
          </div>
          <h1>
            World studio<em>.</em>
          </h1>
          <p className="lead">Build a scene from a description, a reference, or a set of views.</p>
        </div>
        <Globe2 size={28} aria-hidden="true" />
      </div>
      {!project && (
        <div className="world-project-note">
          <span>Choose a project in the sidebar to keep your worlds together.</span>
          <button className="outline-button" onClick={onNewProject}>
            <Plus size={15} aria-hidden="true" /> Create project
          </button>
        </div>
      )}
      <div className="world-layout">
        <div className="world-main">
          <section className="panel world-panel">
            <div className="panel-heading">
              <div>
                <h2>Choose a generator</h2>
                <p className="helper">
                  Both use local CUDA runtimes when their required models and engine dependencies
                  are available.
                </p>
              </div>
            </div>
            <div className="world-models" role="group" aria-label="Generator">
              <button
                type="button"
                className={model === 'worldgen' ? 'world-model selected' : 'world-model'}
                aria-pressed={model === 'worldgen'}
                onClick={() => selectModel('worldgen')}
              >
                <Globe2 size={21} aria-hidden="true" />
                <span>
                  <strong>WorldGen</strong>
                  <small>Text, one image, or a 360° panorama</small>
                </span>
              </button>
              <button
                type="button"
                className={model === 'hy-world' ? 'world-model selected' : 'world-model'}
                aria-pressed={model === 'hy-world'}
                onClick={() => selectModel('hy-world')}
              >
                <Layers3 size={21} aria-hidden="true" />
                <span>
                  <strong>HY-World 2.0</strong>
                  <small>Reconstruct a scene from 1–8 images</small>
                </span>
              </button>
            </div>
            <form className="world-form" onSubmit={enqueue} noValidate>
              <div className="world-field">
                <label htmlFor="world-mode">Starting point</label>
                <select
                  id="world-mode"
                  value={actualMode}
                  onChange={(e) => {
                    if (
                      files.length &&
                      !window.confirm(
                        'Changing the starting point removes the selected images. Continue?',
                      )
                    ) {
                      return;
                    }
                    updateSearch(setParams, {
                      mode:
                        e.target.value === (model === 'hy-world' ? 'image' : 'text')
                          ? null
                          : e.target.value,
                      picker: null,
                    });
                    setFiles([]);
                    setAttempted(false);
                  }}
                >
                  {model === 'hy-world' ? (
                    <>
                      <option value="image">Reference views (1–8 images)</option>
                      <option value="panorama">360° panorama</option>
                    </>
                  ) : (
                    <>
                      <option value="text">Text description</option>
                      <option value="image">Single reference image</option>
                      <option value="panorama">360° panorama</option>
                    </>
                  )}
                </select>
              </div>
              {actualMode !== 'text' && (
                <div className="world-input">
                  <strong>
                    {actualMode === 'panorama'
                      ? '360° panorama'
                      : model === 'hy-world'
                        ? 'Reference views'
                        : 'Reference image'}
                  </strong>
                  <p className="helper" id="world-files-help">
                    {actualMode === 'panorama'
                      ? `Choose a 2:1 equirectangular panorama in PNG, JPEG, or WebP. A panorama saved with “Save the generated panorama” works here.${
                          model === 'hy-world'
                            ? ' HY-World cuts it into eight 90° views taken from one point, so you get a shell around the viewpoint with no depth behind objects.'
                            : ''
                        }`
                      : model === 'hy-world'
                        ? 'Choose 1–8 overlapping views of the same scene. More angles help fill in the geometry.'
                        : 'Choose one PNG, JPEG, or WebP image.'}
                  </p>
                  <div className="world-file-actions">
                    <label className="outline-button">
                      <ImagePlus size={16} aria-hidden="true" />{' '}
                      {files.length ? 'Add or replace files' : 'Choose files'}
                      <input
                        id="world-files"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        multiple={maxViews > 1}
                        aria-invalid={filesInvalid ? 'true' : undefined}
                        aria-describedby="world-files-help world-files-status"
                        onChange={(e) => {
                          addFiles([...e.target.files]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      id="world-library-button"
                      type="button"
                      className="outline-button"
                      onClick={() => updateSearch(setParams, { picker: 'world' })}
                    >
                      Choose from library
                    </button>
                  </div>
                  {files.length > 0 && (
                    <div className="world-reference-list">
                      <span className="helper" id="world-files-status">
                        {files.length} of {maxViews} selected
                      </span>
                      {files.map((file, index) => (
                        <ReferencePreview
                          file={file}
                          index={index}
                          key={fileKey(file, index)}
                          panorama={actualMode === 'panorama'}
                          onShape={(ratio) =>
                            setShapes((current) =>
                              current[fileKey(file, index)] === ratio
                                ? current
                                : { ...current, [fileKey(file, index)]: ratio },
                            )
                          }
                          onRemove={() => {
                            setFiles((current) => current.filter((_, i) => i !== index));
                            setMessage('');
                          }}
                        />
                      ))}
                    </div>
                  )}
                  {mixedShapes && (
                    <p className="world-reference-warning" id="world-shapes-note" role="note">
                      These views have different shapes. HY-World needs one shape, so Forge crops
                      every view to the first view’s proportions, centred, before reconstructing.
                    </p>
                  )}
                  {!files.length && (
                    <p
                      className={
                        filesInvalid
                          ? 'world-reference-empty world-reference-invalid'
                          : 'world-reference-empty'
                      }
                      id="world-files-status"
                    >
                      {actualMode === 'panorama'
                        ? 'No panorama selected yet.'
                        : model === 'hy-world'
                          ? 'No views selected yet. Add at least one image of the scene.'
                          : 'No reference image selected yet.'}
                    </p>
                  )}
                </div>
              )}
              {model === 'worldgen' && actualMode !== 'panorama' && (
                <div className="world-field">
                  <label htmlFor="world-prompt">
                    {actualMode === 'text' ? 'Describe your world' : 'Description (optional)'}
                  </label>
                  <textarea
                    id="world-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    maxLength={4000}
                    aria-invalid={promptInvalid ? 'true' : undefined}
                    aria-describedby={`world-prompt-help${promptInvalid ? ' world-prompt-error' : ''}`}
                    placeholder="A moss-covered village at the edge of a misty lake…"
                  />
                  <small id="world-prompt-help">
                    {actualMode === 'text'
                      ? 'Required. Up to 4,000 characters.'
                      : 'Optional: say what lies outside the photo. Up to 4,000 characters.'}
                  </small>
                  {promptInvalid && (
                    <small id="world-prompt-error" className="world-field-error">
                      Describe the world you want to create.
                    </small>
                  )}
                </div>
              )}
              <div className="world-settings">
                <div className="world-field">
                  <label htmlFor="world-size">
                    {model === 'hy-world' ? 'Resolution per view' : 'Panorama width'}
                  </label>
                  <select
                    id="world-size"
                    value={actualSize}
                    aria-describedby="world-size-help"
                    onChange={(e) => setSize(Number(e.target.value))}
                  >
                    {(model === 'hy-world' ? HY_SIZES : WORLDGEN_SIZES).map((n) => (
                      <option key={n} value={n}>
                        {n} px
                      </option>
                    ))}
                  </select>
                  <small id="world-size-help">
                    {model === 'hy-world'
                      ? `${
                          actualMode === 'panorama'
                            ? 'Size of each of the eight views cut from the panorama'
                            : 'Longest side used to reconstruct each view'
                        }; 952 is HY-World’s own default. More pixels add splats and need more memory.`
                      : `${panoramaWidth}About ${formatCount((actualSize * actualSize) / 2)} ${
                          actualOutput === 'splat' ? 'splats' : 'mesh vertices'
                        }; larger widths use more memory.`}
                  </small>
                </div>
                {model === 'worldgen' && (
                  <div className="world-field">
                    <label htmlFor="world-output">Output</label>
                    <select
                      id="world-output"
                      value={output}
                      aria-describedby="world-output-help"
                      onChange={(e) => setOutput(e.target.value)}
                    >
                      <option value="splat">Gaussian splat · PLY</option>
                      <option value="mesh">Mesh · PLY</option>
                      <option value="glb">Mesh · GLB</option>
                    </select>
                    <small id="world-output-help">
                      {output === 'splat'
                        ? 'Best for interactive visual previews.'
                        : output === 'mesh'
                          ? 'Vertex-coloured triangle mesh in PLY.'
                          : 'Vertex-coloured triangle mesh in GLB, ready for game engines and 3D tools.'}
                    </small>
                  </div>
                )}
              </div>
              {usesGeneration && (
                <div className="world-settings">
                  <div className="world-field">
                    <label htmlFor="world-steps">Generation steps</label>
                    <input
                      id="world-steps"
                      type="number"
                      inputMode="numeric"
                      min="10"
                      max="60"
                      step="1"
                      value={steps}
                      aria-invalid={attempted && stepsError ? 'true' : undefined}
                      aria-describedby={`world-steps-help${attempted && stepsError ? ' world-steps-error' : ''}`}
                      onChange={(e) => setSteps(e.target.value)}
                    />
                    <small id="world-steps-help">
                      10–60. More steps can improve detail but take longer.
                    </small>
                    {attempted && stepsError && (
                      <small id="world-steps-error" className="world-field-error">
                        {stepsError}
                      </small>
                    )}
                  </div>
                  <div className="world-field">
                    <label htmlFor="world-seed">Seed</label>
                    <div className="world-seed">
                      <input
                        id="world-seed"
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max={MAX_SEED}
                        step="1"
                        placeholder="Random"
                        aria-invalid={attempted && seedError ? 'true' : undefined}
                        aria-describedby={`world-seed-help${attempted && seedError ? ' world-seed-error' : ''}`}
                        value={seed}
                        onChange={(e) => setSeed(e.target.value)}
                      />
                      <button
                        type="button"
                        className="outline-button"
                        aria-label="Randomize seed"
                        title="Randomize seed"
                        onClick={() =>
                          setSeed(
                            String(crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff),
                          )
                        }
                      >
                        <Dices size={18} aria-hidden="true" />
                      </button>
                    </div>
                    <small id="world-seed-help">
                      Blank picks a random seed and records it with the world. Reuse a seed with the
                      same settings to repeat a result.
                    </small>
                    {attempted && seedError && (
                      <small id="world-seed-error" className="world-field-error">
                        {seedError}
                      </small>
                    )}
                  </div>
                </div>
              )}
              {hasAdvanced && (
                <details className="world-advanced" {...routeDetails(tuneOpen, setTuneOpen)}>
                  <summary aria-expanded={tuneOpen} aria-controls="world-advanced-body">
                    <span className="world-advanced-heading">Advanced options</span>
                    <span className="world-advanced-hint">
                      {tuneOpen
                        ? 'Hide optional controls'
                        : advancedChanged.length
                          ? `Show optional controls · changed: ${advancedChanged.join(', ')}`
                          : 'Show optional controls'}
                    </span>
                  </summary>
                  <div className="world-advanced-body" id="world-advanced-body">
                    {usesGeneration && (
                      <>
                        <div className="world-field">
                          <label htmlFor="world-guidance">Prompt guidance</label>
                          <input
                            id="world-guidance"
                            type="number"
                            inputMode="decimal"
                            min="1"
                            max="50"
                            step="0.5"
                            placeholder={actualMode === 'text' ? '7' : '30'}
                            value={guidance}
                            aria-invalid={guidanceError ? 'true' : undefined}
                            aria-describedby={`world-guidance-help${guidanceError ? ' world-guidance-error' : ''}`}
                            onChange={(e) => setGuidance(e.target.value)}
                          />
                          <small id="world-guidance-help">
                            How strongly FLUX follows the description, 1–50. Blank uses the model’s
                            own {actualMode === 'text' ? '7' : '30'}.
                          </small>
                          {guidanceError && (
                            <small id="world-guidance-error" className="world-field-error">
                              {guidanceError}
                            </small>
                          )}
                        </div>
                        <div className="world-field">
                          <label className="world-check" htmlFor="world-save-panorama">
                            <input
                              id="world-save-panorama"
                              type="checkbox"
                              checked={savePanorama}
                              aria-describedby="world-save-panorama-help"
                              onChange={(e) => setSavePanorama(e.target.checked)}
                            />
                            <span>Save the generated panorama</span>
                          </label>
                          <small id="world-save-panorama-help">
                            Also keeps the 360° image as a project image. Use it as a panorama input
                            to build the other output type without generating it again.
                          </small>
                        </div>
                      </>
                    )}
                    {model === 'hy-world' && (
                      <>
                        <div className="world-field">
                          <label htmlFor="world-splat-limit">Splat limit</label>
                          <select
                            id="world-splat-limit"
                            value={splatLimit}
                            aria-describedby="world-splat-limit-help"
                            onChange={(e) => setSplatLimit(Number(e.target.value))}
                          >
                            {SPLAT_LIMITS.map((n) => (
                              <option key={n} value={n}>
                                {n.toLocaleString('en-US')}
                                {n === 1000000 ? ' (default)' : ''}
                              </option>
                            ))}
                          </select>
                          <small id="world-splat-limit-help">
                            The most Gaussians kept in the PLY. Many views at a high resolution
                            exceed the default, so extra detail is thinned out; raise it for more
                            detail or lower it for a smaller file.
                          </small>
                        </div>
                        <div className="world-field">
                          <label className="world-check" htmlFor="world-remove-sky">
                            <input
                              id="world-remove-sky"
                              type="checkbox"
                              checked={removeSky}
                              aria-describedby="world-remove-sky-help"
                              onChange={(e) => setRemoveSky(e.target.checked)}
                            />
                            <span>Remove sky</span>
                          </label>
                          <small id="world-remove-sky-help">
                            Drops sky pixels with HY-World’s sky model, for outdoor views. Leave it
                            off for indoor scenes.
                          </small>
                        </div>
                        <div className="world-field">
                          <label htmlFor="world-confidence">Drop least-confident points (%)</label>
                          <input
                            id="world-confidence"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            max="50"
                            step="1"
                            value={confidence}
                            aria-invalid={confidenceError ? 'true' : undefined}
                            aria-describedby={`world-confidence-help${confidenceError ? ' world-confidence-error' : ''}`}
                            onChange={(e) => setConfidence(e.target.value)}
                          />
                          <small id="world-confidence-help">
                            0–50. Removes this share of the points HY-World is least sure about,
                            which clears floaters. 0 keeps every point; the default is 10.
                          </small>
                          {confidenceError && (
                            <small id="world-confidence-error" className="world-field-error">
                              {confidenceError}
                            </small>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </details>
              )}
              <p className="helper">
                {model === 'hy-world'
                  ? actualMode === 'panorama'
                    ? 'HY-World reconstructs a Gaussian splat from eight views cut from the panorama.'
                    : 'HY-World reconstructs a Gaussian splat from the supplied views.'
                  : 'WorldGen runs locally with its installed models. Text and image modes require cached FLUX weights.'}{' '}
                Models unload after each render. GPU memory needed varies; no reliable memory
                estimate is available yet.
              </p>
              {model === 'worldgen' && actualMode !== 'panorama' && (
                <p className="helper" role="note">
                  Text and image generation also use Windows system memory: loading FLUX can leave
                  almost none free for a while, and a 1024 px test used about 16 GB of GPU memory.
                  Offload other models first; if a render runs out, retry.
                  {actualMode === 'image'
                    ? ' Single photos are projected using an estimated 90° field of view.'
                    : ''}
                </p>
              )}
              <CreationQueueTiming estimate={estimate} />
              <div className="world-action">
                <div className="world-submit">
                  <div>
                    <span className="estimate-label">
                      <Clock3 size={15} aria-hidden="true" /> Estimated render time
                    </span>
                    <strong>{estimateLabel}</strong>
                  </div>
                  <button className="primary" disabled={busy} type="submit">
                    <Plus size={16} aria-hidden="true" />
                    {busy ? 'Queuing…' : 'Add world to queue'}
                  </button>
                </div>
                <div className="world-reset">
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
                      id="world-reset"
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
                {message && (
                  <p
                    className={`world-notice ${messageKind}`}
                    role={messageKind === 'error' ? 'alert' : 'status'}
                  >
                    {message}
                  </p>
                )}
              </div>
            </form>
          </section>
        </div>
        <div className="right-column">
          <PreviewArea
            section="world"
            project={project}
            onRefresh={onRefresh}
            onOpenLibrary={onOpenLibrary}
            onQueued={() => setVersion((v) => v + 1)}
            onReuse={(meta) => {
              const plan = reusePlan(meta);
              if (plan?.world) {
                applyWorld(plan.world);
              }
            }}
            refreshKey={version}
          />
          <RuntimeQueue refreshKey={version} projects={projects} />
        </div>
      </div>
      {picker && (
        <AssetPicker
          title="Choose world reference images"
          projects={projects}
          project={project}
          extensions={IMAGE_EXTENSIONS}
          maxFiles={maxViews > 1 ? maxViews - files.length : 1}
          totalBytes={40 * 1024 * 1024 - files.reduce((sum, file) => sum + file.size, 0)}
          onSelect={(selected) => {
            addFiles(selected);
            updateSearch(setParams, { picker: null });
          }}
          onClose={() => updateSearch(setParams, { picker: null })}
        />
      )}
    </div>
  );
}
