import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Clock3, Dices, Globe2, ImagePlus, Layers3, Plus, RotateCcw, X } from 'lucide-react';
import AssetPicker from './AssetPicker';
import { IMAGE_EXTENSIONS } from './asset-picker';
import PreviewArea from './PreviewArea';
import RuntimeQueue, { post } from './RuntimeQueue';
import { CreationQueueTiming } from './QueueTiming';
import { formatDuration } from './queue-timing';
import { updateSearch } from './useNav';
import './world-studio.css';

function ReferencePreview({ file, index, panorama, onRemove }) {
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
          onLoad={(event) =>
            setDimensions({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
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
  const model = params.get('model') === 'hy-world' ? 'hy-world' : 'worldgen';
  const mode = ['image', 'panorama'].includes(params.get('mode')) ? params.get('mode') : 'text';
  const [prompt, setPrompt] = useState(''),
    [output, setOutput] = useState('splat'),
    [size, setSize] = useState(1600),
    [seed, setSeed] = useState('42'),
    [steps, setSteps] = useState('50'),
    [files, setFiles] = useState([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [messageKind, setMessageKind] = useState('error'),
    [estimate, setEstimate] = useState(null),
    [estimateError, setEstimateError] = useState(false),
    [version, setVersion] = useState(0);
  const [resetArmed, setResetArmed] = useState(false);
  // Gated reset: disabled while everything is at its default, and an enabled click only arms a confirmation.
  const isDirty =
    prompt !== '' ||
    output !== 'splat' ||
    size !== 1600 ||
    seed !== '42' ||
    steps !== '50' ||
    files.length > 0 ||
    params.has('mode') ||
    params.has('model');
  const resetToDefaults = () => {
    setPrompt('');
    setOutput('splat');
    setSize(1600);
    setSeed('42');
    setSteps('50');
    setFiles([]);
    setMessage('');
    updateSearch(setParams, { model: null, mode: null });
    setResetArmed(false);
  };
  const actualMode = model === 'hy-world' ? 'image' : mode,
    actualSize =
      model === 'hy-world'
        ? size === 336 || size === 518 || size === 700
          ? size
          : 518
        : [1024, 1600, 2048].includes(size)
          ? size
          : 1600,
    actualOutput = model === 'hy-world' ? 'splat' : output;
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
  };
  const picker = params.get('picker') === 'world';
  const addFiles = (added) => {
    const multi = actualMode === 'image' && model === 'hy-world';
    const next = multi ? [...files, ...added].slice(0, 8) : added.slice(0, 1);
    setFiles(next);
    setMessageKind('error');
    setMessage(
      multi && files.length + added.length > 8 ? 'A maximum of eight views can be selected.' : '',
    );
  };
  const usesGeneration = model === 'worldgen' && actualMode !== 'panorama';
  const buildRequest = useCallback(
    (references) => ({
      model,
      mode: actualMode,
      prompt: usesGeneration ? prompt.trim() : '',
      output: actualOutput,
      resolution: actualSize,
      references,
      seed: usesGeneration ? Number(seed) : 42,
      steps: usesGeneration ? Number(steps) : 50,
    }),
    [model, actualMode, usesGeneration, prompt, actualOutput, actualSize, seed, steps],
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
        .catch(() => {
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
    setMessage('');
  }, [projectId, model, mode, prompt, output, size, seed, steps]);
  async function enqueue(event) {
    event.preventDefault();
    setMessageKind('error');
    if (!project) {
      setMessage('Choose or create a project first.');
      return;
    }
    if (actualMode === 'text' && !prompt.trim()) {
      setMessage('Describe the world you want to create.');
      return;
    }
    if (actualMode !== 'text' && !files.length) {
      setMessage('Choose a reference image first.');
      return;
    }
    if (
      files.some((file) => file.size > 10 * 1024 * 1024) ||
      files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024
    ) {
      setMessage('Use images up to 10 MiB each and 40 MiB total.');
      return;
    }
    if (
      usesGeneration &&
      (!/^\d+$/.test(seed) ||
        Number(seed) > 2147483647 ||
        !/^\d+$/.test(steps) ||
        Number(steps) < 10 ||
        Number(steps) > 60)
    ) {
      setMessage('Use a seed from 0 to 2147483647 and 10–60 steps.');
      return;
    }
    setBusy(true);
    setMessage('');
    let submittingJob = false;
    try {
      const ids = [];
      for (const file of actualMode === 'text' ? [] : files) {
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
      setVersion((v) => v + 1);
      setMessage('World added to the render queue.');
      setMessageKind('success');
    } catch (error) {
      setMessage(
        submittingJob && error.status === undefined
          ? 'The connection ended before Forge could confirm the queue result. Check the render queue before submitting again.'
          : error.message,
      );
      setMessageKind('error');
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
            <div className="world-models">
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
            <form className="world-form" onSubmit={enqueue}>
              {model === 'worldgen' && (
                <label>
                  Starting point
                  <select
                    value={mode}
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
                        mode: e.target.value === 'text' ? null : e.target.value,
                        picker: null,
                      });
                      setFiles([]);
                    }}
                  >
                    <option value="text">Text description</option>
                    <option value="image">Single reference image</option>
                    <option value="panorama">360° panorama</option>
                  </select>
                </label>
              )}
              {actualMode !== 'text' && (
                <div className="world-input">
                  <strong>
                    {actualMode === 'panorama'
                      ? '360° panorama'
                      : model === 'hy-world'
                        ? 'Reference views'
                        : 'Reference image'}
                  </strong>
                  <p className="helper">
                    {model === 'hy-world'
                      ? 'Choose 1–8 overlapping views of the same scene. More angles help fill in the geometry.'
                      : actualMode === 'panorama'
                        ? 'Choose a 2:1 equirectangular panorama in PNG, JPEG, or WebP.'
                        : 'Choose one PNG, JPEG, or WebP image.'}
                  </p>
                  <div className="world-file-actions">
                    <label className="outline-button">
                      <ImagePlus size={16} aria-hidden="true" />{' '}
                      {files.length ? 'Add or replace files' : 'Choose files'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        multiple={model === 'hy-world'}
                        onChange={(e) => {
                          addFiles([...e.target.files]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="outline-button"
                      onClick={() => updateSearch(setParams, { picker: 'world' })}
                    >
                      Choose from library
                    </button>
                  </div>
                  {files.length > 0 && (
                    <div className="world-reference-list">
                      <span className="helper">
                        {files.length} of {model === 'hy-world' ? 8 : 1} selected
                      </span>
                      {files.map((file, index) => (
                        <ReferencePreview
                          file={file}
                          index={index}
                          key={`${file.name}-${file.lastModified}-${index}`}
                          panorama={actualMode === 'panorama'}
                          onRemove={() => {
                            setFiles((current) => current.filter((_, i) => i !== index));
                            setMessage('');
                          }}
                        />
                      ))}
                    </div>
                  )}
                  {!files.length && (
                    <p className="world-reference-empty">
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
                <label>
                  {actualMode === 'text' ? 'Describe your world' : 'Description (optional)'}
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    maxLength={4000}
                    placeholder="A moss-covered village at the edge of a misty lake…"
                  />
                  <span className="helper">Up to 4,000 characters.</span>
                </label>
              )}
              <div className="world-settings">
                <label>
                  {model === 'hy-world' ? 'Resolution per view' : 'Panorama width'}
                  <select value={actualSize} onChange={(e) => setSize(Number(e.target.value))}>
                    {(model === 'hy-world' ? [336, 518, 700] : [1024, 1600, 2048]).map((n) => (
                      <option key={n} value={n}>
                        {n} px
                      </option>
                    ))}
                  </select>
                  <span className="helper">
                    {model === 'hy-world'
                      ? 'Size used to reconstruct each view.'
                      : 'Width of the generated 2:1 panorama. Higher values use more memory.'}
                  </span>
                </label>
                {model === 'worldgen' && (
                  <label>
                    Output
                    <select value={output} onChange={(e) => setOutput(e.target.value)}>
                      <option value="splat">Gaussian splat · PLY</option>
                      <option value="mesh">Mesh · PLY</option>
                    </select>
                    <span className="helper">
                      {output === 'splat'
                        ? 'Best for interactive visual previews.'
                        : 'Vertex-colored geometry for editing.'}
                    </span>
                  </label>
                )}
              </div>
              {model === 'worldgen' && actualMode !== 'panorama' && (
                <div className="world-settings">
                  <label>
                    Generation steps
                    <input
                      type="number"
                      min="10"
                      max="60"
                      step="1"
                      value={steps}
                      onChange={(e) => setSteps(e.target.value)}
                    />
                    <span className="helper">
                      10–60. More steps can improve detail but take longer.
                    </span>
                  </label>
                  <div className="world-seed-field" role="group" aria-labelledby="world-seed-label">
                    <label id="world-seed-label" htmlFor="world-seed">
                      Seed
                    </label>
                    <div className="world-seed">
                      <input
                        id="world-seed"
                        type="number"
                        min="0"
                        max="2147483647"
                        step="1"
                        aria-describedby="world-seed-help"
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
                    <span className="helper" id="world-seed-help">
                      Reuse a seed to repeat the same settings.
                    </span>
                  </div>
                </div>
              )}
              <p className="helper">
                {model === 'hy-world'
                  ? 'HY-World reconstructs a Gaussian splat from the supplied views.'
                  : 'WorldGen runs locally with its installed models. Text and image modes require cached FLUX weights.'}{' '}
                Models unload after each render. GPU memory needed varies; no reliable memory
                estimate is available yet.
              </p>
              {model === 'worldgen' && actualMode !== 'panorama' && (
                <p className="helper" role="note">
                  Text and image generation also use Windows system memory. If a render runs out,
                  offload another model and retry.
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
                    <span className="reset-confirm" role="group" aria-label="Confirm reset">
                      <span>Discard this page&apos;s settings?</span>
                      <button
                        type="button"
                        className="text-action danger"
                        onClick={resetToDefaults}
                        autoFocus
                      >
                        Yes, reset
                      </button>
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => setResetArmed(false)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
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
                    role={messageKind === 'success' ? 'status' : 'alert'}
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
          maxFiles={model === 'hy-world' ? 8 - files.length : 1}
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
