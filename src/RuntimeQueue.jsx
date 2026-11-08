import { useRouteToggle } from './useNav';
import useDialogFocus from './useDialogFocus';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Check, CircleAlert, Copy, EyeOff, ListMusic, RefreshCw, X, Zap } from 'lucide-react';
import { audioPayload } from './audio-payload';
import {
  imageRequest,
  imageVariationCount,
  variationRequests,
  videoRequest,
} from './imageVideoInputs';
import { friendlyAssetName, jobHint } from './job-hints.js';
import { matchSummary, segmentationSettings } from './segmentation-settings.js';
import { chainHint, isChained, isWaitingForReference, waitingDependents } from './queue-chain.js';
import './queue-chain.css';
import './queue-groups.css';
import {
  DISMISSIBLE_STATUSES,
  buildQueueGroups,
  jobAccessibleName,
  jobTitle,
} from './queue-groups.js';
import { getVideoFrames } from './video-media-store';
import { hunyuanShapeRequest } from './hunyuan-settings.js';
import { trellisRequest } from './trellis-settings.js';
import { hyMotionRequest, hyMotionVariationCount } from './hymotion-settings.js';
import { motionBricksRequest } from './motionbricks-settings.js';
import { QueueTimingSummary, useQueueTiming } from './QueueTiming';
import { formatDuration } from './queue-timing.js';
import useQueueReorder from './use-queue-reorder.js';
import {
  QueuePosition,
  QueueReorderControls,
  QueueReorderNotes,
  reorderRowClass,
} from './QueueReorderControls.jsx';

