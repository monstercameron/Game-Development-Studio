import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Clock3 } from 'lucide-react';
import {
  ACTIVE_QUEUE_STATES,
  estimateFromNearbyHistory,
  forecastQueue,
  formatDuration,
} from './queue-timing.js';
import './queue-timing.css';

const TimingContext = createContext(null);
const MAX_ESTIMATED_JOBS = 50;
const HIDDEN_QUEUE_KEY = 'forge-hidden-queue-ids-v1';
function loadHidden() {
  try {
    const ids = JSON.parse(localStorage.getItem(HIDDEN_QUEUE_KEY));
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string').slice(-500) : [];
  } catch {
    return [];
  }
}

export function QueueTimingProvider({ children }) {
  const [jobs, setJobs] = useState([]),
    [estimates, setEstimates] = useState({}),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [clock, setClock] = useState(Date.now());
  const [hiddenIds, setHiddenIds] = useState(loadHidden);
  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_QUEUE_KEY, JSON.stringify(hiddenIds));
    } catch {
      // Browser storage may be unavailable; queue state remains in memory.
    }
  }, [hiddenIds]);
  const hideCurrent = useCallback(
    () =>
      setHiddenIds((previous) =>
        [...new Set([...previous, ...jobs.map((job) => job.id)])].slice(-500),
      ),
    [jobs],
  );
  const showHidden = useCallback(() => setHiddenIds([]), []);
  const cache = useRef(new Map()),
    history = useRef(''),
    generation = useRef(0),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    const sequence = ++generation.current;
    try {
      const response = await fetch('/api/runtime/jobs');
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.jobs)) {
        throw Error(data.error || 'Queue unavailable.');
      }
      if (!mounted.current || sequence !== generation.current) {
        return;
      }
      const next = data.jobs;
      setJobs(next);
      setError('');
      setLoading(false);
      setClock(Date.now());
      const signature = next
        .filter((job) => job.status === 'completed')
        .map((job) => `${job.id}:${job.finishedAt}`)
        .join('|');
      if (signature !== history.current) {
        history.current = signature;
        cache.current.clear();
      }
      const candidates = next
        .filter((job) => ACTIVE_QUEUE_STATES.has(job.status))
        .slice(0, MAX_ESTIMATED_JOBS);
      const estimateJob = async (job) => {
        const key = JSON.stringify([job.type, job.projectId, job.request]);
        let estimate = cache.current.get(key);
        if (!estimate) {
          try {
            const result = await fetch('/api/runtime/estimate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
              body: JSON.stringify({
                type: job.type,
                projectId: job.projectId,
                request: job.request,
              }),
            });
            if (!result.ok) {
              throw Error('Estimate unavailable.');
            }
            estimate = await result.json();
            if (!estimate?.available) {
              estimate = estimateFromNearbyHistory(job.type, job.request, next) || estimate;
            }
            if (history.current === signature) {
              cache.current.set(key, estimate);
            }
          } catch {
            estimate = estimateFromNearbyHistory(job.type, job.request, next);
          }
        }
        return [job.id, estimate];
      };
      const entries = {};
      for (let index = 0; index < candidates.length; index += 6) {
        const batch = await Promise.all(candidates.slice(index, index + 6).map(estimateJob));
        if (!mounted.current || sequence !== generation.current) {
          return;
        }
        Object.assign(entries, Object.fromEntries(batch));
        setEstimates({ ...entries });
      }
      if (!candidates.length && mounted.current && sequence === generation.current) {
        setEstimates({});
      }
    } catch (reason) {
      if (mounted.current && sequence === generation.current) {
        setError(reason.message || 'Queue unavailable.');
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh();
    const poll = setInterval(refresh, 5000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
    };
  }, [refresh]);
  const forecast = useMemo(
    () => forecastQueue(jobs, estimates, clock, MAX_ESTIMATED_JOBS),
    [jobs, estimates, clock],
  );
  const value = useMemo(
    () => ({
      jobs,
      estimates,
      error,
      loading,
      forecast,
      refresh,
      hiddenIds,
      hideCurrent,
      showHidden,
    }),
    [jobs, estimates, error, loading, forecast, refresh, hiddenIds, hideCurrent, showHidden],
  );
  return <TimingContext.Provider value={value}>{children}</TimingContext.Provider>;
}

export function useQueueTiming() {
  const value = useContext(TimingContext);
  if (!value) {
    throw Error('Queue timing context is unavailable.');
  }
  return value;
}

