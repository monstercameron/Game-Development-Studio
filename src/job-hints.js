// Short, plain-language labels for queue and library entries that belong to a set or build on
// another file. Returns '' when a job has nothing extra to say.
export function jobHint(job) {
  const request = job?.request || {};
  if (job?.type === 'images' && Number.isInteger(request.variation_index)) {
    return `Variation ${request.variation_index} of ${request.variation_count}`;
  }
  if (job?.type === 'music' && request.operation === 'extend') {
    return `Extending ${request.source || 'a track'} by ${request.add_seconds} s`;
  }
  if (job?.type === 'music' && request.operation === 'resynth') {
    return `Re-synthesizing ${request.source || 'a track'}`;
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
