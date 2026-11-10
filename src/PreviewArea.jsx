import TextAssetPreview from './TextAssetPreview';
import { useSearchParams } from 'react-router';
import { useRouteToggle, updateSearch } from './useNav';
import InteractiveAssetViewer from './InteractiveAssetViewer';
import AssetThumbnail, { isVisualAsset } from './AssetThumbnail';
import AssetConverter, { canConvert } from './AssetConverter';
import MusicDerive from './MusicDerive';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  FileOutput,
  ImageOff,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import { RepeatButton, ShrinkButton } from './MiniPlayer';
import { isDerivedMusic, rerunRequest } from './rerun-request';
import GenerationDetails from './GenerationDetails';
import { useAssetMetaIndex } from './asset-meta-index';
import { friendlyAssetLabel } from './asset-labels.js';
import { createLog } from './app-log.js';
import './preview-area.css';

const log = createLog('ui');

const folders = {
  images: ['images/'],
  video: ['video/'],
  music: ['music/'],
  sfx: ['sfx/'],
  voices: ['voices/'],
  segmentation: ['masks/'],
  '3d': ['3d/', 'models/'],
  world: ['3d/'],
  vegetation: ['3d/'],
  motion: ['motion/', 'animations/'],
};

async function post(url, body, kind = 'project') {
  // log-coverage: ignore -- /api requests are logged by the browser capture (http.request.failed).
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': kind },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || 'Request failed.');
  }
  return result;
}

function matches(asset, section) {
  const id = asset.id.toLowerCase();
  if (section === 'game') {
    return id.startsWith('text/decision-') && asset.category === 'Text';
  }
  return (
    (folders[section] || []).some((prefix) => id.startsWith(prefix)) &&
    (['3d', 'motion', 'vegetation'].includes(section) ? asset.category === '3D' : true)
  );
}

// Only these job types take a new random seed on rerun. World jobs do so in worldgen mode only.
function supportsNewSeed(job) {
  return (
    ['images', 'music', 'sfx', 'voices', 'drama3', '3d', 'trellis', 'motion'].includes(job.type) ||
    (job.type === 'world' && job.request.model === 'worldgen' && job.request.mode !== 'panorama')
  );
}

// The large preview: a skeleton until the picture arrives, and a plain message if it cannot load.
function PreviewImage({ src, alt }) {
  const [state, setState] = useState('loading');
  // A new source starts a new load, so the skeleton shows until onLoad or onError fires.
  useEffect(() => setState('loading'), [src]);
  if (state === 'failed') {
    return (
      <div className="iteration-image-error" role="status">
        <ImageOff size={28} aria-hidden="true" />
        <strong>Preview unavailable</strong>
        <span>Forge could not load this image. The file is still in the project.</span>
      </div>
    );
  }
  return (
    <>
      {state === 'loading' && <span className="asset-skeleton" aria-hidden="true" />}
      <img
        src={src}
        alt={alt}
        onLoad={() => setState('loaded')}
        onError={() => {
          log.warn('ui.preview.image.failed', { kind: 'image' });
          setState('failed');
        }}
      />
    </>
  );
}

