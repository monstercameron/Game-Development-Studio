export function motionBricksRequest(draft, pose = '00000000-0000-0000-0000-000000000000.bvh') {
  const number = (key, fallback) =>
    draft[key] === undefined || draft[key] === '' ? fallback : Number(draft[key]);
  const context_frame = number('contextFrame', 0),
    target_frame = number('targetFrame', 20),
    min_tokens = number('minTokens', 8),
    max_tokens = number('maxTokens', 14);
  if (
    !Number.isSafeInteger(context_frame) ||
    context_frame < 0 ||
    !Number.isSafeInteger(target_frame) ||
    target_frame < 0 ||
    !Number.isInteger(min_tokens) ||
    !Number.isInteger(max_tokens) ||
    min_tokens < 6 ||
    max_tokens > 16 ||
    min_tokens > max_tokens
  ) {
    throw Error('Enter non-negative pose frames and token limits between 6 and 16.');
  }
  return { pose, context_frame, target_frame, min_tokens, max_tokens };
}
