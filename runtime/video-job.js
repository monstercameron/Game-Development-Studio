import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { saveAsset } from './job-io.js';
import { videoProgress } from './video-progress.js';
import { failureMessage } from './video-failure.js';
import { buildSubmission, h3SupportsExtensions, removeJobInputs } from './video-media.js';

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
  } catch {
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
    try {
      await fs.link(temp, output);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return `video/${name}`;
}
process.on('disconnect', () => process.exit(0));
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
  // Prepared reference frames and audio are only needed until the render has ended.
  const end = async (type, values) => {
    await removeJobInputs(job.id);
    send(job.id, type, values);
  };
  try {
    if (!remoteId) {
      // Validate all persisted input before the irreversible submission.
      let submission;
      try {
        submission = await buildSubmission(projectFolder, job.id, job.request);
      } catch (error) {
        await end('failed', { error: `Could not read video references: ${error.message}` });
        return;
      }
      // An H3 service started before this Forge version would silently ignore the extra options.
      if (submission.extended && !(await h3SupportsExtensions(baseUrl))) {
        await end('failed', {
          error:
            'H3 Studio was started before this Forge update, so it would ignore the first/last frame, reference clip and other new video options. Restart the video engine from Models, then retry this job.',
        });
        return;
      }
      let response, body;
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission.body),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
      } catch {
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check H3 Studio before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        const message = `H3 Studio returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`;
        if (response.status >= 500) {
          send(job.id, 'interrupted', { error: message });
        } else {
          await end('failed', { error: message });
        }
        return;
      }
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
        send(job.id, 'interrupted', {
          error: 'H3 Studio accepted the request without a usable job ID. Check its output.',
        });
        return;
      }
      remoteId = body.id;
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
      } catch {
        send(job.id, 'progress', { stage: 'Waiting to reconnect to H3 Studio.' });
        await sleep(5000);
        continue;
      }
      const current = state.job?.id === remoteId ? state.job : null;
      if (current?.state === 'failed') {
        // H3's own answer is final, so Retry submits a fresh attempt instead of asking H3 about
        // this job again. Forge never resubmits it by itself.
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
        extra.stage = `Completed. The MP4 copy could not be made: ${String(error.message).slice(0, 150)}`;
      }
    }
    await end('complete', { output: result, ...extra });
  } catch (error) {
    await end('failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
