import { useRouteToggle } from './useNav';
import { useT } from './i18n/index.js';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Check,
  CircleAlert,
  Copy,
  EyeOff,
  ListMusic,
  RefreshCw,
  Search,
  Square,
  X,
  Zap,
} from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import ForceStopDialog from './ForceStopDialog';
import useEngineSnapshot from './use-engine-snapshot.js';
import {
  engineFacts,
  engineIdForJobType,
  engineNameForJobType,
  waitingJobsForEngine,
} from './engine-controls.js';
import {
  STATUS_FILTERS,
  clearableWaitingJobs,
  countByStatusFilter,
  filterQueueJobs,
  hasActiveQueueFilters,
  jobAgeSeconds,
  jobShortId,
  jobSizeAndSteps,
  normalizeQueueFilters,
  queueProjectOptions,
  queueTypeOptions,
} from './queue-filters.js';
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
import './queue-filters.css';
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
import { createLog } from './app-log.js';

const log = createLog('queue');

/**
 * POSTs JSON to a runtime or project endpoint and returns the parsed body.
 * A non-2xx response throws an Error whose `status` and `body` hold the server reply.
 */
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

// The filter choice survives moving between pages in this session, not across browser sessions.
const QUEUE_FILTERS_KEY = 'forge-queue-filters-v1';
// Prompts longer than this are cut in the row, with a control to show the rest.
const PROMPT_PREVIEW_LENGTH = 140;
// How many cancelled renders the clear dialog names before it summarises the rest.
const CLEAR_LIST_LIMIT = 8;
// Renders that an engine is working on now. Only a force stop can end them (see stopRender).
const RUNNING_STATUSES = ['preparing', 'submitting', 'running', 'finalizing'];

function loadQueueFilters() {
  try {
    return normalizeQueueFilters(JSON.parse(sessionStorage.getItem(QUEUE_FILTERS_KEY)));
  } catch {
    // A missing or unreadable saved choice means the default filters.
    return normalizeQueueFilters(null);
  }
}

function saveQueueFilters(filters) {
  try {
    sessionStorage.setItem(QUEUE_FILTERS_KEY, JSON.stringify(filters));
  } catch (error) {
    log.debug('queue.filters.save.failed', { errorClass: error?.name });
    // Browser storage may be unavailable; the filters still apply for this page view.
  }
}

