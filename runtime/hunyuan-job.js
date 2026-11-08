import { createLogger } from './app-log.js';
import { saveAsset } from './job-io.js';
import { readReferences } from './references.js';

const log = createLogger('three-d');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(jobId, type, values = {}) {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}
process.on('disconnect', () => {
  log.info('three-d.process.disconnected');
  process.exit(0);
});
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  const jobLog = log.child({ jobId: job.id });
  let remoteId = job.remoteId;
  jobLog.info('three-d.job.started', { engine: job.type, hasRemoteId: Boolean(remoteId) });
  const name = job.type === 'trellis' ? 'TRELLIS.2' : 'Hunyuan';
  try {
    if (!remoteId) {
      let image;
      try {
        [image] = await readReferences(projectFolder, job.request.references, { max: 1 });
      } catch (error) {
        jobLog.warn('three-d.reference.read.failed', { error });
        send(job.id, 'failed', { error: `Could not read the reference image: ${error.message}` });
        return;
      }
      let response, body;
      const settings =
        job.type === 'trellis'
          ? {
              texture_size: job.request.texture_size,
              ...(job.request.target_faces ? { target_faces: job.request.target_faces } : {}),
              ...(job.request.pipeline ? { pipeline: job.request.pipeline } : {}),
            }
          : {
              resolution: job.request.resolution,
              ...(job.request.guidance ? { guidance_scale: job.request.guidance } : {}),
              ...(job.request.target_faces ? { target_faces: job.request.target_faces } : {}),
              ...(job.request.texture === true
                ? {
                    texture: true,
                    texture_size: job.request.texture_size,
                    ...(job.request.texture_views
                      ? { texture_views: job.request.texture_views }
                      : {}),
                    ...(job.request.texture_view_size
                      ? { texture_view_size: job.request.texture_view_size }
                      : {}),
                  }
                : {}),
            };
      const stopSubmit = jobLog.time('three-d.submit.finished', { route: '/api/generate' });
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image,
            seed: job.request.seed,
            steps: job.request.steps,
            ...settings,
          }),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
        stopSubmit({ outcome: 'received', status: response.status });
      } catch (error) {
        jobLog.warn('three-d.submit.unknown', { route: '/api/generate', error });
        send(job.id, 'interrupted', {
          error: `Submission result is unknown. Check the ${name} worker before resolving this job.`,
        });
        return;
      }
      if (!response.ok) {
        jobLog.warn('three-d.submit.rejected', { status: response.status });
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          // FastAPI puts a readable validation message in "detail"; keep it unwrapped.
          error: `${name} returned ${response.status}: ${
            typeof body?.detail === 'string'
              ? body.detail.slice(0, 1000)
              : JSON.stringify(body).slice(0, 1000)
          }`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        jobLog.warn('three-d.submit.rejected', { reason: 'invalid_job_id' });
        send(job.id, 'interrupted', {
          error: `${name} accepted the request without a usable job ID. Check its output.`,
        });
        return;
      }
      remoteId = body.id;
      jobLog.info('three-d.job.accepted', { remoteId });
      send(job.id, 'accepted', { remoteId });
    }
    let isReconnecting = false;
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/jobs/${remoteId}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) {
          jobLog.warn('three-d.job.missing', { status: 404 });
          send(job.id, 'interrupted', {
            error: `The ${name} worker no longer recognizes this job. Check its output before resolving.`,
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
        if (isReconnecting) {
          isReconnecting = false;
          jobLog.info('three-d.poll.recovered');
        }
      } catch (error) {
        if (!isReconnecting) {
          isReconnecting = true;
          jobLog.warn('three-d.poll.failed', { route: '/api/jobs/:id', error });
        }
        send(job.id, 'progress', { stage: `Waiting to reconnect to the ${name} worker.` });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        jobLog.info('three-d.generate.completed');
        break;
      }
      if (state.status === 'failed') {
        jobLog.error('three-d.generate.failed', { reason: 'worker_reported' });
        send(job.id, 'failed', {
          error: String(state.message || '3D generation failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || state.status || 'Generating shape.').slice(0, 300),
      });
      await sleep(2000);
    }
    send(job.id, 'finalizing');
    const stopSave = jobLog.time('three-d.output.saved', { extension: 'glb' });
    const output = await saveAsset(
      projectFolder,
      '3d',
      job.id,
      'glb',
      `${baseUrl}/api/jobs/${remoteId}/mesh`,
    );
    stopSave({ outcome: 'completed' });
    send(job.id, 'complete', { output });
  } catch (error) {
    jobLog.error('three-d.job.failed', { error });
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
