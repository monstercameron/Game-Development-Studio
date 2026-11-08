// Queue worker for 'vegetation' jobs, forked by JobQueue.launch(). Unlike the model workers it
// talks to no engine: it starts the isolated SeedThree child (vegetation-runner.js) and saves the
// GLB and preset into the project. There is no remote job, so nothing is uncertain after a crash:
// the plant is a pure function of its request and is simply grown again.
import { createLogger } from './app-log.js';
import { getSetting } from './core-settings.js';
import { generateVegetationAsset } from './vegetation-runner.js';

const log = createLogger('vegetation');

const send = (jobId, type, values = {}) => {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
};
const controller = new AbortController();
process.on('disconnect', () => {
  log.info('vegetation.job.disconnected', { reason: 'parent_gone' });
  controller.abort();
  process.exit(0);
});
process.on('message', (message) => {
  if (message?.type === 'cancel') {
    log.info('vegetation.job.cancel.requested');
    controller.abort();
  }
});
process.once('message', async ({ job, projectFolder }) => {
  const jobLog = log.child({ jobId: job?.id });
  const stopJob = jobLog.time('vegetation.job.finished');
  try {
    // The vegetation.timeoutMs setting (environment variable first, default 120000 ms).
    const timeoutMs = getSetting('vegetation.timeoutMs');
    jobLog.info('vegetation.job.started', { timeoutMs });
    const generated = await generateVegetationAsset({
      projectFolder,
      jobId: job.id,
      request: job.request,
      signal: controller.signal,
      timeoutMs,
      onStage: (stage) => send(job.id, 'progress', { stage }),
    });
    send(job.id, 'complete', {
      output: generated.output,
      extraOutputs: [generated.presetOutput],
      result: generated.result,
      stage: `Completed: ${generated.result.triangles.toLocaleString('en-US')} triangles.`,
    });
    stopJob({ outcome: 'completed' });
  } catch (error) {
    if (error.name === 'AbortError') {
      stopJob({ outcome: 'cancelled' });
      send(job.id, 'failed', { error: 'Generation was cancelled.' });
    } else {
      stopJob({ outcome: 'failed' });
      jobLog.error('vegetation.job.failed', { error });
      send(job.id, 'failed', { error: String(error.message || error).slice(0, 1000) });
    }
  } finally {
    // Let the queue read the final message before the process ends.
    setTimeout(() => process.exit(0), 100);
  }
});
