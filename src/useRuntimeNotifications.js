import { useEffect } from 'react';
import { announceCompletion } from './notifications';

const active = new Set([
  'queued',
  'waiting_engine',
  'waiting_memory',
  'needs_attention',
  'preparing',
  'submitting',
  'running',
  'finalizing',
  'interrupted',
]);
export function useRuntimeNotifications() {
  useEffect(() => {
    let previous = null,
      polling = false,
      stopped = false;
    async function poll() {
      if (polling || stopped) {
        return;
      }
      polling = true;
      try {
        const response = await fetch('/api/runtime/jobs');
        if (!response.ok) {
          return;
        }
        const { jobs } = await response.json();
        if (stopped) {
          return;
        }
        if (previous) {
          const completed = jobs.filter(
            (job) =>
              job.status === 'completed' &&
              previous.get(job.id) &&
              previous.get(job.id) !== 'completed',
          );
          for (const job of completed) {
            announceCompletion({
              type: 'render',
              id: job.id,
              name:
                job.request.title ||
                `${{ sfx: 'Sound effect', music: 'Music asset', images: 'Image', video: 'Video', voices: 'Voice', '3d': '3D shape', trellis: '3D model', motion: 'Motion clip', 'motion-bricks': 'Motion transition', segmentation: 'Segmentation' }[job.type] || 'Asset'} ready in your project.`,
            });
          }
          if (
            completed.length &&
            [...previous.values()].some((status) => active.has(status)) &&
            !jobs.some((job) => active.has(job.status))
          ) {
            announceCompletion({ type: 'queue', id: completed.at(-1).id });
          }
        }
        previous = new Map(jobs.map((job) => [job.id, job.status]));
      } catch {
        // Retain the last known state and retry on the next poll.
      } finally {
        polling = false;
      }
    }
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
}
