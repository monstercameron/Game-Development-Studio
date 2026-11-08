import { useEffect, useRef, useState } from 'react';
import MemoryDialog from './MemoryDialog';
import { post } from './RuntimeQueue';
import { createLog } from './app-log.js';

const log = createLog('memory');

// Queue job type to the model name shown in the memory dialog. Unlisted types fall back to YuE2.
const MEMORY_TARGET_LABELS = new Map([
  ['video', 'H3 Studio'],
  ['images', 'Qwen Image'],
  ['sfx', 'Stable Audio'],
  ['voices', 'Qwen3-TTS'],
  ['3d', 'Hunyuan3D'],
  ['trellis', 'TRELLIS.2'],
  ['segmentation', 'SAM 3.1'],
  ['motion', 'HY-Motion'],
  ['motion-bricks', 'MotionBricks'],
]);

export default function MemoryAlerts() {
  const [job, setJob] = useState(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState('');
  const seen = useRef(new Set());
  useEffect(() => {
    let alive = true;
    let isPollFailing = false;
    async function poll() {
      try {
        const response = await fetch('/api/runtime/jobs');
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        isPollFailing = false;
        if (!alive) {
          return;
        }
        const waiting = data.jobs.filter(
          (item) => item.status === 'waiting_memory' && item.details && !item.details.autoManaging,
        );
        const currentIds = new Set(
          data.jobs.filter((item) => item.status === 'waiting_memory').map((item) => item.id),
        );
        for (const id of seen.current) {
          if (!currentIds.has(id)) {
            seen.current.delete(id);
          }
        }
        setJob((current) => {
          if (current) {
            const fresh = waiting.find((item) => item.id === current.id);
            return fresh || null;
          }
          const next = waiting.find((item) => !seen.current.has(item.id));
          if (next) {
            seen.current.add(next.id);
          }
          return next || null;
        });
      } catch (pollError) {
        // Polling is best-effort; the next interval retries. Logged once per failure streak.
        if (!isPollFailing) {
          isPollFailing = true;
          log.debug('memory.alert.poll.failed', { error: pollError });
        }
      }
    }
    const open = (event) => {
      if (event.detail?.details) {
        seen.current.add(event.detail.id);
        setError('');
        setJob(event.detail);
      }
    };
    window.addEventListener('forge:memory-alert', open);
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('forge:memory-alert', open);
    };
  }, []);
  // Keyed on the id so a poll that refreshes the same alert does not log again.
  const alertJobId = job?.id ?? null;
  useEffect(() => {
    if (!alertJobId) {
      return undefined;
    }
    log.info('memory.alert.shown', { jobId: alertJobId });
    return () => {
      log.debug('memory.alert.hidden', { jobId: alertJobId });
    };
  }, [alertJobId]);
  async function retry() {
    if (!job) {
      return;
    }
    setWorking(true);
    setError('');
    try {
      await post(`/api/runtime/jobs/${job.id}/retry`);
      log.info('memory.retry.completed', { jobId: job.id });
      seen.current.delete(job.id);
      setJob(null);
    } catch (e) {
      log.warn('memory.retry.failed', { jobId: job.id, error: e });
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function offload(id) {
    if (!job) {
      return;
    }
    setWorking(true);
    setError('');
    try {
      await post(`/api/runtime/models/${id}/offload`);
      await post(`/api/runtime/jobs/${job.id}/retry`);
      log.info('memory.offload.completed', { jobId: job.id, modelId: id });
      seen.current.delete(job.id);
      setJob(null);
    } catch (e) {
      log.warn('memory.offload.failed', { jobId: job.id, modelId: id, error: e });
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      {job?.details && (
        <MemoryDialog
          target={MEMORY_TARGET_LABELS.get(job.type) ?? 'YuE2'}
          conflict={job.details}
          onClose={() => setJob(null)}
          onRetry={retry}
          onOffload={offload}
          working={working}
          error={error}
        />
      )}{' '}
      {!job && error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
