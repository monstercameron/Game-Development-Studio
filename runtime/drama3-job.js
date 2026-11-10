// Run one Drama 3 request in an isolated native CUDA process owned by the queue worker.
import { generateDrama3 } from './drama3-runner.js';
import { createLogger } from './app-log.js';

const log = createLogger('voices');
const controller = new AbortController();
const send = (jobId, type, values = {}) => {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
};
process.on('disconnect', () => controller.abort());
process.on('message', (message) => {
  if (message?.type === 'cancel') {
    controller.abort();
  }
});
process.once('message', async ({ job, projectFolder }) => {
  try {
    send(job.id, 'progress', { stage: 'Generating speech on CUDA.' });
    const output = await generateDrama3({
      projectFolder,
      jobId: job.id,
      request: job.request,
      signal: controller.signal,
      onFinalizing: () => send(job.id, 'finalizing'),
    });
    send(job.id, 'complete', { output });
  } catch (error) {
    log.error('voices.drama3.job.failed', { jobId: job.id, errorClass: error?.name });
    send(job.id, 'failed', {
      error:
        error.name === 'AbortError'
          ? 'Generation was cancelled.'
          : String(error.message).slice(0, 1000),
    });
  } finally {
    setTimeout(() => process.exit(0), 100);
  }
});
