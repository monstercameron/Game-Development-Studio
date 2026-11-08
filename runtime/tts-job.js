import { createLogger } from './app-log.js';
import { saveAsset } from './job-io.js';
import { readAudioSource } from './references.js';

const log = createLogger('voices');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Logs a short error code or class name only. Error messages can contain local paths or text.
function errorCodeOf(error) {
  const code = error?.code ?? error?.cause?.code;
  if (typeof code === 'string') {
    return code;
  }
  return typeof error?.name === 'string' ? error.name : 'Error';
}

// A cloned voice sends its staged reference clip as base64. The queue keeps only the staged ID; the
// bytes are read here when the job runs, so the worker receives the snapshot taken at queue time.
async function workerRequest(request, projectFolder) {
  if (request.mode !== 'clone') {
    return request;
  }
  const { reference_audio: referenceAudio, ...rest } = request;
  let bytes;
  try {
    bytes = await readAudioSource(projectFolder, referenceAudio);
  } catch (error) {
    log.warn('voices.reference.read.failed', {
      reason: error?.code === 'ENOENT' ? 'missing_clip' : 'unreadable_clip',
      errorCode: errorCodeOf(error),
    });
    // The raw filesystem error names a local path; say what to do instead.
    throw Error(
      error?.code === 'ENOENT'
        ? 'The staged reference clip is no longer available. Choose the clip again and queue a new render.'
        : `The reference clip cannot be used: ${error.message}`,
      { cause: error },
    );
  }
  return { ...rest, reference_audio_base64: bytes.toString('base64') };
}

function send(jobId, type, values = {}) {
  // Progress is high volume (every poll), so it is traced; every other type is a state change.
  if (type === 'progress') {
    log.trace('voices.job.progress.reported', { jobId });
  } else {
    log.info('voices.job.state.changed', { jobId, to: type });
  }
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}

process.on('disconnect', () => {
  log.info('voices.process.stopped', { reason: 'disconnected' });
  process.exit(0);
});

process.once('message', async ({ job, projectFolder, baseUrl }) => {
  log.info('voices.job.started', {
    jobId: job.id,
    mode: job.request?.mode,
    hasRemoteId: Boolean(job.remoteId),
  });
  let remoteId = job.remoteId;
  try {
    if (!remoteId) {
      // Reading the staged clip happens before submission, so a missing clip fails the job cleanly.
      const requestBody = await workerRequest(job.request, projectFolder);
      let response, body;
      const stopGenerateRequest = log.time('voices.generate.request.completed', {
        jobId: job.id,
        mode: job.request.mode,
        route: '/api/generate',
      });
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(job.request.mode === 'clone' ? 60000 : 15000),
          redirect: 'error',
        });
        body = await response.json();
        stopGenerateRequest({ status: response.status });
      } catch (error) {
        log.warn('voices.generate.request.failed', {
          jobId: job.id,
          route: '/api/generate',
          outcome: 'unknown',
          errorCode: errorCodeOf(error),
        });
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check the speech worker before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        log.warn('voices.generate.request.rejected', { jobId: job.id, status: response.status });
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          // The worker explains a rejected request in a detail string; show that text alone.
          error:
            typeof body?.detail === 'string'
              ? `Speech worker returned ${response.status}: ${body.detail.slice(0, 1000)}`
              : `Speech worker returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        log.warn('voices.generate.response.rejected', { jobId: job.id, reason: 'invalid_job_id' });
        send(job.id, 'interrupted', {
          error: 'Speech worker accepted the request without a usable job ID. Check its output.',
        });
        return;
      }
      remoteId = body.id;
      send(job.id, 'accepted', { remoteId });
    }
    let truncated = false;
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/jobs/${remoteId}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        log.trace('voices.job.poll.completed', {
          jobId: job.id,
          route: '/api/jobs/:id',
          status: response.status,
        });
        if (response.status === 404) {
          send(job.id, 'interrupted', {
            error:
              'The speech worker no longer recognizes this job. Check its output before resolving.',
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
      } catch (error) {
        log.debug('voices.job.poll.failed', {
          jobId: job.id,
          route: '/api/jobs/:id',
          errorCode: errorCodeOf(error),
        });
        send(job.id, 'progress', { stage: 'Waiting to reconnect to the speech worker.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        truncated = state.truncated === true;
        break;
      }
      if (state.status === 'failed') {
        send(job.id, 'failed', {
          error: String(state.message || 'Speech generation failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || state.status || 'Generating speech.').slice(0, 300),
      });
      await sleep(2000);
    }
    send(job.id, 'finalizing');
    const output = await saveAsset(
      projectFolder,
      'voices',
      job.id,
      'wav',
      `${baseUrl}/api/jobs/${remoteId}/audio`,
    );
    log.info('voices.asset.saved', { jobId: job.id, extension: 'wav' });
    send(job.id, 'complete', {
      output,
      ...(truncated
        ? { stage: 'Completed. Reached the speech token limit, so the audio may end mid-sentence.' }
        : {}),
    });
  } catch (error) {
    log.error('voices.job.failed', { jobId: job.id, errorCode: errorCodeOf(error) });
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
