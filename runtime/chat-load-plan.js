import {estimateChatMemory} from './chat-memory.js';
import {planModelLoad} from './model-load.js';

// The all-GPU GGUF engine uses mapped model files. Available Windows RAM is
// not an estimate of how much GPU memory is available and must not be used
// as a second copy of the model's GPU budget. Actual allocations can still
// fail, in which case the engine reports the failure in its logs.
export async function planChatLoad({hardware,services,contextSize}){
  const estimate=estimateChatMemory(contextSize);
  const gpu=await hardware();
  let plan=planModelLoad(gpu,[],estimate.gpuBudgetMiB);
  if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(gpu,await services(),estimate.gpuBudgetMiB),estimate:`Estimated GPU budget for ${contextSize.toLocaleString()} context tokens, plus the 2 GiB reserve.`};
  return plan;
}
