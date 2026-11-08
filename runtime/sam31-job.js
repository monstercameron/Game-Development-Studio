import { saveAsset } from './job-io.js';
import { readReferences } from './references.js';
import {
  SAM31_OPTION_FEATURE,
  reportFromWorkerMetadata,
  usesSegmentationOptions,
} from './sam31-options.js';

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
      let image;
      try {
        [image] = await readReferences(projectFolder, job.request.references, { max: 1 });
      } catch (error) {
        send(job.id, 'failed', { error: `Could not read the reference image: ${error.message}` });
        return;
      }
      // A worker started before match selection existed would ignore the field and return every
      // match. Nothing has been submitted yet, so refusing here is a known outcome.
      if (usesSegmentationOptions(job.request)) {
        let features;
        try {
          const status = await fetch(`${baseUrl}/api/status`, {
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          });
          features = (await status.json()).features;
        } catch (error) {
          send(job.id, 'failed', {
            error: `Could not check the SAM worker version: ${String(error.message).slice(0, 300)}`,
          });
          return;
        }
        if (!Array.isArray(features) || !features.includes(SAM31_OPTION_FEATURE)) {
          send(job.id, 'failed', {
            error:
              'The running SAM worker is older than the match selection and outline options. Stop the SAM 3.1 engine and start it again, then retry.',
          });
          return;
        }
      }
      let response, body;
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image,
            prompt: job.request.prompt,
            output: job.request.output,
            confidence: job.request.confidence,
            ...(job.request.select ? { select: job.request.select } : {}),
            ...(job.request.max_instances ? { max_instances: job.request.max_instances } : {}),
          }),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
      } catch {
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check the SAM worker before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `SAM returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        send(job.id, 'interrupted', {
          error: 'SAM accepted the request without a usable job ID. Check its output.',
        });
        return;
      }
      remoteId = body.id;
      send(job.id, 'accepted', { remoteId });
    }
    let metadata = null;
    while (true) {
      let state;
      try {
        const response = await fetch(`${baseUrl}/api/jobs/${remoteId}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) {
          send(job.id, 'interrupted', {
            error:
              'The SAM worker no longer recognizes this job. Check its output before resolving.',
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
      } catch {
        send(job.id, 'progress', { stage: 'Waiting to reconnect to the SAM worker.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        metadata = state.metadata;
        break;
      }
      if (state.status === 'failed') {
        // The engine itself reported this outcome, so a retry can submit a fresh attempt.
        send(job.id, 'failed', {
          error: String(state.message || 'Segmentation failed.').slice(0, 2000),
          engineFailure: true,
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || state.status || 'Segmenting image.').slice(0, 300),
      });
      await sleep(2000);
    }
    send(job.id, 'finalizing');
    const output = await saveAsset(
      projectFolder,
      'masks',
      job.id,
      'png',
      `${baseUrl}/api/jobs/${remoteId}/image`,
    );
    send(job.id, 'complete', { output, result: reportFromWorkerMetadata(metadata) });
  } catch (error) {
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
