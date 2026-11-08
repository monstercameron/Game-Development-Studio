// Presentation helpers for renders that take their reference from an earlier render.
// A job declares this with request.referenceFrom = { jobId, output? }; the queue also exposes
// job.dependsOn. `output` appears once the earlier render finished and its result was staged.

const KIND_NAMES = {
  images: 'image',
  segmentation: 'cutout',
  video: 'video',
  '3d': '3D shape',
  trellis: '3D model',
};
const STATUS_WORDS = {
  queued: 'queued',
  waiting_engine: 'waiting for its engine',
  waiting_memory: 'waiting for memory',
  preparing: 'preparing',
  needs_attention: 'needs attention',
  submitting: 'starting',
  running: 'running',
  finalizing: 'saving',
  interrupted: 'interrupted',
  completed: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function isChained(job) {
  return Boolean(job?.dependsOn || job?.request?.referenceFrom?.jobId);
}
// Still waiting for the earlier render's output to be staged as its reference.
export function isWaitingForReference(job) {
  const from = job?.request?.referenceFrom;
  return Boolean(from && typeof from.output !== 'string');
}
export function parentOf(job, jobs) {
  const id = job?.dependsOn || job?.request?.referenceFrom?.jobId;
  return id ? (jobs || []).find((item) => item.id === id) || null : null;
}
export function kindName(job) {
  return KIND_NAMES[job?.type] || 'render';
}
// A short name for a job in the queue, e.g. "image “a wooden barrel”".
export function jobLabel(job) {
  if (!job) {
    return 'an earlier render';
  }
  const text = job.request?.prompt || job.request?.title || job.request?.style || '';
  const short = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  return short ? `${kindName(job)} “${short}”` : `the ${kindName(job)}`;
}

// One sentence for the queue row, or '' when the job is not part of a chain.
export function chainHint(job, jobs) {
  if (!isChained(job)) {
    return '';
  }
  const parent = parentOf(job, jobs);
  const from = job.request?.referenceFrom;
  if (!isWaitingForReference(job)) {
    const sourceLabel = parent ? jobLabel(parent) : (from?.output ?? 'earlier render');
    return `Built from the finished ${sourceLabel}.`;
  }
  if (!parent) {
    return 'Depends on an earlier render that is no longer in the list.';
  }
  const status = STATUS_WORDS[parent.status] || parent.status;
  if (['failed', 'cancelled'].includes(parent.status)) {
    return `Depends on ${jobLabel(parent)}, which ${status}.`;
  }
  if (parent.status === 'completed') {
    return `Depends on ${jobLabel(parent)} (finished). Starts when its turn comes.`;
  }
  return `Waiting for ${jobLabel(parent)} (${status}).`;
}

// Puts each chained job directly under the job it depends on when both are in the same list,
// otherwise keeps the queue order. Returns the new order plus which ids are nested.
export function orderChains(items) {
  const ids = new Set(items.map((item) => item.id));
  const children = new Map();
  for (const item of items) {
    const parentId = item.dependsOn || item.request?.referenceFrom?.jobId;
    if (parentId && ids.has(parentId) && parentId !== item.id) {
      children.set(parentId, [...(children.get(parentId) || []), item]);
    }
  }
  const nested = new Set([...children.values()].flat().map((item) => item.id));
  const ordered = [];
  const placed = new Set();
  const place = (item) => {
    if (placed.has(item.id)) {
      return;
    }
    placed.add(item.id);
    ordered.push(item);
    for (const child of children.get(item.id) || []) {
      place(child);
    }
  };
  for (const item of items) {
    if (!nested.has(item.id)) {
      place(item);
    }
  }
  // A malformed loop of dependencies must never hide a job.
  for (const item of items) {
    place(item);
  }
  return { ordered, nested };
}

// Renders still waiting for this job's output; cancelling this job cancels them too.
export function waitingDependents(job, jobs) {
  return (jobs || []).filter(
    (item) =>
      (item.dependsOn || item.request?.referenceFrom?.jobId) === job.id &&
      isWaitingForReference(item) &&
      ['queued', 'waiting_engine', 'waiting_memory', 'needs_attention'].includes(item.status),
  );
}
