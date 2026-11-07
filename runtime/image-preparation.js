import { planModelLoad } from './model-load.js';

// The installed BF16 model occupies about 31 GiB on disk. Allow room for
// activations and loader overhead; this conservative estimate is uncalibrated.
export const IMAGE_BUDGET_MIB=48*1024;
export function createImagePreparation({hardware,services}){
  return async function prepareImage(){
    const snapshot=await hardware();
    let plan=planModelLoad(snapshot,[],IMAGE_BUDGET_MIB);
    if(plan.code==='insufficient_gpu_memory')plan=planModelLoad(snapshot,await services(),IMAGE_BUDGET_MIB);
    if(plan.code==='insufficient_gpu_memory')return {status:'waiting_memory',stage:'Waiting for GPU memory for Qwen Image.',details:{...plan,estimate:'Conservative uncalibrated estimate for the BF16 model and working memory.'}};
    if(plan.code==='gpu_memory_unavailable')return {status:'needs_attention',stage:'GPU memory is unavailable.',error:plan.message};
    return null;
  };
}
