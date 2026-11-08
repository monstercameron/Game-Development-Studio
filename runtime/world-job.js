import { saveAsset } from './job-io.js';
import { readReferences } from './references.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (jobId, type, values = {}) => {
  if (process.connected) {
    process.send({ jobId, type, ...values });
  }
};
process.on('disconnect', () => process.exit(0));
process.once('message', async ({ job, projectFolder, baseUrl }) => {
  let remoteId = job.remoteId;
  try {
    if (!remoteId) {
      const { references, ...settings } = job.request;
      const images = references.length
        ? await readReferences(projectFolder, references, { max: 8 })
        : [];
      let response, body;
      try {
        response = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...settings, images }),
          signal: AbortSignal.timeout(30000),
          redirect: 'error',
        });
        body = await response.json();
      } catch {
        send(job.id, 'interrupted', {
          error: 'World submission may have started. Check the world worker before retrying.',
        });
        return;
      }
      if (!response.ok) {
        send(job.id, response.status >= 500 ? 'interrupted' : 'failed', {
          error: `World worker returned ${response.status}: ${JSON.stringify(body).slice(0, 1000)}`,
        });
        return;
      }
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        send(job.id, 'interrupted', { error: 'World worker returned an invalid job ID.' });
        return;
      }
      remoteId = body.id;
      send(job.id, 'accepted', { remoteId });
    }
    while (true) {
      let state;
      try {
        const r = await fetch(`${baseUrl}/api/jobs/${remoteId}`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (r.status === 404) {
          send(job.id, 'interrupted', {
            error:
              'The world worker no longer recognizes this job. Check Diagnostics before retrying.',
          });
          return;
        }
        if (!r.ok) {
          throw Error(`HTTP ${r.status}`);
        }
        state = await r.json();
      } catch {
        send(job.id, 'progress', { stage: 'Waiting to reconnect to the world worker.' });
        await sleep(5000);
        continue;
      }
      if (state.status === 'completed') {
        break;
      }
      if (state.status === 'failed') {
        send(job.id, 'failed', {
          error: String(state.message || 'World generation failed.').slice(0, 2000),
        });
        return;
      }
      send(job.id, 'progress', {
        stage: String(state.message || 'Generating world.').slice(0, 300),
      });
      await sleep(2000);
    }
    send(job.id, 'finalizing');
    // A mesh can be exported as GLB; everything else is a PLY.
    const output = await saveAsset(
      projectFolder,
      '3d',
      job.id,
      job.request.output === 'glb' ? 'glb' : 'ply',
      `${baseUrl}/api/jobs/${remoteId}/world`,
    );
    const extraOutputs = [];
    let stage;
    if (job.request.save_panorama) {
      try {
        extraOutputs.push(
          await saveAsset(
            projectFolder,
            'images',
            `${job.id}-panorama`,
            'png',
            `${baseUrl}/api/jobs/${remoteId}/panorama`,
          ),
        );
      } catch (error) {
        // The world itself is finished; say plainly that the extra image was not kept.
        stage = `Completed. The panorama image could not be saved: ${String(error.message).slice(0, 150)}`;
      }
    }
    send(job.id, 'complete', { output, extraOutputs, stage });
  } catch (error) {
    send(job.id, 'failed', { error: String(error.message).slice(0, 2000) });
  } finally {
    if (process.connected) {
      process.disconnect();
    }
  }
});
