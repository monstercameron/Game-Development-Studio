export function motionBricksRequest(draft, pose = '00000000-0000-0000-0000-000000000000.bvh') {
  const number = (key, fallback) =>
    draft[key] === undefined || draft[key] === '' ? fallback : Number(draft[key]);
  const contextFrame = number('contextFrame', 0),
    targetFrame = number('targetFrame', 20),
    minTokens = number('minTokens', 8),
    maxTokens = number('maxTokens', 14),
    numTargetPoses = number('targetPoses', 4);
  if (
    !Number.isInteger(numTargetPoses) ||
    numTargetPoses < 1 ||
    numTargetPoses > 4 ||
    !Number.isSafeInteger(contextFrame) ||
    contextFrame < 0 ||
    !Number.isSafeInteger(targetFrame) ||
    targetFrame < 0 ||
    !Number.isInteger(minTokens) ||
    !Number.isInteger(maxTokens) ||
    minTokens < 6 ||
    maxTokens > 16 ||
    minTokens > maxTokens
  ) {
    throw Error(
      'Enter non-negative pose frames, token limits from 6 to 16, and 1 to 4 target poses.',
    );
  }
  // The wire fields keep their snake_case names (they match runtime/jobs.js and the MCP schema).
  return {
    pose,
    context_frame: contextFrame,
    target_frame: targetFrame,
    min_tokens: minTokens,
    max_tokens: maxTokens,
    ...(numTargetPoses !== 4 ? { num_target_poses: numTargetPoses } : {}),
  };
}
