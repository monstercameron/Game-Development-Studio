import { saveAsset } from './job-io.js';
import { readReferences } from './references.js';
import { parseSigmaSchedule } from './image-options.js';

// Qwen Image 2.1's documented wording for native transparency (RGBA) output.
export const transparentPrompt = (prompt) =>
  `This is an RGBA image with transparency. ${String(prompt).trim()} The image has alpha channel and the background is transparent.`;
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
      const {
        references = [],
        transparent = false,
        size_from_reference: sizeFromReference = false,
        ...request
      } = job.request;
      // Forge-only options become Qwen's own inputs here; the engine never sees them.
      if (transparent) {
        request.prompt = transparentPrompt(request.prompt);
      }
      if (sizeFromReference) {
        // Without width and height Qwen derives the size from the last reference image.
        delete request.width;
        delete request.height;
      }
      // Variation labels are Forge's own grouping; the engine renders one image per job.
      delete request.variation_group;
      delete request.variation_index;
      delete request.variation_count;
      if (request.sigma_schedule) {
        request.sigmas = parseSigmaSchedule(request.sigma_schedule);
      }
      delete request.sigma_schedule;
      if (request.lora) {
        // An engine without LoRA support ignores the fields and would render without the LoRA.
        try {
          const response = await fetch(`${baseUrl}/api/loras`, {
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          });
          const listed = response.ok ? (await response.json()).loras : null;
          if (!Array.isArray(listed) || !listed.some((item) => item?.name === request.lora)) {
            throw Error('not listed');
          }
        } catch {
          send(job.id, 'failed', {
            error: `The running Qwen Image Studio cannot apply the LoRA "${request.lora}". It needs the updated app.py and the peft package, and the file must be in its LoRA folder (see the Studio guide).`,
          });
          return;
        }
      }
      let images = [];
      if (references.length) {
        try {
          images = await readReferences(projectFolder, references, { max: 10 });
        } catch (error) {
          send(job.id, 'failed', { error: `Could not read image references: ${error.message}` });
          return;
        }
      }
      let response, body;
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, ...(images.length ? { images } : {}) }),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
      } catch {
        send(job.id, 'interrupted', {
          error: 'Submission result is unknown. Check Qwen Image Studio before resolving this job.',
        });
        return;
      }
      if (!response.ok) {
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `Qwen Image returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) {
        send(job.id, 'interrupted', {
          error: 'Qwen Image accepted the request without a usable job ID. Check its history.',
        });
        return;
      }
      remoteId = body.id;
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
              'Qwen Image no longer recognizes the remote job. Check its output before resolving.',
          });
          return;
        }
        if (!response.ok) {
          throw Error(`HTTP ${response.status}`);
        }
        state = await response.json();
      } catch {
        send(job.id, 'progress', { stage: 'Waiting to reconnect to Qwen Image.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        break;
      }
      if (state.status === 'failed') {
        send(job.id, 'failed', {
          error: String(state.message || 'Qwen Image failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || state.status || 'Rendering').slice(0, 300),
      });
      await sleep(3000);
    }
    const image = state.images?.[0];
    if (typeof image !== 'string' || !/^\/outputs\/[a-zA-Z0-9_-]+\.png$/.test(image)) {
      throw Error('Qwen Image returned an invalid image path.');
    }
    send(job.id, 'finalizing');
    const output = await saveAsset(projectFolder, 'images', job.id, 'png', `${baseUrl}${image}`);
    send(job.id, 'complete', { output });
  } catch (error) {
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
