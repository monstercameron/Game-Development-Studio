// Estimates for the installed Qwen3.8-27B Q4_K_M and the bundled CUDA engine.
// llama-fit-params reports an FP16 KV cache of 149 MiB + 64 MiB per 1K
// context tokens, and about 1 MiB/1K additional GPU compute memory. The
// 18.75 GiB total at 4K is an earlier offline estimate, not a measurement;
// MTP and concurrent allocations may change actual usage.
export const CHAT_CONTEXT_SIZES = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
export const DEFAULT_CHAT_CONTEXT = 4096;
export function validateChatContext(value) {
  if (!Number.isSafeInteger(value) || !CHAT_CONTEXT_SIZES.includes(value)) {
    throw Error('Choose a supported Qwen context size.');
  }
  return value;
}
// projectorMiB is the multimodal projector (about 0.93 GB BF16 file) loaded on the GPU for image
// input; pass 0 when it will not be loaded. Its real GPU use has not been calibrated here.
export function estimateChatMemory(contextSize = DEFAULT_CHAT_CONTEXT, { projectorMiB = 0 } = {}) {
  validateChatContext(contextSize);
  const extraMiB = ((contextSize - 4096) * 65) / 1024;
  return {
    contextSize,
    contextMiB: 149 + contextSize / 16,
    projectorMiB,
    estimatedGpuMiB: 18.75 * 1024 + extraMiB + projectorMiB,
    gpuBudgetMiB: 19 * 1024 + Math.max(0, extraMiB) + projectorMiB,
  };
}
