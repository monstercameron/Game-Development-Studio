// Short, plain-language labels for queue and library entries that belong to a set or build on
// another file. Returns '' when a job has nothing extra to say.

// Forge names its own renders forge-<job id>[-suffix].<ext>; the first eight characters of the
// job ID are enough to tell two files apart, so the full path is not worth a line of its own.
const generatedFileName = /^forge-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// A readable name for a project-relative asset path: "track 4be74c56" for a Forge render, the
// file name for anything the person named themselves, or `fallback` when there is no path.
export function friendlyAssetName(path, noun = 'file', fallback = '') {
  const name = String(path || '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  if (!name) {
    return fallback;
  }
  const generated = generatedFileName.exec(name);
  return generated ? `${noun} ${generated[1]}` : name;
}

export function jobHint(job) {
  const request = job?.request || {};
  if (
    ['images', 'vegetation'].includes(job?.type) &&
    Number.isInteger(request.variation_index)
  ) {
    return `Variation ${request.variation_index} of ${request.variation_count}`;
  }
  if (job?.type === 'music' && request.operation === 'extend') {
    const source = friendlyAssetName(request.source, 'track', 'a track');
    return `Extending ${source} by ${request.add_seconds} s`;
  }
  if (job?.type === 'music' && request.operation === 'resynth') {
    return `Re-synthesizing ${friendlyAssetName(request.source, 'track', 'a track')}`;
  }
  if (job?.type === 'sfx' && request.edit_mode) {
    return {
      variation: 'Variation of a source sound',
      replace: `Replacing ${request.inpaint_start}–${request.inpaint_end} s of a source sound`,
      continue: 'Continuing a source sound',
    }[request.edit_mode];
  }
  return '';
}
