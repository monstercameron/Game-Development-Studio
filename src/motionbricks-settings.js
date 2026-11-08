export function motionBricksRequest(draft, pose = '00000000-0000-0000-0000-000000000000.bvh') {
  const number = (key, fallback) =>
    draft[key] === undefined || draft[key] === '' ? fallback : Number(draft[key]);
  const context_frame = number('contextFrame', 0),
    target_frame = number('targetFrame', 20),
    min_tokens = number('minTokens', 8),
    max_tokens = number('maxTokens', 14),
    num_target_poses = number('targetPoses', 4);
  if (
    !Number.isInteger(num_target_poses) ||
    num_target_poses < 1 ||
    num_target_poses > 4 ||
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
    throw Error(
      'Enter non-negative pose frames, token limits from 6 to 16, and 1 to 4 target poses.',
    );
  }
  return {
    pose,
    context_frame,
    target_frame,
    min_tokens,
    max_tokens,
    ...(num_target_poses !== 4 ? { num_target_poses } : {}),
  };
}
