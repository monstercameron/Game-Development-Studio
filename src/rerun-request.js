export function isDerivedMusic(job) {
  return job?.type === 'music' && Boolean(job.request?.operation);
}

// Keep every model setting from the original render unless the creator changes it.
export function rerunRequest(job, prompt, { seed, reference } = {}) {
  const key = job.type === 'music' ? 'style' : job.type === 'voices' ? 'text' : 'prompt';
  // An extension or re-synthesis takes its style from the track it continues, so a new style
  // cannot be applied; the rerun repeats it with another seed.
  const request =
    ['3d', 'trellis', 'motion-bricks'].includes(job.type) || isDerivedMusic(job)
      ? { ...job.request }
      : { ...job.request, [key]: prompt };
  if (
    seed !== undefined &&
    (['images', 'music', 'sfx', 'voices', '3d', 'trellis', 'motion'].includes(job.type) ||
      (job.type === 'world' && job.request.model === 'worldgen' && job.request.mode !== 'panorama'))
  ) {
    request.seed = seed;
  }
  if (reference !== undefined) {
    request.references = [...(request.references || []), reference];
  }
  // A rerun of a chained render reuses the reference that was staged for it; it does not wait for
  // the earlier render again.
  delete request.referenceFrom;
  // A rerun is a fresh render, not another member of the original variation set.
  delete request.variation_group;
  delete request.variation_index;
  delete request.variation_count;
  return request;
}
