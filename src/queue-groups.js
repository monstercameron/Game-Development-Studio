// Presentation helpers for the render queue list: which section a job belongs to, how many rows
// each section shows before "Show more", and what a row is called.
import { orderChains } from './queue-chain.js';

// Rows that block the queue until a person acts, versus renders that simply stopped.
export const BLOCKING_STATUSES = ['needs_attention', 'interrupted'];
// Statuses that can be dismissed from the list: the render is over and nothing waits on it.
export const DISMISSIBLE_STATUSES = ['failed', 'cancelled', 'completed'];

// `limit` is how many rows a section shows before "Show more": [panel on other pages, /queue page].
const GROUP_DEFINITIONS = [
  {
    id: 'processing',
    title: 'Processing now',
    statuses: ['running', 'finalizing'],
    always: true,
    empty: 'Nothing is processing right now.',
    noun: 'running renders',
    limit: [20, 20],
  },
  {
    id: 'waiting',
    title: 'Waiting in line',
    statuses: ['queued', 'waiting_engine', 'waiting_memory'],
    note: 'Renders start from the top of this list, one at a time.',
    noun: 'waiting renders',
    limit: [10, 50],
  },
  {
    id: 'attention',
    title: 'Needs attention',
    statuses: BLOCKING_STATUSES,
    note: 'These renders hold up the queue until you check them.',
    noun: 'renders needing attention',
    limit: [5, 20],
  },
  {
    id: 'failed',
    title: 'Failed',
    statuses: ['failed'],
    note: 'These renders stopped with an error. Nothing is waiting on them. Retry one, or dismiss it to hide it here.',
    noun: 'failed renders',
    limit: [3, 5],
  },
  {
    id: 'recent',
    title: 'Recently finished',
    statuses: ['completed', 'cancelled'],
    noun: 'finished renders',
    limit: [3, 10],
  },
];

// The waiting section lists renders exactly in the order the runtime will start them, so a move
// the person makes is the move they see. A chained render is indented only when it sits directly
// under the render it uses (or under a sibling that does).
function inRuntimeOrder(items) {
  const nested = new Set();
  const parentOf = (item) => item.dependsOn || item.request?.referenceFrom?.jobId || null;
  items.forEach((item, index) => {
    const parentId = parentOf(item);
    const above = items[index - 1];
    if (
      parentId &&
      above &&
      (above.id === parentId || (nested.has(above.id) && parentOf(above) === parentId))
    ) {
      nested.add(item.id);
    }
  });
  return { ordered: items, nested };
}

// Every section with all of its rows, in queue order with chained renders under their source.
// `nested` holds the ids of rows that are shown indented under an earlier render.
export function buildQueueGroups(jobs, { expanded = false } = {}) {
  const nested = new Set();
  const groups = GROUP_DEFINITIONS.map((definition) => {
    const matching = jobs.filter((job) => definition.statuses.includes(job.status));
    const result = definition.id === 'waiting' ? inRuntimeOrder(matching) : orderChains(matching);
    result.nested.forEach((id) => nested.add(id));
    return {
      ...definition,
      items: result.ordered,
      limit: definition.limit[expanded ? 1 : 0],
    };
  });
  return { groups, nested };
}

// What a row is called: the render's own title or prompt, or a plain name for its kind.
export function jobTitle(job) {
  const request = job?.request || {};
  if (job?.type === 'world' && request.model === 'hy-world') {
    return 'HY-World reconstruction';
  }
  if (job?.type === 'vegetation') {
    const words = String(request.species || 'plant').replace(/([a-z])([A-Z])/g, '$1 $2');
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} · seed ${request.seed}`;
  }
  const named = request.title || request.style || request.prompt || request.text;
  if (named) {
    return named;
  }
  const fallbacks = {
    '3d': 'Hunyuan 3D shape',
    trellis: 'TRELLIS.2 3D model',
    'motion-bricks': 'SOMA pose transition',
    world: 'WorldGen scene',
  };
  return fallbacks[job?.type] || '';
}

// A short name for buttons and announcements, so a screen reader can tell rows apart.
export function jobAccessibleName(job) {
  const title = jobTitle(job).replace(/\s+/g, ' ').trim();
  const kind = String(job?.type || 'render');
  const name = title || `${kind} render ${String(job?.id || '').slice(0, 8)}`.trim();
  return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}
