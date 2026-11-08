import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveAsset } from './job-io.js';
import { fsyncFile } from './durable-file.js';
import { videoProgress } from './video-progress.js';
import { failureMessage } from './video-failure.js';
import { buildSubmission, h3SupportsExtensions, removeJobInputs } from './video-media.js';
import { createLogger } from './app-log.js';

const log = createLogger('video');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function send(jobId, type, values = {}) {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
}
// H.264 + AAC copy of the WebM. The WebM is already saved; a failure here never fails the job.
async function saveMp4(projectFolder, jobId, webm) {
  const { convertFile } = await import('./transcode.js');
  const project = await fs.realpath(projectFolder),
    folder = path.join(project, 'video'),
    name = `forge-${jobId}.mp4`,
    output = path.join(folder, name),
    temp = path.join(folder, `.${name}.${randomUUID()}.part.mp4`);
  try {
    if ((await fs.stat(output)).size > 0) {
      return `video/${name}`;
    }
  } catch (error) {
    log.debug('video.mp4.lookup.missed', { jobId, error });
    // Not converted yet.
  }
  try {
    await convertFile({
      source: path.join(project, ...webm.split('/')),
      target: temp,
      kind: 'video',
      format: 'mp4',
      quality: 90,
      background: '#ffffff',
    });
    // Flushed before the final name exists, like saveAsset.
    await fsyncFile(temp);
    try {
      await fs.link(temp, output);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch((error) => {
      log.debug('video.temp.cleanup.failed', { jobId, error });
    });
  }
  return `video/${name}`;
}
process.on('disconnect', () => {
  log.info('video.process.disconnected', { pid: process.pid });
  process.exit(0);
});
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
  const stopJob = log.time('video.job.finished', { jobId: job.id });
  log.info('video.job.started', {
    jobId: job.id,
    pid: process.pid,
    hasRemoteId: Boolean(remoteId),
  });
  // Prepared reference frames and audio are only needed until the render has ended.
  const end = async (type, values) => {
    await removeJobInputs(job.id);
    stopJob({ outcome: type });
    send(job.id, type, values);
  };
  try {
    if (!remoteId) {
      // Validate all persisted input before the irreversible submission.
      let submission;
      try {
        submission = await buildSubmission(projectFolder, job.id, job.request);
      } catch (error) {
        log.warn('video.references.read.failed', { jobId: job.id, error });
        await end('failed', { error: `Could not read video references: ${error.message}` });
        return;
      }
      // An H3 service started before this Forge version would silently ignore the extra options.
      if (submission.extended && !(await h3SupportsExtensions(baseUrl))) {
        log.warn('video.engine.restart.required', {
          jobId: job.id,
          reason: 'extensions_unsupported',
        });
        await end('failed', {
          error:
            'H3 Studio was started before this Forge update, so it would ignore the first/last frame, reference clip and other new video options. Restart the video engine from Models, then retry this job.',
        });
        return;
      }
      let response, body;
      const stopSubmit = log.time('video.request.completed', {
        jobId: job.id,
        route: '/api/generate',
      });
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission.body),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
        stopSubmit({ httpStatus: response.status });
      } catch (error) {
        log.warn('video.request.failed', {
          jobId: job.id,
          route: '/api/generate',
          error,
        });
        log.warn('video.job.interrupted', {
          jobId: job.id,
          reason: 'submission_unknown',
        });
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check H3 Studio before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        log.warn('video.request.rejected', {
          jobId: job.id,
          route: '/api/generate',
          httpStatus: response.status,
        });
        const message = `H3 Studio returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`;
        if (response.status >= 500) {
          log.warn('video.job.interrupted', {
            jobId: job.id,
            reason: 'http_server_error',
          });
          send(job.id, 'interrupted', { error: message });
        } else {
          await end('failed', { error: message });
        }
        return;
      }
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
        log.warn('video.job.interrupted', {
          jobId: job.id,
          reason: 'invalid_remote_id',
        });
        send(job.id, 'interrupted', {
          error: 'H3 Studio accepted the request without a usable job ID. Check its output.',
        });
        return;
      }
      remoteId = body.id;
      log.info('video.remote.accepted', { jobId: job.id, remoteId });
      send(job.id, 'accepted', { remoteId });
    }
    let output;
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/status`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        log.trace('video.status.polled', {
          jobId: job.id,
          route: '/api/status',
          httpStatus: response.status,
        });
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
        if (
          typeof state.ready !== 'boolean' ||
          !Array.isArray(state.files) ||
          !Array.isArray(state.videos)
        ) {
          throw Error('Unexpected H3 status');
        }
      } catch (error) {
        log.warn('video.status.poll.failed', {
          jobId: job.id,
          route: '/api/status',
          error,
        });
        send(job.id, 'progress', { stage: 'Waiting to reconnect to H3 Studio.' });
        await sleep(5000);
        continue;
      }
      const current = state.job?.id === remoteId ? state.job : null;
      if (current?.state === 'failed') {
        // H3's own answer is final, so Retry submits a fresh attempt instead of asking H3 about
        // this job again. Forge never resubmits it by itself.
        log.warn('video.engine.render.failed', {
          jobId: job.id,
          reason: 'engine_failed',
        });
        await end('failed', {
          error: failureMessage(current),
          engineFailure: true,
        });
        return;
      }
      if (current?.state === 'complete') {
        output = current.output;
      }
      // H3's gallery also lists files that may still be written by an orphaned
      // renderer after its server crashes. A filename is not a completion record.
      else if (!current) {
        log.warn('video.job.interrupted', {
          jobId: job.id,
          reason: 'job_not_recognized',
        });
        send(job.id, 'interrupted', {
          error:
            'H3 Studio no longer recognizes this job. An output file alone does not prove the render finished; check H3 and its rendering process before resolving.',
        });
        return;
      }
      if (output) {
        break;
      }
      if (current.state !== 'running') {
        log.warn('video.job.interrupted', {
          jobId: job.id,
          reason: 'unexpected_state',
        });
        send(job.id, 'interrupted', {
          error: 'H3 Studio returned an unexpected job state. Check its output before resolving.',
        });
        return;
      }
      send(job.id, 'progress', {
        stage:
          videoProgress(current.details, job.request.steps) ||
          String(current.message || 'Rendering video.').slice(0, 300),
      });
      await sleep(3000);
    }
    if (output !== `${remoteId}.webm`) {
      throw Error('H3 Studio returned an invalid video path.');
    }
    send(job.id, 'finalizing');
    const result = await saveAsset(
      projectFolder,
      'video',
      job.id,
      'webm',
      `${baseUrl}/videos/${encodeURIComponent(output)}`,
    );
    const extra = {};
    if (job.request.also_mp4) {
      send(job.id, 'progress', { stage: 'Saving an MP4 (H.264) copy.' });
      try {
        extra.conversions = [{ path: await saveMp4(projectFolder, job.id, result), format: 'mp4' }];
      } catch (error) {
        log.warn('video.mp4.convert.failed', { jobId: job.id, error });
        extra.stage = `Completed. The MP4 copy could not be made: ${String(error.message).slice(0, 150)}`;
      }
    }
    await end('complete', { output: result, ...extra });
  } catch (error) {
    log.error('video.job.failed', { jobId: job.id, error });
    await end('failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
