import { useEffect } from 'react';
import { announceCompletion } from './notifications';
import { createLog } from './app-log.js';

const log = createLog('ui');

// Statuses that mean the runtime still has work. The queue-level notice is only sent
// after no job remains in this set, so a finished job is not announced too early.
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

// Display names for the completion notice. Keys are persisted job types.
const JOB_TYPE_NAMES = {
  sfx: 'Sound effect',
  music: 'Music asset',
  images: 'Image',
  video: 'Video',
  voices: 'Voice',
  drama3: 'Drama 3 voice',
  '3d': '3D shape',
  trellis: '3D model',
  motion: 'Motion clip',
  'motion-bricks': 'Motion transition',
  segmentation: 'Segmentation',
  vegetation: 'Plant model',
};

export function useRuntimeNotifications() {
  useEffect(() => {
    let previous = null,
      polling = false,
      stopped = false,
      isPollFailing = false,
      isTrayFailing = false;
    async function poll() {
      if (polling || stopped) {
        return;
      }
      polling = true;
      try {
        // log-coverage: ignore -- same-origin /api request; the browser capture logs failures.
        const response = await fetch('/api/runtime/jobs');
        if (!response.ok) {
          return;
        }
        const { jobs } = await response.json();
        if (stopped) {
          return;
        }
        // Only check the optional tray when a completion might need an alert. This avoids
        // probing it continuously while idle, and the browser remains the fallback on timeout.
        const completed = previous
          ? jobs.filter(
              (job) =>
                job.status === 'completed' &&
                previous.get(job.id) &&
                previous.get(job.id) !== 'completed',
            )
          : [];
        let tray = { active: false };
        try {
          if (completed.length) {
            // log-coverage: ignore -- fallback failures are logged once per streak below.
            const trayResponse = await fetch('/api/tray/status', {
              signal: AbortSignal.timeout(2000),
            });
            if (trayResponse.ok) {
              tray = await trayResponse.json();
            } else {
              throw new Error(`Tray status returned HTTP ${trayResponse.status}.`);
            }
            isTrayFailing = false;
          }
        } catch (error) {
          // Browser notifications remain available when the tray is unreachable.
          if (!isTrayFailing) {
            isTrayFailing = true;
            log.debug('ui.tray.status.failed', { errorClass: error?.name || 'Error' });
          }
        }
        if (stopped) {
          return;
        }
        if (previous) {
          for (const job of completed) {
            if (tray.active && tray.render) {
              log.debug('ui.completion.skipped', { jobId: job.id, reason: 'tray_shows_render' });
              continue;
            }
            log.info('ui.completion.announced', { jobId: job.id, type: 'render' });
            announceCompletion({
              type: 'render',
              id: job.id,
              name:
                job.request.title ||
                `${JOB_TYPE_NAMES[job.type] || 'Asset'} ready in your project.`,
            });
          }
          if (
            completed.length &&
            [...previous.values()].some((status) => active.has(status)) &&
            !jobs.some((job) => active.has(job.status)) &&
            !(tray.active && tray.queue)
          ) {
            log.info('ui.completion.announced', { type: 'queue' });
            announceCompletion({ type: 'queue', id: completed.at(-1).id });
          }
        }
        previous = new Map(jobs.map((job) => [job.id, job.status]));
        isPollFailing = false;
      } catch (error) {
        // Retain the last known state and retry on the next poll.
        if (!isPollFailing) {
          isPollFailing = true;
          log.debug('ui.runtime.poll.failed', { errorClass: error?.name || 'Error' });
        }
      } finally {
        polling = false;
      }
    }
    poll();
    // log-coverage: ignore -- polling loop; failures are logged once per streak inside poll().
    const timer = setInterval(poll, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
}
