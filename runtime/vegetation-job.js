// Queue worker for 'vegetation' jobs, forked by JobQueue.launch(). Unlike the model workers it
// talks to no engine: it starts the isolated SeedThree child (vegetation-runner.js) and saves the
// GLB and preset into the project. There is no remote job, so nothing is uncertain after a crash:
// the plant is a pure function of its request and is simply grown again.
import { generateVegetationAsset } from './vegetation-runner.js';

const send = (jobId, type, values = {}) => {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
};
const controller = new AbortController();
process.on('disconnect', () => {
  controller.abort();
  process.exit(0);
});
process.on('message', (message) => {
  if (message?.type === 'cancel') {
    controller.abort();
  }
});
process.once('message', async ({ job, projectFolder }) => {
  try {
    const timeoutMs = Number(process.env.FORGE_VEGETATION_TIMEOUT_MS) || undefined;
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
  } catch (error) {
    if (error.name === 'AbortError') {
      send(job.id, 'failed', { error: 'Generation was cancelled.' });
    } else {
      send(job.id, 'failed', { error: String(error.message || error).slice(0, 1000) });
    }
  } finally {
    // Let the queue read the final message before the process ends.
    setTimeout(() => process.exit(0), 100);
  }
});
