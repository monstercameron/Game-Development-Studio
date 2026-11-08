import { createLogger } from './app-log.js';
import { saveAsset } from './job-io.js';
import { readReferences } from './references.js';
const log = createLogger('world');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Logs carry the error class and code only; error messages can echo request or worker text.
const errorFields = (error) => ({
  errorClass: String(error?.name || 'Error'),
  errorCode: String(error?.code || error?.cause?.code || 'unknown'),
});
const send = (jobId, type, values = {}) => {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
};
process.on('disconnect', () => {
  log.info('world.process.disconnected', { pid: process.pid });
  process.exit(0);
});
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
  const stopJob = log.time('world.job.completed', { jobId: job.id });
  log.info('world.job.started', { jobId: job.id, hasRemoteId: Boolean(remoteId) });
  try {
    if (!remoteId) {
      const { references, ...settings } = job.request;
      const images = references.length
        ? await readReferences(projectFolder, references, { max: 8 })
        : [];
      let response, body;
      const stopGenerateRequest = log.time('world.request.responded', {
        jobId: job.id,
        method: 'POST',
        route: '/api/generate',
      });
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...settings, images }),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
        stopGenerateRequest({ status: response.status });
      } catch (error) {
        log.warn('world.request.failed', {
          jobId: job.id,
          route: '/api/generate',
          ...errorFields(error),
        });
        send(job.id, 'interrupted', {
          error: 'World submission may have started. Check the world worker before retrying.',
        });
        return;
      }
      if (!response.ok) {
        if (response.status >= 500) {
          log.warn('world.job.interrupted', {
            jobId: job.id,
            status: response.status,
            reason: 'worker_error',
          });
        } else {
          log.error('world.job.failed', {
            jobId: job.id,
            status: response.status,
            reason: 'request_rejected',
          });
        }
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `World worker returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        log.warn('world.response.rejected', { jobId: job.id, reason: 'invalid_job_id' });
        send(job.id, 'interrupted', { error: 'World worker returned an invalid job ID.' });
        return;
      }
      remoteId = body.id;
      log.info('world.remote.accepted', { jobId: job.id, remoteId });
      send(job.id, 'accepted', { remoteId });
    }
    while (true) {
      let state;
      try {
        const statusResponse = await fetch(`${baseUrl}/api/jobs/${remoteId}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        log.trace('world.status.polled', { jobId: job.id, status: statusResponse.status });
        if (statusResponse.status === 404) {
          log.warn('world.job.interrupted', {
            jobId: job.id,
            status: statusResponse.status,
            reason: 'remote_job_missing',
          });
          send(job.id, 'interrupted', {
            error:
              'The world worker no longer recognizes this job. Check Diagnostics before retrying.',
          });
          return;
        }
        if (!statusResponse.ok) {
          throw Error(`HTTP ${statusResponse.status}`);
        }
        state = await statusResponse.json();
      } catch (error) {
        log.warn('world.status.poll.failed', { jobId: job.id, ...errorFields(error) });
        send(job.id, 'progress', { stage: 'Waiting to reconnect to the world worker.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        break;
      }
      if (state.status === 'failed') {
        log.error('world.job.failed', { jobId: job.id, reason: 'worker_reported_failure' });
        send(job.id, 'failed', {
          error: String(state.message || 'World generation failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || 'Generating world.').slice(0, 300),
      });
      await sleep(2000);
    }
    send(job.id, 'finalizing');
    // A mesh can be exported as GLB; everything else is a PLY.
    const worldExtension = job.request.output === 'glb' ? 'glb' : 'ply';
    const output = await saveAsset(
      projectFolder,
      '3d',
      job.id,
      worldExtension,
      `${baseUrl}/api/jobs/${remoteId}/world`,
    );
    log.info('world.asset.saved', { jobId: job.id, kind: 'world', extension: worldExtension });
    const extraOutputs = [];
    let stage;
    if (job.request.save_panorama) {
      try {
        extraOutputs.push(
          await saveAsset(
            projectFolder,
            'images',
            `${job.id}-panorama`,
            'png',
            `${baseUrl}/api/jobs/${remoteId}/panorama`,
          ),
        );
        log.info('world.asset.saved', { jobId: job.id, kind: 'panorama', extension: 'png' });
      } catch (error) {
        log.warn('world.asset.failed', { jobId: job.id, kind: 'panorama', ...errorFields(error) });
        // The world itself is finished; say plainly that the extra image was not kept.
        stage = `Completed. The panorama image could not be saved: ${String(error.message).slice(0, 150)}`;
      }
    }
    stopJob({ extraOutputCount: extraOutputs.length });
    send(job.id, 'complete', { output, extraOutputs, stage });
  } catch (error) {
    log.error('world.job.failed', { jobId: job.id, ...errorFields(error) });
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
