// Keep every model setting from the original render unless the creator changes it.
export function rerunRequest(job, prompt, { seed, reference } = {}) {
  const key = job.type === 'music' ? 'style' : job.type === 'voices' ? 'text' : 'prompt';
  const request = ['3d', 'trellis', 'motion-bricks'].includes(job.type)
    ? { ...job.request }
    : { ...job.request, [key]: prompt };
  if (
    seed !== undefined &&
    (['images', 'music', 'sfx', '3d', 'trellis', 'motion'].includes(job.type) ||
      (job.type === 'world' && job.request.model === 'worldgen' && job.request.mode !== 'panorama'))
  ) {
    request.seed = seed;
  }
  if (reference !== undefined) {
    request.references = [...(request.references || []), reference];
  }
  return request;
}
