import { createLogger } from './app-log.js';
import { saveAsset } from './job-io.js';
import { requireAudioInput, soundPayload } from './sfx-request.js';

const log = createLogger('sfx');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(jobId, type, values = {}) {
  // Progress is high volume (every poll), so it is traced; every other type is a state change.
  if (type === 'progress') {
    log.trace('sfx.job.progress.reported', { jobId });
  } else {
    log.info('sfx.job.state.changed', { jobId, to: type });
  }
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}
process.on('disconnect', () => {
  log.info('sfx.process.stopped', { reason: 'disconnected' });
  process.exit(0);
});
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  log.info('sfx.job.started', { jobId: job.id, hasRemoteId: Boolean(job.remoteId) });
  let remoteId = job.remoteId;
  try {
    if (!remoteId) {
      let session;
      try {
        const stopSessionRequest = log.time('sfx.session.request.completed', {
          jobId: job.id,
          route: '/api/session',
        });
        const response = await fetch(`${baseUrl}/api/session`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        const data = await response.json();
        if (!response.ok || typeof data.session !== 'string') {
          throw Error('Invalid session');
        }
        session = data.session;
        stopSessionRequest({ status: response.status });
      } catch (error) {
        log.warn('sfx.session.request.failed', {
          jobId: job.id,
          route: '/api/session',
          error,
        });
        send(job.id, 'failed', {
          error: 'Could not obtain a Stable Audio session. No job was submitted.',
        });
        return;
      }
      // A source sound is read and the Lab's support checked before anything is submitted, so a
      // failure here is a plain failure and not an unknown outcome.
      let payload;
      try {
        payload = await soundPayload(job.request, projectFolder);
        if (job.request.source_audio) {
          await requireAudioInput(baseUrl);
        }
      } catch (error) {
        log.warn('sfx.request.prepare.failed', { jobId: job.id, error });
        send(job.id, 'failed', { error: String(error.message).slice(0, 1000) });
        return;
      }
      let response, body;
      const stopGenerateRequest = log.time('sfx.generate.request.completed', {
        jobId: job.id,
        route: '/api/generate',
      });
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lab-Session': session },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(job.request.source_audio ? 60000 : 15000),
          redirect: 'error',
        });
        body = await response.json();
        stopGenerateRequest({ status: response.status });
      } catch (error) {
        log.warn('sfx.generate.request.failed', {
          jobId: job.id,
          route: '/api/generate',
          outcome: 'unknown',
          error,
        });
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check Stable Audio Lab before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        log.warn('sfx.generate.request.rejected', { jobId: job.id, status: response.status });
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `Stable Audio returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.job_id)) {
        log.warn('sfx.generate.response.rejected', { jobId: job.id, reason: 'invalid_job_id' });
        send(job.id, 'interrupted', {
          error: 'Stable Audio accepted the request without a usable job ID. Check its history.',
        });
        return;
      }
      remoteId = body.job_id;
      send(job.id, 'accepted', { remoteId });
    }
    let state;
    while (true) {
      try {
        const response = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(remoteId)}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) {
          send(job.id, 'interrupted', {
            error:
              'Stable Audio no longer recognizes the remote job. Check its history before resolving.',
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
      } catch (error) {
        log.warn('sfx.job.poll.failed', { jobId: job.id, route: '/api/jobs/:id', error });
        send(job.id, 'progress', { stage: 'Waiting to reconnect to Stable Audio.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        break;
      }
      if (state.status === 'failed') {
        send(job.id, 'failed', {
          error: String(state.error || 'Stable Audio failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', { stage: String(state.status || 'Rendering').slice(0, 300) });
      await sleep(3000);
    }
    const audio = state.result?.url;
    if (typeof audio !== 'string' || !/^\/audio\/[a-zA-Z0-9._-]+\.wav$/.test(audio)) {
      log.warn('sfx.result.rejected', { jobId: job.id, reason: 'invalid_audio_path' });
      throw Error('Stable Audio returned an invalid audio path.');
    }
    send(job.id, 'finalizing');
    const stopOutputSave = log.time('sfx.output.save.completed', { jobId: job.id, kind: 'sfx' });
    const output = await saveAsset(projectFolder, 'sfx', job.id, 'wav', `${baseUrl}${audio}`);
    stopOutputSave();
    send(job.id, 'complete', { output });
  } catch (error) {
    log.error('sfx.job.run.failed', { jobId: job.id, error });
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
