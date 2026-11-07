import { useEffect, useRef, useState } from 'react';
import MemoryDialog from './MemoryDialog';
import { post } from './RuntimeQueue';

export default function MemoryAlerts() {
  const [job, setJob] = useState(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState('');
  const seen = useRef(new Set());
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const response = await fetch('/api/runtime/jobs');
        if (!response.ok) {
          return;
        }
        const data = await response.json();
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
      } catch {
        // Polling is best-effort; the next interval retries.
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
  async function retry() {
    if (!job) {
      return;
    }
    setWorking(true);
    setError('');
    try {
      await post(`/api/runtime/jobs/${job.id}/retry`);
      seen.current.delete(job.id);
      setJob(null);
    } catch (e) {
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
      seen.current.delete(job.id);
      setJob(null);
    } catch (e) {
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