export async function post(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error || 'Request failed.');
    error.status = response.status;
    error.body = result;
    throw error;
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
          This cancels eligible waiting renders in every project. Running and uncertain jobs
          continue; completed assets stay.
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
    return {
      type,
      projectId,
      request: {
        prompt: draft.prompt,
        references: draft.referenceIds || ['00000000-0000-0000-0000-000000000000.png'],
        ...segmentationSettings(draft),
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
export async function stageReferences(projectId, files) {
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
  // Validate before saving references; the staged IDs only exist afterwards.
  imageRequest({ ...draft, referenceIds: files.map((file) => file.name) });
  const count = imageVariationCount(draft);
  const queued = payload('images', projectId, {
    ...draft,
    referenceIds: await stageReferences(projectId, files),
  });
  // Variations are sibling jobs that differ only in seed, queued one after another.
  const jobs = [];
  for (const request of variationRequests(queued.request, count)) {
    try {
      jobs.push(await post('/api/runtime/jobs', { ...queued, request }));
    } catch (error) {
      error.message = jobs.length
        ? `Queued ${jobs.length} of ${count} variations, then: ${error.message}`
        : error.message;
      throw error;
    }
  }
  return count === 1 ? jobs[0] : jobs;
}
// Reference videos and audio are copied from the project's own assets (by path), not uploaded.
async function stageClips(projectId, clips) {
  const ids = [];
  for (const clip of clips) {
    const response = await fetch(`/api/projects/${projectId}/clips/from-asset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
      body: JSON.stringify({ path: clip.path }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw Error(result.error || 'Could not save the reference clip.');
    }
    ids.push(result.reference.id);
  }
  return ids;
}
export async function enqueueVideo(projectId, draft, files) {
  // Validate before saving anything; the staged IDs only exist afterwards.
  videoRequest(draft);
  const source = ['frames', 'text'].includes(draft.videoSource) ? draft.videoSource : 'references';
  const { first, last } = getVideoFrames();
  const frames = source === 'frames' ? [first, last].filter(Boolean) : [];
  if (source === 'frames' && !first) {
    throw Error('Choose the first frame again before queuing.');
  }
  if (source === 'frames' && draft.videoLastFrame && !last) {
    throw Error('Choose the last frame again before queuing.');
  }
  const [firstFrameId, lastFrameId] = await stageReferences(projectId, frames);
  const referenceIds = await stageReferences(projectId, source === 'references' ? files : []);
  const clipIds = await stageClips(
    projectId,
    source === 'references' ? draft.videoClips || [] : [],
  );
  const audioIds = await stageClips(
    projectId,
    source === 'references' ? draft.videoAudios || [] : [],
  );
  return post(
    '/api/runtime/jobs',
    payload('video', projectId, {
      ...draft,
      referenceIds,
      firstFrameId,
      lastFrameId,
      clipIds,
      audioIds,
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
const MAX_ENGINE_SEED = 2147483647;

export async function enqueueMotion(projectId, draft) {
  hyMotionRequest(draft);
  const count = hyMotionVariationCount(draft);
  const hasSeed = draft.seed !== '' && draft.seed !== undefined;
  if (hasSeed && Number(draft.seed) + count - 1 > MAX_ENGINE_SEED) {
    const largestFirstSeed = MAX_ENGINE_SEED - count + 1;
    throw Error(`With ${count} variations, the seed must be at most ${largestFirstSeed}.`);
  }
  // Variations take consecutive seeds, so a random first seed leaves room for the last one.
  const firstSeed = hasSeed
    ? Number(draft.seed)
    : crypto.getRandomValues(new Uint32Array(1))[0] % (MAX_ENGINE_SEED - count + 2);
  const queued = [];
  for (let position = 0; position < count; position += 1) {
    try {
      queued.push(
        await post(
          '/api/runtime/jobs',
          payload('motion', projectId, { ...draft, seed: firstSeed + position }),
        ),
      );
    } catch (error) {
      if (queued.length === 0) {
        throw error;
      }
      throw Error(`Queued ${queued.length} of ${count} motion clips, then: ${error.message}`, {
        cause: error,
      });
    }
  }
  return queued;
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
    // Estimates never save files: stand-in ids are enough to validate the settings.
    ...(type === 'video' && draft.videoSource === 'frames'
      ? {
          firstFrameId: '00000000-0000-0000-0000-000000000000.png',
          lastFrameId: draft.videoLastFrame
            ? '00000000-0000-0000-0000-000000000000.png'
            : undefined,
        }
      : {}),
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
// What to call a finished file in the queue when its name is only a generated ID.
const outputNouns = {
  images: 'image',
  music: 'track',
  sfx: 'sound',
  voices: 'voice',
  video: 'video',
  segmentation: 'cutout',
  '3d': 'model',
  trellis: 'model',
};
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
  const {
    jobs,
    error: queueError,
    forecast,
    refresh,
    hiddenIds,
    hideCurrent,
    hideJobs,
    showJobs,
    showHidden,
    applyQueueOrder,
    restoreJobs,
  } = useQueueTiming();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [copied, setCopied] = useState('');
  // Sections whose "Show more" is open, and the last dismissal (kept so it can be undone).
  const [openGroups, setOpenGroups] = useState({});
  const [dismissal, setDismissal] = useState(null);
  const listRef = useRef(null);
  // Where keyboard focus goes once the dismissed row has left the list.
  const focusAfterDismiss = useRef(null);
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
        vegetation: 'SeedThree',
      }[job.type] || 'the engine';
    if (
      kind === 'resolve' &&
      !window.confirm(
        `Check ${engine}'s queue and history${job.remoteId ? ` for job ${job.remoteId}` : ''} first. Confirm that it is no longer running. Forge will mark this render cancelled and may unblock the queue. Continue?`,
      )
    ) {
      return;
    }
    setError('');
    setNotice('');
    setBusy(job.id);
    try {
      await post(
        `/api/runtime/jobs/${job.id}/${kind}`,
        kind === 'resolve' ? { confirmRemoteNotRunning: true } : {},
      );
      await refresh();
      setNotice(
        kind === 'resolve'
          ? 'Interrupted render marked cancelled.'
          : `Render ${kind === 'retry' ? 'retried' : 'cancelled'}.`,
      );
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
  const visible = jobs.filter((job) => !hiddenIds.includes(job.id));
  // Renders that wait for an earlier render are listed directly under it.
  const { groups, nested: nestedIds } = buildQueueGroups(visible, { expanded });
  const countOf = (id) => groups.find((group) => group.id === id).items.length;
  const reorder = useQueueReorder({
    jobs,
    items: groups.find((group) => group.id === 'waiting').items,
    post,
    applyOrder: applyQueueOrder,
    restoreJobs,
    refresh,
  });
  const shownItems = (group) => {
    const rows = group.id === 'waiting' ? reorder.orderedItems(group.items) : group.items;
    return openGroups[group.id] ? rows : rows.slice(0, group.limit);
  };
  function dismissJobs(list, group) {
    if (!list.length) {
      return;
    }
    const ids = list.map((job) => job.id);
    // Keep keyboard focus in the list: the next row, else the one before it, else the heading.
    const shown = shownItems(group);
    const remaining = shown.filter((job) => !ids.includes(job.id));
    const position = shown.findIndex((job) => ids.includes(job.id));
    const neighbour = remaining[position] || remaining[position - 1] || null;
    focusAfterDismiss.current = neighbour ? neighbour.id : `group:${group.id}`;
    hideJobs(ids);
    const label =
      list.length === 1
        ? `Dismissed “${jobAccessibleName(list[0])}”.`
        : `Dismissed ${list.length} ${group.noun || 'renders'}.`;
    setDismissal({ ids, label });
    setNotice('');
  }
  function undoDismissal() {
    if (!dismissal) {
      return;
    }
    showJobs(dismissal.ids);
    setNotice(
      dismissal.ids.length === 1
        ? 'Render shown again.'
        : `${dismissal.ids.length} renders shown again.`,
    );
    setDismissal(null);
  }
  useEffect(() => {
    const target = focusAfterDismiss.current;
    if (!target) {
      return;
    }
    focusAfterDismiss.current = null;
    const list = listRef.current;
    if (!list) {
      return;
    }
    const button = [...list.querySelectorAll('[data-dismiss-for]')].find(
      (element) => element.dataset.dismissFor === target,
    );
    const heading = list.querySelector(`[data-group-heading="${target.replace('group:', '')}"]`);
    // Fall back to the list itself when the whole section is gone.
    (button || heading || list).focus();
  }, [hiddenIds]);
  const renderJob = (job, group) => (
    <article
      className={
        'runtime-job' +
        (isChained(job) ? ' runtime-job-linked' : '') +
        (nestedIds.has(job.id) ? ' runtime-job-chained' : '') +
        (job.status === 'failed' ? ' runtime-job-failed' : '') +
        (group.id === 'waiting' ? reorderRowClass(job, reorder) : '')
      }
      key={job.id}
      data-job-id={job.id}
    >
      <div className="runtime-job-content">
        <div className="runtime-job-top">
          {group.id === 'waiting' && <QueuePosition job={job} reorder={reorder} />}
          <span className={'render-status ' + job.status}>
            {job.status === 'queued' && isWaitingForReference(job)
              ? 'waiting for earlier render'
              : job.status.replaceAll('_', ' ')}
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
              vegetation: 'Vegetation',
              segmentation: 'Segmentation',
            }[job.type] || job.type}
          </span>
        </div>
        <strong
          title={job.request.title || job.request.style || job.request.prompt || job.request.text}
        >
          {jobTitle(job)}
        </strong>
        <small>
          {projects.find((project) => project.id === job.projectId)?.name || 'Project'}
          {job.stage ? ` · ${job.stage}` : ''}
        </small>
        {jobHint(job) && <small className="runtime-job-hint">{jobHint(job)}</small>}
        {chainHint(job, jobs) && (
          <small className="runtime-job-chain-hint">{chainHint(job, jobs)}</small>
        )}
        <JobTiming job={job} timing={forecast.perJob[job.id]} />
        {matchSummary(job) && <small className="runtime-job-hint">{matchSummary(job)}</small>}
        {job.output && (
          <small title={job.output}>
            Saved as{' '}
            {friendlyAssetName(
              job.output,
              job.type === 'segmentation' && ['mask', 'outline'].includes(job.request?.output)
                ? job.request.output
                : outputNouns[job.type] || 'file',
            )}
          </small>
        )}
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
        {group.id === 'waiting' && (
          <QueueReorderControls
            job={job}
            rows={reorder.orderedItems(group.items)}
            reorder={reorder}
          />
        )}
        {['queued', 'waiting_engine', 'waiting_memory', 'needs_attention'].includes(job.status) && (
          <button
            disabled={busy === job.id}
            className="icon-outline"
            aria-label={`Cancel ${jobAccessibleName(job)}`}
            title={
              waitingDependents(job, jobs).length
                ? `Also cancels ${waitingDependents(job, jobs).length} waiting render(s) that use its result.`
                : undefined
            }
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
            aria-label={`Retry ${jobAccessibleName(job)}`}
            onClick={() => action(job, 'retry')}
          >
            <RefreshCw size={14} />
            Retry
          </button>
        )}
        {DISMISSIBLE_STATUSES.includes(job.status) && (
          <button
            className="icon-outline queue-dismiss"
            data-dismiss-for={job.id}
            aria-label={`Dismiss ${jobAccessibleName(job)}`}
            title="Hide this row. It stays in the render history and can be shown again."
            onClick={() => dismissJobs([job], group)}
          >
            <EyeOff size={14} aria-hidden="true" />
            Dismiss
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
          <>
            <small className="runtime-job-review-note">
              Check the engine’s queue and history first. Forge cannot verify whether this
              interrupted render is still running.
            </small>
            <button
              disabled={busy === job.id}
              className="icon-outline"
              onClick={() => action(job, 'resolve')}
            >
              <CircleAlert size={14} />
              Mark cancelled after checking…
            </button>
          </>
        )}
      </div>
    </article>
  );
  const hiddenCount = jobs.filter((job) => hiddenIds.includes(job.id)).length;
  const activeCount = jobs.filter(
    (job) =>
      !hiddenIds.includes(job.id) && !['completed', 'failed', 'cancelled'].includes(job.status),
  ).length;
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
          <h2>
            Render queue
            {activeCount > 0 && (
              <span className="queue-count-chip" aria-label={`${activeCount} active or waiting`}>
                {activeCount}
              </span>
            )}
          </h2>
          <p className="queue-intro">One render at a time, started when its model is ready.</p>
          <p className="queue-summary" role="status">
            {countOf('processing')} processing · {countOf('waiting')} waiting ·{' '}
            {countOf('attention')} need attention
            {countOf('failed') > 0 && ` · ${countOf('failed')} failed`}
          </p>
        </div>
        <button className="icon-btn" aria-label="Refresh render queue" onClick={refresh}>
          <RefreshCw size={17} />
        </button>
      </div>
      {(jobs.length > 0 || queueError) && <QueueTimingSummary />}
      {jobs.length > 0 && (
        <details className="queue-manage-menu">
          <summary>Manage queue</summary>
          <p className="queue-manage-note queue-scope-note">
            Clear cancels waiting renders in every project; running and uncertain jobs continue.
            Hiding rows only changes this view.
          </p>
          <div className="queue-manage">
            <button
              className="icon-outline"
              onClick={hideCurrent}
              disabled={hiddenCount === jobs.length}
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
              title={waiting ? undefined : 'There are no waiting renders to cancel.'}
            >
              Clear waiting renders…
            </button>
          </div>
        </details>
      )}
      {dismissal && (
        <p className="queue-manage-note queue-dismissal" role="status">
          {dismissal.label}{' '}
          <button type="button" className="text-action" onClick={undoDismissal}>
            Undo
          </button>
        </p>
      )}
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
              : queueError
                ? 'The render queue could not be loaded. Refresh to try again.'
                : 'No renders yet. Queue one and its progress will show up here.'}
          </span>
        </div>
      ) : (
        <div
          ref={listRef}
          className="runtime-job-list"
          role="region"
          aria-label="Render jobs"
          tabIndex={0}
        >
          {groups.map((group) => {
            if (!group.items.length && !group.always) {
              return null;
            }
            const shown = shownItems(group);
            const hiddenRows = group.items.length - shown.length;
            const isOpen = Boolean(openGroups[group.id]);
            return (
              <section
                key={group.id}
                className={'queue-group queue-group-' + group.id}
                aria-labelledby={'queue-group-' + group.id}
              >
                <div className="queue-group-heading">
                  <h3 id={'queue-group-' + group.id} data-group-heading={group.id} tabIndex={-1}>
                    {group.title}{' '}
                    <span
                      className="queue-group-count"
                      aria-label={`${group.items.length} ${group.items.length === 1 ? 'render' : 'renders'}`}
                    >
                      {group.items.length}
                    </span>
                  </h3>
                  {group.id === 'failed' && group.items.length > 1 && (
                    <button
                      type="button"
                      className="text-action queue-dismiss-all"
                      aria-label={`Dismiss all ${group.items.length} failed renders`}
                      onClick={() => dismissJobs(group.items, group)}
                    >
                      Dismiss all
                    </button>
                  )}
                </div>
                {group.note && group.items.length > 0 && (
                  <p className="queue-group-note">{group.note}</p>
                )}
                {group.id === 'waiting' && <QueueReorderNotes reorder={reorder} />}
                {group.items.length ? (
                  shown.map((job) => renderJob(job, group))
                ) : (
                  <p className="queue-group-empty">{group.empty}</p>
                )}
                {group.items.length > group.limit && (
                  <button
                    type="button"
                    className="text-action queue-group-more"
                    aria-expanded={isOpen}
                    onClick={() => setOpenGroups((open) => ({ ...open, [group.id]: !isOpen }))}
                  >
                    {isOpen ? `Show fewer ${group.noun}` : `Show ${hiddenRows} more ${group.noun}`}
                  </button>
                )}
              </section>
            );
          })}
          {hiddenCount > 0 && (
            <p className="queue-hidden-note">
              {hiddenCount} {hiddenCount === 1 ? 'render is' : 'renders are'} hidden in this
              browser.{' '}
              <button type="button" className="text-action" onClick={showHidden}>
                Show hidden
              </button>
            </p>
          )}
        </div>
      )}
      {!expanded && jobs.length > 0 && (
        <Link className="queue-all-link" to="/queue">
          Open the full render queue <span aria-hidden="true">→</span>
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
