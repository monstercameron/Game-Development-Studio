import { createLogger } from './app-log.js';
import { saveAsset } from './job-io.js';
import { readPose } from './references.js';

const log = createLogger('motion');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(jobId, type, values = {}) {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}
process.on('disconnect', () => {
  log.info('motion.process.disconnected', { exitCode: 0 });
  process.exit(0);
});
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
  log.info('motion.job.started', { jobId: job.id, isResumed: Boolean(remoteId) });
  try {
    if (!remoteId) {
      // Read before submitting, so missing or modified inputs cannot become an
      // ambiguous remote submission after a process restart.
      const { pose, ...settings } = job.request;
      let bvh;
      try {
        bvh = await readPose(projectFolder, pose);
      } catch (error) {
        log.warn('motion.pose.read.failed', { jobId: job.id, error });
        send(job.id, 'failed', { error: `Could not read staged pose: ${error.message}` });
        return;
      }
      let response, body;
      try {
        const stopSubmit = log.time('motion.request.completed', {
          route: '/api/generate-bvh',
          jobId: job.id,
        });
        response = await fetch(`${baseUrl}/api/generate-bvh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bvh, ...settings }),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
        stopSubmit({ httpStatus: response.status });
      } catch (error) {
        log.warn('motion.request.failed', {
          jobId: job.id,
          route: '/api/generate-bvh',
          error,
        });
        send(job.id, 'interrupted', {
          error:
            'Submission result is unknown. Check the MotionBricks worker before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        log.warn('motion.request.rejected', {
          jobId: job.id,
          route: '/api/generate-bvh',
          httpStatus: response.status,
        });
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `MotionBricks returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        log.warn('motion.job.interrupted', { jobId: job.id, reason: 'invalid_remote_id' });
        send(job.id, 'interrupted', {
          error: 'MotionBricks accepted the request without a usable job ID. Check its output.',
        });
        return;
      }
      remoteId = body.id;
      log.info('motion.job.accepted', { jobId: job.id, remoteId });
      send(job.id, 'accepted', { remoteId });
    }
    let previousRemoteStatus;
    let isReconnecting = false;
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/jobs/${remoteId}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) {
          log.warn('motion.job.interrupted', {
            jobId: job.id,
            httpStatus: 404,
            reason: 'remote_unknown',
          });
          send(job.id, 'interrupted', {
            error: 'MotionBricks no longer recognizes this job. Check its output before resolving.',
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
        isReconnecting = false;
      } catch (error) {
        // Log only the first failure of an outage; each poll would otherwise repeat it.
        if (!isReconnecting) {
          isReconnecting = true;
          log.warn('motion.request.failed', { jobId: job.id, route: '/api/jobs/:id', error });
        }
        send(job.id, 'progress', { stage: 'Waiting to reconnect to MotionBricks.' });
        await sleep(5000);
        continue;
      }
      if (state.status !== previousRemoteStatus) {
        log.info('motion.job.state.changed', {
          jobId: job.id,
          from: previousRemoteStatus,
          to: state.status,
        });
        previousRemoteStatus = state.status;
      }
      if (state.status === 'completed') {
        break;
      }
      if (state.status === 'failed') {
        log.error('motion.job.failed', { jobId: job.id, reason: 'remote_failed' });
        send(job.id, 'failed', {
          error: String(state.message || 'MotionBricks generation failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || state.status || 'Generating motion.').slice(0, 300),
      });
      await sleep(2000);
    }
    log.info('motion.job.state.changed', { jobId: job.id, to: 'finalizing' });
    send(job.id, 'finalizing');
    const stopSave = log.time('motion.output.saved', { jobId: job.id, extension: 'bvh' });
    const output = await saveAsset(
      projectFolder,
      'motion',
      job.id,
      'bvh',
      `${baseUrl}/api/jobs/${remoteId}/output`,
    );
    stopSave();
    log.info('motion.job.completed', { jobId: job.id });
    send(job.id, 'complete', { output });
  } catch (error) {
    log.error('motion.job.failed', { jobId: job.id, error });
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
