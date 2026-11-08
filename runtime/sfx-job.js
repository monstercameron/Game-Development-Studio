import { saveAsset } from './job-io.js';
import { requireAudioInput, soundPayload } from './sfx-request.js';

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
      let session;
      try {
        const response = await fetch(`${baseUrl}/api/session`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        const data = await response.json();
        if (!response.ok || typeof data.session !== 'string') {
          throw Error('Invalid session');
        }
        session = data.session;
      } catch {
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
        send(job.id, 'failed', { error: String(error.message).slice(0, 1000) });
        return;
      }
      let response, body;
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Lab-Session': session },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(job.request.source_audio ? 60000 : 15000),
          redirect: 'error',
        });
        body = await response.json();
      } catch {
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check Stable Audio Lab before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `Stable Audio returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.job_id)) {
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
      } catch {
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
      throw Error('Stable Audio returned an invalid audio path.');
    }
    send(job.id, 'finalizing');
    const output = await saveAsset(projectFolder, 'sfx', job.id, 'wav', `${baseUrl}${audio}`);
    send(job.id, 'complete', { output });
  } catch (error) {
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
