import { useEffect, useRef, useState } from 'react';
import MemoryDialog from './MemoryDialog';
import { post } from './RuntimeQueue';
import { createLog } from './app-log.js';

const log = createLog('memory');

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
      } catch (error) {
        // Polling is best-effort; the next interval retries. Logged once per failure streak.
        if (!isPollFailing) {
          isPollFailing = true;
          log.debug('memory.alert.poll.failed', { error });
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
          target={
            job.type === 'video'
              ? 'H3 Studio'
              : job.type === 'images'
                ? 'Qwen Image'
                : job.type === 'sfx'
                  ? 'Stable Audio'
                  : job.type === 'voices'
                    ? 'Qwen3-TTS'
                    : job.type === '3d'
                      ? 'Hunyuan3D'
                      : job.type === 'trellis'
                        ? 'TRELLIS.2'
                        : job.type === 'segmentation'
                          ? 'SAM 3.1'
                          : job.type === 'motion'
                            ? 'HY-Motion'
                            : job.type === 'motion-bricks'
                              ? 'MotionBricks'
                              : 'YuE2'
          }
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