export function QueueTimingBadge({ onOpen } = {}) {
  const { jobs, forecast, error, loading } = useQueueTiming();
  const label = error
    ? 'Queue unavailable'
    : loading
      ? 'Checking queue'
      : !forecast.count
        ? 'Queue clear'
        : forecast.blocked
          ? 'Queue has a blocked render'
          : forecast.seconds === null
            ? 'Queue: unknown'
            : `Queue ~${formatDuration(forecast.seconds)}`;
  const current =
    jobs.find((job) => ACTIVE_QUEUE_STATES.has(job.status) && job.status !== 'queued') ||
    jobs.find((job) => job.status === 'queued');
  const timing = current && forecast.perJob[current.id];
  const render = error
    ? 'Render unavailable'
    : loading
      ? 'Checking render'
      : !current
        ? 'Render idle'
        : timing?.remainingSeconds !== null &&
            timing?.remainingSeconds !== undefined &&
            ['running', 'finalizing'].includes(current.status)
          ? `Render ~${formatDuration(timing.remainingSeconds)} left`
          : timing?.estimate?.available
            ? `Render ~${formatDuration(timing.estimate.typicalSeconds)}`
            : 'Render: unknown';
  const detail = error
    ? 'Could not reach the render queue.'
    : loading
      ? 'Checking the render service.'
      : !forecast.count
        ? 'No renders are waiting.'
        : forecast.seconds === null
          ? `${forecast.count} active or waiting. ${forecast.reason || 'There is not enough timing history.'}`
          : `${forecast.count} active or waiting. Estimated render time remaining; model preparation and load times can add more.`;
  const content = (
    <>
      <Clock3 size={15} aria-hidden="true" />
      <span className="queue-timing-lines">
        <span>{render}</span>
        <span>{label}</span>
      </span>
    </>
  );
  const className = 'queue-timing-badge ' + (forecast.blocked ? 'is-blocked' : '');
  if (onOpen) {
    // Clickable variant: jumps to the full render queue instead of only reporting its state.
    return (
      <button
        type="button"
        className={className + ' is-interactive'}
        title={`${detail} Open the render queue.`}
        aria-label={`${render}. ${label}. ${detail} Open the render queue.`}
        onClick={onOpen}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className={className}
      role="status"
      aria-live="off"
      title={detail}
      aria-label={`${render}. ${label}. ${detail}`}
    >
      {content}
    </div>
  );
}

export function QueueTimingSummary() {
  const { forecast, error, loading } = useQueueTiming();
  if (error) {
    return (
      <div className="queue-timing-summary">
        <strong>Queue estimate unavailable</strong>
        <span>Could not reach the render service.</span>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="queue-timing-summary">
        <strong>Checking the queue…</strong>
      </div>
    );
  }
  if (!forecast.count) {
    return (
      <div className="queue-timing-summary">
        <strong>Queue clear</strong>
        <span>New renders can start when their model is ready.</span>
      </div>
    );
  }
  if (forecast.seconds === null) {
    return (
      <div className="queue-timing-summary">
        <strong>{forecast.blocked ? 'Queue needs attention' : 'Finish time unknown'}</strong>
        <span>
          {forecast.reason || 'There is not enough timing history yet.'}
          {forecast.knownWorkCount > 0 &&
            ` Known render estimates total ~${formatDuration(forecast.knownWorkSeconds)}; other time is not included.`}
        </span>
      </div>
    );
  }
  return (
    <div className="queue-timing-summary">
      <strong>About {formatDuration(forecast.seconds)} remaining</strong>
      <span>
        {forecast.count} {forecast.count === 1 ? 'render' : 'renders'} ·{' '}
        {forecast.hasRough ? 'includes rough estimates' : 'based on previous renders'} · model
        preparation can add time
      </span>
    </div>
  );
}

export function CreationQueueTiming({ estimate, estimateError }) {
  const { forecast, error, loading } = useQueueTiming();
  const wait = error
    ? 'Unavailable'
    : loading
      ? 'Checking…'
      : !forecast.count
        ? 'No wait'
        : forecast.seconds === null
          ? 'Unknown'
          : `~${formatDuration(forecast.seconds)}`;
  const total =
    !error && !loading && forecast.seconds !== null && estimate?.available
      ? forecast.seconds + estimate.typicalSeconds
      : null;
  const totalLabel =
    error || estimateError
      ? 'Unavailable'
      : loading || !estimate
        ? 'Checking…'
        : forecast.count > 0 && forecast.seconds === null
          ? 'Unknown'
          : total === null
            ? 'Unknown'
            : `~${formatDuration(total)}`;
  return (
    <div className="creation-timing" aria-label="Estimated queue and completion time">
      <span>
        Queue wait: <strong>{wait}</strong>
      </span>
      <span>
        Queue + render: <strong>{totalLabel}</strong>
      </span>
      <span>Model loading may add time.</span>
      {forecast.count > 0 && forecast.seconds === null && <span>{forecast.reason}</span>}
      {forecast.count > 0 && forecast.seconds === null && forecast.knownWorkCount > 0 && (
        <span>
          Known queue render estimates:{' '}
          <strong>~{formatDuration(forecast.knownWorkSeconds)}</strong>
        </span>
      )}
    </div>
  );
}
