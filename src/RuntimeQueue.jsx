import { useRouteToggle } from './useNav';
import useDialogFocus from './useDialogFocus';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Check, CircleAlert, Copy, ListMusic, RefreshCw, X, Zap } from 'lucide-react';
import { audioPayload } from './audio-payload';
import { imageRequest, videoRequest } from './imageVideoInputs';
import { hunyuanShapeRequest } from './hunyuan-settings.js';
import { trellisRequest } from './trellis-settings.js';
import { hyMotionRequest } from './hymotion-settings.js';
import { motionBricksRequest } from './motionbricks-settings.js';
import { QueueTimingSummary, useQueueTiming } from './QueueTiming';
import { formatDuration } from './queue-timing.js';

export async function post(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || 'Request failed.');
  }
  return result;
}

function ClearQueueDialog({ error, confirmation, setConfirmation, busy, onClose, onConfirm }) {
  const dialog = useDialogFocus({ onClose, initialFocus: 'input' });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialog}
        className="queue-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-confirm-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="queue-confirm-title">Clear waiting renders?</h2>
        <p>
          This cancels all eligible waiting renders across all projects. Running and uncertain jobs
          continue and completed assets are kept.
        </p>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <label>
          Type CLEAR to confirm
          <input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div>
          <button className="icon-outline" onClick={onClose}>
            Keep queue
          </button>
          <button
            className="queue-danger"
            disabled={confirmation !== 'CLEAR' || busy === 'clear'}
            onClick={onConfirm}
          >
            Cancel waiting renders
          </button>
        </div>
      </div>
    </div>
  );
}
function payload(type, projectId, draft) {
  if (type === '3d') {
    return { type, projectId, request: hunyuanShapeRequest(draft) };
  }
  if (type === 'trellis') {
    return { type, projectId, request: trellisRequest(draft) };
  }
  if (type === 'motion') {
    return { type, projectId, request: hyMotionRequest(draft) };
  }
  if (type === 'motion-bricks') {
    return { type, projectId, request: motionBricksRequest(draft, draft.poseId) };
  }
  if (type === 'segmentation') {
    const confidence =
      draft.confidence === '' || draft.confidence === undefined ? 0.5 : Number(draft.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw Error('Confidence must be between 0 and 1.');
    }
    return {
      type,
      projectId,
      request: {
        prompt: draft.prompt,
        references: draft.referenceIds || ['00000000-0000-0000-0000-000000000000.png'],
        output: draft.options?.[1] === 'Mask PNG' ? 'mask' : 'transparent',
        confidence,
      },
    };
  }
  if (['voices', 'music', 'sfx'].includes(type)) {
    return audioPayload(type, projectId, draft);
  }
  if (type === 'video') {
    return { type, projectId, request: videoRequest(draft) };
  }
  return { type, projectId, request: imageRequest(draft) };
}
export const enqueueMusic = (projectId, draft) =>
  post('/api/runtime/jobs', payload('music', projectId, draft));
export const enqueueSound = (projectId, draft) =>
  post('/api/runtime/jobs', payload('sfx', projectId, draft));
export const enqueueVoice = (projectId, draft) =>
  post('/api/runtime/jobs', payload('voices', projectId, draft));
