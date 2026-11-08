import { createLogger } from './app-log.js';
import { saveAsset } from './job-io.js';
import { derivedSubmission, sourceTrack, submission } from './music-request.js';

const log = createLogger('music');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The studio may have disconnected; sending to a closed channel would throw, so the
// message is dropped. The studio recovers the job state from YuE2 on its side.
function send(jobId, type, values = {}) {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}
// This worker is forked for one job. When the studio disconnects, exit so an orphaned
// worker does not keep polling YuE2.
process.on('disconnect', () => {
  log.info('music.process.disconnected');
  process.exit(0);
});
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
  const jobLog = log.child({ jobId: job.id });
  const stopJob = jobLog.time('music.job.completed');
  jobLog.info('music.job.started', {
    operation: job.request?.operation,
    hasRemoteId: Boolean(remoteId),
  });
  try {
    if (!remoteId) {
      // Extending or re-synthesizing names a track YuE2 already holds. Looking it up submits
      // nothing, so a failure here is a plain failure rather than an unknown outcome.
      let planned = null;
      if (job.request.operation) {
        try {
          planned = derivedSubmission(
            job.request,
            await sourceTrack(baseUrl, job.request.source_remote),
          );
        } catch (error) {
          jobLog.warn('music.source.lookup.failed', { error, operation: job.request.operation });
          send(job.id, 'failed', {
            error: `Could not find the source track in YuE2: ${String(error.message).slice(0, 500)}`,
          });
          return;
        }
      }
      let response, body;
      jobLog.info('music.submit.requested', {
        operation: job.request.operation,
        addSeconds: job.request.add_seconds,
      });
      try {
        const { path, payload } = planned || submission(job.request);
        response = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        body = await response.json();
      } catch (error) {
        jobLog.warn('music.submit.failed', { error, outcome: 'unknown' });
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check YuE2 before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        const isServerError = response.status >= 500;
        jobLog.warn('music.submit.rejected', { httpStatus: response.status });
        send(job.id, isServerError ? 'interrupted' : 'failed', {
          error: `YuE2 returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}. ${isServerError ? 'Check the engine before resolving this job.' : ''}`,
        });
        return;
      }
      // The studio endpoint wraps its jobs in a list; the compact v1 endpoint returns one job.
      body = Array.isArray(body.jobs) ? body.jobs[0] || {} : body;
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
        jobLog.warn('music.submit.rejected', { reason: 'missing_remote_id' });
        send(job.id, 'interrupted', {
          error:
            'YuE2 accepted the request without a usable job ID. Check YuE2 before resolving this job.',
        });
        return;
      }
      remoteId = body.id;
      jobLog.info('music.job.accepted', { remoteId });
      send(job.id, 'accepted', { remoteId });
    }
    let lastRemoteStatus = 'unknown';
    let isReconnecting = false;
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(remoteId)}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) {
          jobLog.warn('music.job.interrupted', { httpStatus: 404, reason: 'remote_missing' });
          send(job.id, 'interrupted', {
            error:
              'YuE2 no longer recognizes the remote job. Check its history before resolving this job.',
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
      } catch (error) {
        // Log the start of a reconnect streak only, not each retry in the loop.
        if (!isReconnecting) {
          isReconnecting = true;
          jobLog.warn('music.poll.failed', { error });
        }
        send(job.id, 'progress', { stage: 'Waiting to reconnect to YuE2.' });
        await sleep(5000);
        continue;
      }
      if (isReconnecting) {
        isReconnecting = false;
        jobLog.info('music.poll.recovered');
      }
      if (state.status !== lastRemoteStatus) {
        jobLog.info('music.job.state.changed', { from: lastRemoteStatus, to: state.status });
        lastRemoteStatus = state.status;
      }
      if (state.status === 'done') {
        break;
      }
      if (['failed', 'cancelled', 'canceled'].includes(state.status)) {
        jobLog.error('music.job.failed', { status: state.status });
        send(job.id, 'failed', {
          error: String(state.error || `YuE2 job ${state.status}.`).slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.stage || state.status || 'Rendering').slice(0, 300),
      });
      await sleep(3000);
    }
    send(job.id, 'finalizing');
    const stopSave = jobLog.time('music.output.saved');
    const output = await saveAsset(
      projectFolder,
      'music',
      job.id,
      'flac',
      `${baseUrl}/api/v1/jobs/${encodeURIComponent(remoteId)}/audio`,
    );
    stopSave();
    stopJob({ outcome: 'completed' });
    send(job.id, 'complete', { output });
  } catch (error) {
    jobLog.error('music.job.failed', { error });
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