export default function PreviewArea({
  section,
  project,
  onRefresh,
  onOpenLibrary,
  onQueued,
  refreshKey,
  onReuse = null,
}) {
  const [params, setParams] = useSearchParams();
  const [converting, setConverting] = useRouteToggle('convert');
  const selected = params.get('preview');
  const setSelected = (value) =>
    updateSearch(setParams, {
      preview: value,
      convert: null,
      refine: null,
      trashPreview: null,
      inspect: null,
    });
  const [confirmDelete, setConfirmDelete] = useRouteToggle('trashPreview');
  const [refining, setRefining] = useRouteToggle('refine');
  const [loadedMediaAspect, setLoadedMediaAspect] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [newSeed, setNewSeed] = useState(true);
  const [useImage, setUseImage] = useState(false);
  const assets = useMemo(
    () =>
      project?.assets.filter(
        (asset) =>
          matches(asset, section) &&
          (section !== 'vegetation' ||
            jobs.some(
              (job) =>
                job.type === 'vegetation' &&
                job.projectId === project.id &&
                job.status === 'completed' &&
                (job.output === asset.id || job.output === asset.sourceOutput),
            )) &&
          (section !== 'world' ||
            jobs.some(
              (job) =>
                job.type === 'world' &&
                job.projectId === project.id &&
                job.status === 'completed' &&
                (job.output === asset.id || job.output === asset.sourceOutput),
            )),
      ) || [],
    [project, section, jobs],
  );
  // Falls back to the first asset when the ?preview= id is missing or no longer in the project.
  const asset = assets.find((item) => item.id === selected) || assets[0];
  // Generated files are named forge-<id>; the stored prompt gives them a readable caption.
  const metaIndex = useAssetMetaIndex(
    project?.id,
    `${project?.assets?.length ?? 0}:${project?.updatedAt || ''}`,
  );
  const labelOf = (item) => friendlyAssetLabel(item, metaIndex[item.id]).label;
  const job = jobs.find(
    (item) =>
      item.projectId === project?.id &&
      item.status === 'completed' &&
      (item.type === section ||
        (section === 'motion' && item.type === 'motion-bricks') ||
        (section === '3d' && item.type === 'trellis')) &&
      (item.output === asset?.id || item.output === asset?.sourceOutput),
  );
  useEffect(() => {
    setMessage('');
    setUndo(null);
  }, [project?.id, section]);
  useEffect(() => {
    setMessage('');
  }, [asset?.id]);
  const mediaAspect =
    loadedMediaAspect && asset && loadedMediaAspect.assetId === asset.id
      ? loadedMediaAspect.aspect
      : 1.6;
  function recordMediaAspect(width, height) {
    if (width > 0 && height > 0) {
      setLoadedMediaAspect({
        assetId: asset.id,
        aspect: Math.min(2.4, Math.max(0.65, width / height)),
      });
    }
  }
  const jobPrompt = job
    ? job.request[
        job.type === 'music' ? 'style' : ['voices', 'drama3'].includes(job.type) ? 'text' : 'prompt'
      ] || ''
    : '';
  const hasJob = Boolean(job);
  useEffect(() => {
    if (refining && hasJob) {
      setPrompt(jobPrompt);
      setNewSeed(true);
      setUseImage(false);
    }
  }, [refining, hasJob, job?.id, jobPrompt]);
  useEffect(() => {
    let active = true;
    let latestRequest = 0;
    async function fetchJobs() {
      const request = ++latestRequest;
      try {
        // log-coverage: ignore -- /api requests are logged by the browser capture (http.request.failed).
        const response = await fetch('/api/runtime/jobs');
        if (!response.ok) {
          throw Error();
        }
        const jobsResponse = await response.json();
        if (active && request === latestRequest) {
          setJobs(jobsResponse.jobs || []);
        }
      } catch (error) {
        log.debug('ui.jobs.load.failed', { error });
        if (active && request === latestRequest) {
          setJobs([]);
        }
      }
    }
    log.debug('ui.jobs.poll.started');
    fetchJobs();
    const timer = setInterval(fetchJobs, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project?.id, refreshKey]);
  const endpoint = (action) => `/api/projects/${project.id}/assets/${action}`;
  async function change(action, body) {
    setBusy(true);
    setMessage('');
    try {
      const result = await post(endpoint(action), body);
      await onRefresh().catch((error) => {
        log.debug('ui.refresh.failed', { error });
      });
      return result;
    } catch (error) {
      log.warn('ui.asset.action.failed', { action, error });
      setMessage(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const result = await change('trash', { path: asset.id });
    if (result) {
      setUndo(result.trashId);
      setConfirmDelete(false);
      setMessage('Moved to this project’s trash.');
    }
  }
  async function restore() {
    const result = await change('restore', { trashId: undo });
    if (result) {
      setSelected(result.path);
      setUndo(null);
      setMessage('Asset restored.');
    }
  }
  function beginRefine() {
    const key =
      job.type === 'music' ? 'style' : ['voices', 'drama3'].includes(job.type) ? 'text' : 'prompt';
    setPrompt(job.request[key] || '');
    setNewSeed(true);
    setUseImage(false);
    setRefining(true);
    setMessage('');
  }
  async function rerun(e) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      // Masked to 31 bits so the seed is a non-negative 32-bit integer.
      const seed =
        newSeed && supportsNewSeed(job)
          ? crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff
          : undefined;
      let reference;
      if (useImage) {
        const staged = await post(`/api/projects/${project.id}/references/from-asset`, {
          path: asset.id,
        });
        reference = staged.reference.id;
      }
      const request = rerunRequest(job, prompt, { seed, reference });
      await post(
        '/api/runtime/jobs',
        { type: job.type, projectId: project.id, request },
        'runtime',
      );
      setRefining(false);
      setMessage('Added to the render queue.');
      onQueued?.();
    } catch (error) {
      log.warn('ui.rerun.failed', { jobType: job?.type, error });
      setMessage(`Could not queue render: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel iteration-panel" aria-label="Recent project outputs">
      <div className="panel-heading">
        <div>
          <span className="mini-label">IN THIS PROJECT</span>
          <h2>Recent creations</h2>
        </div>
        <Sparkles size={18} />
      </div>
      {!project ? (
        <div className="iteration-empty">
          <strong>Choose a project</strong>
          <p>Your recent creations will appear here.</p>
        </div>
      ) : !asset ? (
        <div className="iteration-empty">
          <strong>{section === 'game' ? 'No saved decisions yet' : 'Nothing here yet'}</strong>
          <p>
            {section === 'game'
              ? 'Run a decision and save its JSON to see it here.'
              : 'Assets in this project’s matching folder will appear here.'}
          </p>
        </div>
      ) : (
        <>
          <div
            className="iteration-media"
            style={{ '--iteration-aspect': mediaAspect }}
            onLoadCapture={(event) => {
              if (event.target.tagName === 'IMG') {
                recordMediaAspect(event.target.naturalWidth, event.target.naturalHeight);
              }
            }}
          >
            {asset.category === 'Images' || asset.category === 'Masks' ? (
              asset.name.toLowerCase().endsWith('.tga') ? (
                <AssetThumbnail asset={asset} project={project} />
              ) : (
                <PreviewImage src={asset.url} alt={labelOf(asset)} />
              )
            ) : asset.category === 'Video' ? (
              <video
                key={asset.url}
                src={asset.url}
                controls
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  recordMediaAspect(video.videoWidth, video.videoHeight);
                }}
              />
            ) : asset.category === 'Audio' ? (
              <div className="iteration-audio">
                <AudioLines size={32} />
                <audio key={asset.url} src={asset.url} controls preload="metadata" />
              </div>
            ) : asset.category === 'Text' ? (
              <TextAssetPreview key={asset.url} asset={{ ...asset, file: asset.url }} />
            ) : (
              <InteractiveAssetViewer key={asset.url} url={asset.url} name={asset.name} />
            )}
          </div>
          <div className="iteration-caption">
            <div>
              <strong title={asset.name}>{labelOf(asset)}</strong>
              <span title={asset.id}>{labelOf(asset) === asset.name ? asset.id : asset.name}</span>
            </div>
            {(asset.category === 'Video' || asset.category === 'Audio') && (
              <RepeatButton
                className="iteration-icon"
                scope=".iteration-panel"
                selector=".iteration-media video, .iteration-media audio"
              />
            )}
            {(asset.category === 'Video' || asset.category === 'Audio') && (
              <ShrinkButton
                className="iteration-icon"
                scope=".iteration-panel"
                selector=".iteration-media video, .iteration-media audio"
                kind={asset.category === 'Video' ? 'video' : 'audio'}
                url={asset.url}
                name={asset.name}
              />
            )}
            <a
              className="iteration-icon"
              href={asset.url}
              download={asset.name}
              aria-label={`Download ${labelOf(asset)}`}
              title="Download"
            >
              <ArrowDownToLine size={17} />
            </a>
          </div>
          {assets.length > 1 && (
            <div className="iteration-recent" aria-label="Recent assets">
              {assets.slice(0, 6).map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`Preview ${labelOf(item)}`}
                  aria-pressed={item.id === asset.id}
                  className={item.id === asset.id ? 'selected' : ''}
                  onClick={() => setSelected(item.id)}
                >
                  {isVisualAsset(item) ? (
                    <AssetThumbnail asset={item} project={project} />
                  ) : (
                    <span>{index + 1}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="iteration-actions">
            {canConvert(asset) && (
              <button className="outline-button" onClick={() => setConverting(!converting)}>
                <FileOutput size={15} /> Convert
              </button>
            )}
            <button
              className="outline-button"
              disabled={busy}
              aria-pressed={asset.kept}
              onClick={() => change('metadata', { path: asset.id, kept: !asset.kept })}
            >
              <Check size={15} /> {asset.kept ? 'Kept' : 'Keep'}
            </button>
            {job && section !== 'vegetation' && (
              <button className="outline-button" disabled={busy} onClick={beginRefine}>
                <RotateCcw size={15} /> Rerun / refine
              </button>
            )}
            <button
              className="outline-button iteration-delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} /> Delete
            </button>
          </div>
          {section === 'music' && (
            <MusicDerive project={project} asset={asset} onQueued={() => onQueued?.()} />
          )}
          {converting && (
            <AssetConverter
              asset={asset}
              project={project}
              onSaved={async () => {
                setSelected(asset.id);
                await onRefresh();
              }}
              onClose={() => setConverting(false)}
            />
          )}
          <div className="iteration-rating">
            <span>Rate this asset</span>
            <div role="group" aria-label="Asset rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  type="button"
                  key={n}
                  disabled={busy}
                  aria-label={`Rate ${n} out of 5`}
                  aria-pressed={asset.rating === n}
                  onClick={() =>
                    change('metadata', { path: asset.id, rating: asset.rating === n ? null : n })
                  }
                >
                  <Star size={19} fill={n <= (asset.rating || 0) ? 'currentColor' : 'none'} />
                </button>
              ))}
            </div>
          </div>
          <GenerationDetails compact project={project} asset={asset} onReuse={onReuse} />
          {!job && (
            <p className="iteration-hint">
              {section === 'game'
                ? 'Run another decision above to iterate.'
                : 'Rerun is available when the original render settings are in the queue history.'}
            </p>
          )}
          {confirmDelete && (
            <div className="iteration-confirm">
              <strong>Move this asset to project trash?</strong>
              <p>You can undo this here. The file is kept in the project’s hidden trash folder.</p>
              <div>
                <button className="ghost-button" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button
                  className="outline-button iteration-delete"
                  disabled={busy}
                  onClick={remove}
                >
                  Move to trash
                </button>
              </div>
            </div>
          )}
          {refining && job && (
            <form className="iteration-refine" onSubmit={rerun}>
              {!['3d', 'trellis', 'motion-bricks'].includes(job.type) &&
                !isDerivedMusic(job) &&
                !(
                  job.type === 'world' &&
                  (job.request.model === 'hy-world' || job.request.mode === 'panorama')
                ) && (
                  <>
                    <label htmlFor="iteration-prompt">
                      {['voices', 'drama3'].includes(job.type)
                        ? 'Voice text'
                        : job.type === 'music'
                          ? 'Music style'
                          : 'Description'}
                    </label>
                    <textarea
                      id="iteration-prompt"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      required={job.type !== 'world' || job.request.mode === 'text'}
                    />
                  </>
                )}
              {supportsNewSeed(job) && (
                <label className="iteration-check">
                  <input
                    type="checkbox"
                    checked={newSeed}
                    onChange={(e) => setNewSeed(e.target.checked)}
                  />{' '}
                  Use a new random seed
                </label>
              )}
              {job.type === 'images' && (job.request.references || []).length < 10 && (
                <label className="iteration-check">
                  <input
                    type="checkbox"
                    checked={useImage}
                    onChange={(e) => setUseImage(e.target.checked)}
                  />{' '}
                  Add this image as a reference
                </label>
              )}
              <p>
                Other settings and original references are reused.
                {job.type === 'motion-bricks' ? ' MotionBricks controls the variation.' : ''}
                {job.type === 'video' ? ' The video engine controls the seed.' : ''}
                {isDerivedMusic(job)
                  ? ' The style and lyrics come from the track this one continues.'
                  : ''}
              </p>
              <div>
                <button type="button" className="ghost-button" onClick={() => setRefining(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  Add to queue
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {(message || undo) && (
        <div className="iteration-message" role="status">
          <span>{message}</span>
          {undo && (
            <button onClick={restore} disabled={busy}>
              Undo
            </button>
          )}
        </div>
      )}
      <button className="iteration-library" onClick={onOpenLibrary}>
        Open asset library <ArrowRight size={15} />
      </button>
    </section>
  );
}