async function stageReferences(projectId, files) {
  const referenceIds = [];
  for (const file of files) {
    const response = await fetch(`/api/projects/${projectId}/references`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Forge-Request': 'project',
      },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) {
      throw Error(result.error || 'Could not save reference image.');
    }
    referenceIds.push(result.reference.id);
  }
  return referenceIds;
}
export async function enqueueImage(projectId, draft, files = []) {
  imageRequest(draft);
  return post(
    '/api/runtime/jobs',
    payload('images', projectId, {
      ...draft,
      referenceIds: await stageReferences(projectId, files),
    }),
  );
}
export async function enqueueVideo(projectId, draft, files) {
  videoRequest(draft);
  return post(
    '/api/runtime/jobs',
    payload('video', projectId, {
      ...draft,
      referenceIds: await stageReferences(projectId, files),
    }),
  );
}
export async function enqueueHunyuan(projectId, draft, file) {
  hunyuanShapeRequest(draft);
  const referenceIds = await stageReferences(projectId, [file]);
  const seed =
    draft.seed !== '' && draft.seed !== undefined
      ? draft.seed
      : crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  return post('/api/runtime/jobs', payload('3d', projectId, { ...draft, seed, referenceIds }));
}
export async function enqueueTrellis(projectId, draft, file) {
  trellisRequest(draft);
  if (!/\.(png|webp)$/i.test(file.name)) {
    throw Error('Choose a transparent PNG or WebP image.');
  }
  const referenceIds = await stageReferences(projectId, [file]);
  const seed =
    draft.seed !== '' && draft.seed !== undefined
      ? draft.seed
      : crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  return post('/api/runtime/jobs', payload('trellis', projectId, { ...draft, seed, referenceIds }));
}
export async function enqueueSegmentation(projectId, draft, file) {
  payload('segmentation', projectId, draft);
  const referenceIds = await stageReferences(projectId, [file]);
  return post('/api/runtime/jobs', payload('segmentation', projectId, { ...draft, referenceIds }));
}
export function enqueueMotion(projectId, draft) {
  hyMotionRequest(draft);
  const seed =
    draft.seed !== '' && draft.seed !== undefined
      ? draft.seed
      : crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  return post('/api/runtime/jobs', payload('motion', projectId, { ...draft, seed }));
}
export async function enqueueMotionBricks(projectId, draft, file) {
  motionBricksRequest(draft);
  const response = await fetch(`/api/projects/${projectId}/poses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Forge-Request': 'project' },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || 'Could not save the pose file.');
  }
  return post(
    '/api/runtime/jobs',
    payload('motion-bricks', projectId, { ...draft, poseId: result.reference.id }),
  );
}
export const estimatePayload = (type, projectId, draft) =>
  payload(type, projectId, {
    ...draft,
    prompt: type === 'voices' ? draft.prompt || 'estimate' : 'estimate',
    second: type === 'voices' ? draft.second || '' : '[Instrumental]',
    seed: '',
    ...(['images', 'video'].includes(type)
      ? {
          referenceIds: Array.from(
            {
              length:
                type === 'video'
                  ? Math.max(1, Math.min(draft.refs?.length || 0, 9))
                  : Math.min(draft.refs?.length || 0, 10),
            },
            () => '00000000-0000-0000-0000-000000000000.png',
          ),
        }
      : {}),
  });
export const estimateRender = (type, projectId, draft) =>
  post('/api/runtime/estimate', estimatePayload(type, projectId, draft));
function JobTiming({ job, timing }) {
  if (!timing) {
    return null;
  }
  const estimate = timing.estimate;
  return (
    <div className="runtime-job-timing">
      {job.status === 'queued' &&
        (timing.waitSeconds === 0 ? (
          <span>Starts next</span>
        ) : timing.waitSeconds !== null ? (
          <span>Starts in ~{formatDuration(timing.waitSeconds)}</span>
        ) : (
          <span>Start time unknown{timing.reason ? ` · ${timing.reason}` : ''}</span>
        ))}
      {['running', 'finalizing'].includes(job.status) && timing.remainingSeconds !== null && (
        <span>~{formatDuration(timing.remainingSeconds)} remaining</span>
      )}
      {estimate?.available ? (
        <span>
          {estimate.confidence === 'rough' ? 'Rough total' : 'Typical total'} ~
          {formatDuration(estimate.typicalSeconds)}
        </span>
      ) : (
        <span>Render time not yet estimated</span>
      )}
    </div>
  );
}
export default function RuntimeQueue({ refreshKey, projects = [], expanded = false }) {
  const [searchParams] = useSearchParams();
  const {
    jobs,
    error: queueError,
    forecast,
    refresh,
    hiddenIds,
    hideCurrent,
    showHidden,
  } = useQueueTiming();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [copied, setCopied] = useState('');
  const [confirmClear, setConfirmClear] = useRouteToggle('clearQueue');
  const [confirmation, setConfirmation] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!confirmClear) {
      setConfirmation('');
    }
  }, [confirmClear]);
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);
  async function action(job, kind) {
    const engine =
      {
        music: 'YuE2',
        sfx: 'Stable Audio Lab',
        images: 'Qwen Image Studio',
        video: 'H3 Studio',
        voices: 'Qwen3-TTS',
        '3d': 'Hunyuan3D',
        trellis: 'TRELLIS.2',
        segmentation: 'SAM 3.1',
        motion: 'HY-Motion',
        'motion-bricks': 'MotionBricks',
        world: 'World generation',
      }[job.type] || 'the engine';
    if (
      kind === 'resolve' &&
      !window.confirm(
        `Check ${engine}'s queue and history first. Confirm that this job is no longer running before resolving it here. Continue?`,
      )
    ) {
      return;
    }
    setBusy(job.id);
    try {
      await post(
        `/api/runtime/jobs/${job.id}/${kind}`,
        kind === 'resolve' ? { confirmRemoteNotRunning: true } : {},
      );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  async function copyError(job) {
    try {
      await navigator.clipboard.writeText(
        `${job.type} render ${job.id}\n${job.stage || job.status}\n${job.error}`,
      );
      setCopied(job.id);
      setTimeout(() => setCopied(''), 2500);
    } catch {
      setError('Could not copy the error. Select its text and copy it instead.');
    }
  }
  const visible = jobs.filter((job) => !hiddenIds.includes(job.id)).slice(0, expanded ? 200 : 8);
  const hiddenCount = jobs.filter((job) => hiddenIds.includes(job.id)).length;
  const waiting = jobs.filter(
    (job) => ['queued', 'waiting_engine', 'waiting_memory'].includes(job.status) && !job.remoteId,
  ).length;
  async function clearWaiting() {
    if (confirmation !== 'CLEAR') {
      return;
    }
    setBusy('clear');
    setError('');
    try {
      const result = await post('/api/runtime/jobs/clear-waiting', {
        confirmation: 'cancel-waiting-renders',
      });
      setNotice(
        `${result.cancelled} waiting ${result.cancelled === 1 ? 'render' : 'renders'} cancelled.`,
      );
      setConfirmClear(false);
      setConfirmation('');
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel runtime-queue">
      <div className="panel-heading">
        <div>
          <h2>Render queue</h2>
          <p className="queue-intro">
            One render at a time. Forge starts models as needed and makes room when it can.
          </p>
        </div>
        <button className="icon-btn" aria-label="Refresh render queue" onClick={refresh}>
          <RefreshCw size={17} />
        </button>
      </div>
      <QueueTimingSummary />
      <div className="queue-manage">
        <button
          className="icon-outline"
          onClick={hideCurrent}
          disabled={!jobs.length || hiddenCount === jobs.length}
        >
          Hide current rows
        </button>
        {hiddenCount > 0 && (
          <button className="icon-outline" onClick={showHidden}>
            Show hidden ({hiddenCount})
          </button>
        )}
        <button
          className="icon-outline queue-clear"
          onClick={() => {
            setError('');
            setConfirmation('');
            setConfirmClear(true);
          }}
          disabled={!waiting}
        >
          Clear waiting renders…
        </button>
      </div>
      <p className="queue-manage-note">
        Hidden rows continue running. Clearing cancels waiting renders across all projects; active
        and uncertain jobs remain.
      </p>
      {notice && (
        <p className="queue-manage-note" role="status">
          {notice}
        </p>
      )}
      {(error || queueError) && (
        <p className="settings-error" role="alert">
          {error || queueError}
        </p>
      )}
      {!visible.length ? (
        <div className="runtime-queue-empty">
          <ListMusic size={19} />
          <span>
            {hiddenCount
              ? 'Current rows are hidden in this browser. Renders continue in the background.'
              : 'No render jobs yet. Add a render to get started.'}
          </span>
        </div>
      ) : (
        <div className="runtime-job-list" role="region" aria-label="Render jobs" tabIndex={0}>
          {visible.map((job) => (
            <article className="runtime-job" key={job.id}>
              <div className="runtime-job-content">
                <div className="runtime-job-top">
                  <span className={'render-status ' + job.status}>
                    {job.status.replaceAll('_', ' ')}
                  </span>
                  <span>
                    {{
                      sfx: 'Sound effect',
                      music: 'Music',
                      images: 'Image',
                      video: 'Video',
                      voices: 'Voice',
                      '3d': '3D shape',
                      trellis: '3D model',
                      motion: 'Motion',
                      'motion-bricks': 'Motion transition',
                      world: 'World',
                    }[job.type] || job.type}
                  </span>
                </div>
                <strong>
                  {job.type === 'world' && job.request.model === 'hy-world'
                    ? 'HY-World reconstruction'
                    : job.request.title ||
                      job.request.style ||
                      job.request.prompt ||
                      job.request.text ||
                      (job.type === '3d'
                        ? 'Hunyuan 3D shape'
                        : job.type === 'trellis'
                          ? 'TRELLIS.2 3D model'
                          : job.type === 'motion-bricks'
                            ? 'SOMA pose transition'
                            : job.type === 'world'
                              ? job.request.model === 'hy-world'
                                ? 'HY-World reconstruction'
                                : 'WorldGen scene'
                              : '')}
                </strong>
                <small>
                  {projects.find((project) => project.id === job.projectId)?.name || 'Project'}
                  {job.stage ? ` · ${job.stage}` : ''}
                </small>
                <JobTiming job={job} timing={forecast.perJob[job.id]} />
                {job.output && <small>{job.output}</small>}
                {job.error && (
                  <div className="runtime-job-error">
                    <CircleAlert size={15} />
                    <span>{job.error}</span>
                    <button
                      className="copy-render-error"
                      aria-label="Copy render error"
                      title="Copy error"
                      onClick={() => copyError(job)}
                    >
                      {copied === job.id ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                  </div>
                )}
              </div>
              <div className="runtime-job-actions">
                {['queued', 'waiting_engine', 'waiting_memory', 'needs_attention'].includes(
                  job.status,
                ) && (
                  <button
                    disabled={busy === job.id}
                    className="icon-outline"
                    onClick={() => action(job, 'cancel')}
                  >
                    <X size={14} />
                    Cancel
                  </button>
                )}
                {['failed', 'needs_attention'].includes(job.status) && (
                  <button
                    disabled={busy === job.id}
                    className="icon-outline"
                    onClick={() => action(job, 'retry')}
                  >
                    <RefreshCw size={14} />
                    Retry
                  </button>
                )}
                {job.status === 'waiting_memory' && job.details && !job.details.autoManaging && (
                  <button
                    className="icon-outline"
                    onClick={() =>
                      window.dispatchEvent(new CustomEvent('forge:memory-alert', { detail: job }))
                    }
                  >
                    <Zap size={14} />
                    Free memory
                  </button>
                )}
                {job.status === 'interrupted' && (
                  <button
                    disabled={busy === job.id}
                    className="icon-outline"
                    onClick={() => action(job, 'resolve')}
                  >
                    <CircleAlert size={14} />
                    Review status…
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!expanded && jobs.length > 0 && (
        <Link
          className="queue-all-link"
          to={{
            pathname: '/assets',
            search: `?${new URLSearchParams({ queue: '1', ...(searchParams.get('project') ? { project: searchParams.get('project') } : {}) })}`,
          }}
        >
          View full render queue <span aria-hidden="true">→</span>
        </Link>
      )}
      {confirmClear && (
        <ClearQueueDialog
          error={error}
          confirmation={confirmation}
          setConfirmation={setConfirmation}
          busy={busy}
          onClose={() => setConfirmClear(false)}
          onConfirm={clearWaiting}
        />
      )}
    </section>
  );
}
