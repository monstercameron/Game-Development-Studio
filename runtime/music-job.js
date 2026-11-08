import { saveAsset } from './job-io.js';
import { derivedSubmission, sourceTrack, submission } from './music-request.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(jobId, type, values = {}) {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}
process.on('disconnect', () => process.exit(0));
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
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
          send(job.id, 'failed', {
            error: `Could not find the source track in YuE2: ${String(error.message).slice(0, 500)}`,
          });
          return;
        }
      }
      let response, body;
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
      } catch {
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check YuE2 before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `YuE2 returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}. ${response.status >= 500 ? 'Check the engine before resolving this job.' : ''}`,
        });
        return;
      }
      // The studio endpoint wraps its jobs in a list; the compact v1 endpoint returns one job.
      body = Array.isArray(body.jobs) ? body.jobs[0] || {} : body;
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
        send(job.id, 'interrupted', {
          error:
            'YuE2 accepted the request without a usable job ID. Check YuE2 before resolving this job.',
        });
        return;
      }
      remoteId = body.id;
      send(job.id, 'accepted', { remoteId });
    }
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/v1/jobs/${encodeURIComponent(remoteId)}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) {
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
      } catch {
        send(job.id, 'progress', { stage: 'Waiting to reconnect to YuE2.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'done') {
        break;
      }
      if (['failed', 'cancelled', 'canceled'].includes(state.status)) {
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
    const output = await saveAsset(
      projectFolder,
      'music',
      job.id,
      'flac',
      `${baseUrl}/api/v1/jobs/${encodeURIComponent(remoteId)}/audio`,
    );
    send(job.id, 'complete', { output });
  } catch (error) {
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