// Time of creation, shown with the date when the render was not created today.
function formatCreated(createdAt, now) {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return 'Unknown time';
  }
  const sameDay = created.toDateString() === new Date(now).toDateString();
  return created.toLocaleString([], {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

// "3 min ago" style age from the seconds jobAgeSeconds returns.
function formatAge(seconds) {
  if (seconds === null) {
    return 'age unknown';
  }
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
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
/**
 * Queues an image render, once per variation. Returns one job, or an array of jobs
 * when several variations are requested. A failure after some jobs were queued
 * reports how many were accepted.
 */
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
// The render's prompt or title, cut to a preview. The toggle names the render, so several rows
// with long prompts can be told apart by a screen reader.
function JobPrompt({ job, expanded, onToggle }) {
  const fullTitle = jobTitle(job);
  const isLong = fullTitle.length > PROMPT_PREVIEW_LENGTH;
  const shown =
    isLong && !expanded ? `${fullTitle.slice(0, PROMPT_PREVIEW_LENGTH).trimEnd()}…` : fullTitle;
  return (
    <>
      <strong
        className="runtime-job-prompt"
        title={job.request.title || job.request.style || job.request.prompt || job.request.text}
      >
        {shown}
      </strong>
      {isLong && (
        <button
          type="button"
          className="text-action runtime-job-prompt-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Show less of' : 'Show full prompt of'} render ${jobShortId(job)}`}
          onClick={onToggle}
        >
          {expanded ? 'Show less' : 'Show full prompt'}
        </button>
      )}
    </>
  );
}

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
  const { t } = useT();
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');
  // Sections whose "Show more" is open, and the last dismissal (kept so it can be undone).
  const [openGroups, setOpenGroups] = useState({});
  const [dismissal, setDismissal] = useState(null);
  const listRef = useRef(null);
  // Where keyboard focus goes once the dismissed row has left the list.
  const focusAfterDismiss = useRef(null);
  const [confirmClear, setConfirmClear] = useRouteToggle('clearQueue');
  // Which waiting renders "Clear waiting renders" cancels: the current view, or every project.
  const [clearScope, setClearScope] = useState('view');
  const [clearConfirmation, setClearConfirmation] = useState('');
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState('');
  const [resolveTarget, setResolveTarget] = useState(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const [stopTarget, setStopTarget] = useState(null);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopResult, setStopResult] = useState(null);
  const [stopError, setStopError] = useState('');
  const [filters, setFilters] = useState(loadQueueFilters);
  // Rows whose long prompt is shown in full.
  const [expandedPrompts, setExpandedPrompts] = useState({});
  const [clock, setClock] = useState(() => Date.now());
  const [notice, setNotice] = useState('');
  const dialogJob = resolveTarget || stopTarget;
  const dialogEngineId = dialogJob ? engineIdForJobType(dialogJob.type) : null;
  // Engine facts and the waiting line are read only while a decision dialog is open.
  const engineSnapshot = useEngineSnapshot(dialogEngineId, Boolean(dialogEngineId));
  useEffect(() => {
    saveQueueFilters(filters);
  }, [filters]);
  useEffect(() => {
    // Ages in the rows move on their own, so the clock ticks while the page is open.
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);
  async function action(job, kind) {
    setError('');
    setNotice('');
    setBusy(job.id);
    try {
      await post(`/api/runtime/jobs/${job.id}/${kind}`, {});
      await refresh();
      setNotice(`Render ${kind === 'retry' ? 'retried' : 'cancelled'}.`);
      log.info('queue.render.action.completed', { jobId: job.id, action: kind });
    } catch (e) {
      log.warn('queue.render.action.failed', { jobId: job.id, action: kind, error: e });
      setError(e.message);
    } finally {
      setBusy('');
    }
  }
  // Marks an interrupted render cancelled. Runs only after the person confirmed the engine check.
  async function resolveJob() {
    const job = resolveTarget;
    if (!job) {
      return;
    }
    setResolveBusy(true);
    setResolveError('');
    try {
      await post(`/api/runtime/jobs/${job.id}/resolve`, { confirmRemoteNotRunning: true });
      log.info('queue.render.action.completed', { jobId: job.id, action: 'resolve' });
      setResolveTarget(null);
      setNotice('Interrupted render marked cancelled.');
      await refresh();
    } catch (e) {
      log.warn('queue.render.action.failed', { jobId: job.id, action: 'resolve', error: e });
      // The error stays in the dialog, so the person can read it and try again.
      setResolveError(e.message);
    } finally {
      setResolveBusy(false);
    }
  }
  // Stops the engine that runs a render. Forge verifies the process itself; the page sends only
  // the engine id and the confirmation.
  async function stopRender() {
    const job = stopTarget;
    const engineId = job && engineIdForJobType(job.type);
    if (!engineId) {
      return;
    }
    setStopBusy(true);
    setStopError('');
    try {
      const result = await post(`/api/runtime/models/${engineId}/force-stop`, {
        confirmation: 'force-stop-engine',
      });
      log.info('queue.render.stop.completed', { jobId: job.id, engineId });
      setStopResult(result);
      await refresh();
    } catch (e) {
      log.warn('queue.render.stop.failed', { jobId: job.id, engineId, error: e });
      setStopError(e.message);
    } finally {
      setStopBusy(false);
    }
  }
  function closeStopDialog() {
    setStopTarget(null);
    setStopResult(null);
    setStopError('');
  }
  async function copyError(job) {
    try {
      await navigator.clipboard.writeText(
        `${job.type} render ${job.id}\n${job.stage || job.status}\n${job.error}`,
      );
      setCopied(job.id);
      setTimeout(() => setCopied(''), 2500);
    } catch (error) {
      log.warn('queue.error.copy.failed', { jobId: job.id, error });
      setError('Could not copy the error. Select its text and copy it instead.');
    }
  }
  const visible = jobs.filter((job) => !hiddenIds.includes(job.id));
  const projectName = (job) =>
    projects.find((project) => project.id === job.projectId)?.name || 'Project';
  const projectOptions = queueProjectOptions(visible, projects);
  const typeOptions = queueTypeOptions(visible);
  const filtersActive = hasActiveQueueFilters(filters);
  const matching = filterQueueJobs(visible, filters, projectName);
  const statusCounts = countByStatusFilter(visible, filters, projectName);
  // Renders that wait for an earlier render are listed directly under it.
  const { groups, nested: nestedIds } = buildQueueGroups(matching, { expanded });
  const changeFilters = (change) =>
    setFilters((current) => normalizeQueueFilters({ ...current, ...change }));
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
        <div className="runtime-job-meta">
          <code title="Render ID">{jobShortId(job)}</code>
          <span>{projectName(job)}</span>
          <span>
            Created {formatCreated(job.createdAt, clock)} ·{' '}
            {formatAge(jobAgeSeconds(job.createdAt, clock))}
          </span>
          {jobSizeAndSteps(job) && <span>{jobSizeAndSteps(job)}</span>}
        </div>
        <JobPrompt
          job={job}
          expanded={Boolean(expandedPrompts[job.id])}
          onToggle={() =>
            setExpandedPrompts((current) => ({ ...current, [job.id]: !current[job.id] }))
          }
        />
        {job.stage && <small>{job.stage}</small>}
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
        {RUNNING_STATUSES.includes(job.status) && engineIdForJobType(job.type) && (
          <button
            type="button"
            className="icon-outline queue-stop-render"
            title="Stops the engine that runs this render. The queue then waits for you to review it."
            onClick={() => {
              setStopResult(null);
              setStopError('');
              setStopTarget(job);
            }}
          >
            <Square size={14} aria-hidden="true" />
            Stop this render…
          </button>
        )}
        {['queued', 'waiting_engine', 'waiting_memory', 'needs_attention'].includes(job.status) && (
          <button
            disabled={busy === job.id}
            className="icon-outline"
            aria-label={`Cancel render ${jobShortId(job)} in ${projectName(job)}`}
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
              aria-label={`Mark cancelled after checking: render ${jobShortId(job)} in ${projectName(job)}`}
              onClick={() => {
                setResolveError('');
                setResolveTarget(job);
              }}
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
  const waitingCount = jobs.filter(
    (job) => ['queued', 'waiting_engine', 'waiting_memory'].includes(job.status) && !job.remoteId,
  ).length;
  // The waiting renders the clear dialog would cancel for the chosen scope.
  const clearViewTargets = clearableWaitingJobs(matching);
  const clearAllTargets = clearableWaitingJobs(jobs);
  const clearTargets = clearScope === 'all' ? clearAllTargets : clearViewTargets;
  function openClearDialog() {
    setClearError('');
    setClearScope('view');
    setClearConfirmation('');
    setConfirmClear(true);
  }
  function closeClearDialog() {
    if (!clearBusy) {
      setConfirmClear(false);
    }
  }
  /**
   * Cancels the waiting renders in the chosen scope. Every project uses the runtime's own bulk
   * cancel; a view or filter cancels its renders one by one, and each render the runtime refuses
   * (because it started meanwhile, say) is reported rather than hidden.
   */
  async function clearWaiting() {
    const targets = clearTargets;
    if (!targets.length || clearConfirmation !== 'CLEAR') {
      return;
    }
    setClearBusy(true);
    setClearError('');
    setNotice('');
    const failures = [];
    let cancelled = 0;
    try {
      if (clearScope === 'all') {
        const result = await post('/api/runtime/jobs/clear-waiting', {
          confirmation: 'cancel-waiting-renders',
        });
        cancelled = result.cancelled;
      } else {
        for (const job of targets) {
          try {
            await post(`/api/runtime/jobs/${job.id}/cancel`, {});
            cancelled += 1;
          } catch (e) {
            failures.push(`${jobShortId(job)} (${e.message})`);
          }
        }
      }
      log.info('queue.waiting.cleared', { count: cancelled, scope: clearScope });
      setNotice(`${cancelled} waiting ${cancelled === 1 ? 'render' : 'renders'} cancelled.`);
      if (failures.length) {
        setClearError(
          `${failures.length} could not be cancelled and were left in the queue: ${failures.join(', ')}.`,
        );
      } else {
        setConfirmClear(false);
      }
    } catch (e) {
      log.warn('queue.waiting.clear.failed', { error: e, scope: clearScope });
      setClearError(e.message);
    } finally {
      setClearBusy(false);
      await refresh();
    }
  }
  // What the open decision dialog shows: the engine's own state and GPU memory, and the renders
  // queued behind it. Empty until the snapshot is read, so nothing is shown as checked before it is.
  const engineFactsRows =
    dialogEngineId && engineSnapshot.status === 'ready'
      ? engineFacts(engineSnapshot.service, engineSnapshot.hardware)
      : [];
  const stopWaitingJobs = dialogEngineId
    ? waitingJobsForEngine(
        engineSnapshot.status === 'ready' ? engineSnapshot.jobs : jobs,
        dialogEngineId,
      )
    : [];
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
            “Clear waiting renders” cancels waiting renders in the current view, and asks before it
            cancels any in other projects. Running and uncertain renders continue; completed files
            stay.
          </p>
          <div className="queue-manage">
            <button
              className="icon-outline"
              onClick={hideCurrent}
              disabled={hiddenCount === jobs.length}
              title="Only hides these rows in this browser. Renders keep running and stay in the history."
            >
              Hide these rows from this list
            </button>
            {hiddenCount > 0 && (
              <button
                className="icon-outline"
                onClick={showHidden}
                title="Shows the rows you hid in this browser again."
              >
                Show the {hiddenCount} hidden {hiddenCount === 1 ? 'row' : 'rows'} again
              </button>
            )}
            <button
              className="icon-outline queue-clear"
              onClick={openClearDialog}
              disabled={!waitingCount}
              title={waitingCount ? undefined : 'There are no waiting renders to cancel.'}
            >
              Clear waiting renders…
            </button>
          </div>
        </details>
      )}
      {jobs.length > 0 && (
        <div className="queue-filters" role="group" aria-label="Filter renders">
          <div className="queue-filter-status" role="group" aria-label="Status">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className="queue-filter-chip"
                aria-pressed={filters.status === filter.id}
                onClick={() => changeFilters({ status: filter.id })}
              >
                {filter.label}
                <span className="queue-filter-count">{statusCounts[filter.id]}</span>
              </button>
            ))}
          </div>
          <div className="queue-filter-fields">
            <label>
              <span>Project</span>
              <select
                value={filters.projectId}
                onChange={(event) => changeFilters({ projectId: event.target.value })}
              >
                <option value="all">All projects</option>
                {projectOptions.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Type</span>
              <select
                value={filters.type}
                onChange={(event) => changeFilters({ type: event.target.value })}
              >
                <option value="all">All types</option>
                {typeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="queue-filter-search">
              <span>
                <Search size={14} aria-hidden="true" /> Search
              </span>
              <input
                type="search"
                value={filters.query}
                placeholder="Prompt, render ID or project"
                onChange={(event) => changeFilters({ query: event.target.value })}
              />
            </label>
          </div>
          <p className="queue-filter-summary" role="status" aria-live="polite">
            Showing {matching.length} of {visible.length}{' '}
            {visible.length === 1 ? 'render' : 'renders'}
            {hiddenCount > 0 && ` (${hiddenCount} hidden in this browser)`}.
            {filtersActive && (
              <>
                {' '}
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setFilters(normalizeQueueFilters(null))}
                >
                  Clear filters
                </button>
              </>
            )}
          </p>
        </div>
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
      {!matching.length ? (
        <div className="runtime-queue-empty">
          <ListMusic size={19} />
          <span>
            {queueError && !jobs.length
              ? 'The render queue could not be loaded. Refresh to try again.'
              : !visible.length && hiddenCount
                ? 'Every row is hidden in this browser. Renders continue in the background.'
                : visible.length
                  ? 'No renders match these filters.'
                  : 'No renders yet. Queue one and its progress will show up here.'}
          </span>
          {filtersActive && visible.length > 0 && (
            <button
              type="button"
              className="icon-outline"
              onClick={() => setFilters(normalizeQueueFilters(null))}
            >
              Clear filters
            </button>
          )}
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
                Show them again
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
        <ConfirmDialog
          title="Clear waiting renders?"
          kicker="Waiting renders only"
          error={clearError}
          confirmLabel={`Cancel ${clearTargets.length} waiting ${clearTargets.length === 1 ? 'render' : 'renders'}`}
          busyLabel="Cancelling renders…"
          tone="danger"
          busy={clearBusy}
          confirmDisabled={!clearTargets.length || clearConfirmation !== 'CLEAR'}
          onConfirm={clearWaiting}
          onClose={closeClearDialog}
        >
          <fieldset className="queue-clear-scope">
            <legend>Which waiting renders?</legend>
            <label>
              <input
                type="radio"
                name="clear-scope"
                value="view"
                checked={clearScope === 'view'}
                disabled={clearBusy}
                onChange={() => {
                  setClearScope('view');
                  setClearConfirmation('');
                }}
              />
              <span>
                In this view: {clearViewTargets.length}
                {!filtersActive && ' (no filters are set, so this covers every project)'}
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="clear-scope"
                value="all"
                checked={clearScope === 'all'}
                disabled={clearBusy}
                onChange={() => {
                  setClearScope('all');
                  setClearConfirmation('');
                }}
              />
              <span>In every project, including rows hidden here: {clearAllTargets.length}</span>
            </label>
          </fieldset>
          {clearTargets.length ? (
            <>
              <p>These waiting renders will be cancelled:</p>
              <ul className="queue-clear-list">
                {clearTargets.slice(0, CLEAR_LIST_LIMIT).map((job) => (
                  <li key={job.id}>
                    <code>{jobShortId(job)}</code> {jobAccessibleName(job)}{' '}
                    <span>· {projectName(job)}</span>
                  </li>
                ))}
              </ul>
              {clearTargets.length > CLEAR_LIST_LIMIT && (
                <p>and {clearTargets.length - CLEAR_LIST_LIMIT} more.</p>
              )}
            </>
          ) : (
            <p>There are no waiting renders in this scope.</p>
          )}
          <p>
            Running and uncertain renders continue. Completed files stay in their projects. A
            cancelled render cannot be restarted from here; queue it again if you still need it.
          </p>
          <label className="queue-clear-confirmation">
            {t('queue.clear.typeConfirmation', 'Type CLEAR to confirm')}
            <input
              value={clearConfirmation}
              onChange={(event) => setClearConfirmation(event.target.value)}
              disabled={clearBusy}
              autoComplete="off"
            />
          </label>
        </ConfirmDialog>
      )}
      {resolveTarget && (
        <ConfirmDialog
          title="Mark this render cancelled?"
          kicker={`Render ${jobShortId(resolveTarget)} · ${projectName(resolveTarget)}`}
          facts={dialogEngineId ? engineFactsRows : null}
          factsStatus={engineSnapshot.status === 'loading' ? 'loading' : 'ready'}
          factsError={dialogEngineId ? engineSnapshot.error : ''}
          onRefreshFacts={engineSnapshot.reload}
          error={resolveError}
          confirmLabel="Mark cancelled"
          busyLabel="Marking cancelled…"
          tone="danger"
          busy={resolveBusy}
          onConfirm={resolveJob}
          onClose={() => {
            if (!resolveBusy) {
              setResolveTarget(null);
              setResolveError('');
            }
          }}
        >
          <p>
            Check {engineNameForJobType(resolveTarget.type)}’s queue and history
            {resolveTarget.remoteId ? ` for job ${resolveTarget.remoteId}` : ''} first. Confirm that
            it is no longer running this render.
          </p>
          <p>
            Forge then marks “{jobAccessibleName(resolveTarget)}” cancelled and unblocks the queue.
            Renders that depend on it are cancelled too. Nothing is deleted.
          </p>
          {!dialogEngineId && <p>This kind of render has no engine to check in Forge.</p>}
        </ConfirmDialog>
      )}
      {stopTarget && (
        <ForceStopDialog
          name={engineNameForJobType(stopTarget.type)}
          reason="render"
          working={stopBusy}
          result={stopResult}
          error={stopError}
          onClose={closeStopDialog}
          onForceStop={stopRender}
          waitingJobs={stopWaitingJobs}
          projectNameOf={projectName}
          facts={engineFactsRows}
          factsStatus={engineSnapshot.status}
          factsError={engineSnapshot.error}
          onRefreshFacts={engineSnapshot.reload}
        />
      )}
    </section>
  );
}
