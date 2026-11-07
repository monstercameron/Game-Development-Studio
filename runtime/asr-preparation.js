import { access } from 'node:fs/promises';
import { localAsrUrl } from './asr-client.js';
import { interpretStatus } from './catalog.js';
import { planModelLoad } from './model-load.js';

// The GGUF and its CUDA workspace have not yet been calibrated under load.
export const ASR_BUDGET_MIB=4*1024;

export async function probeAsr(baseUrl,fetcher=fetch){
  try{
    const response=await fetcher(new URL('/v1/models',localAsrUrl(baseUrl)),{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)return false;
    return !!interpretStatus('nemotron-asr',await response.json());
  }catch{return false}
}

// `begin` must persist the queue barrier *before* requesting process creation.
// Any ambiguous response retains that barrier until readiness or manual review.
export function createAsrStarter({hardware,services,startEngine,modelFile,baseUrl,fetcher=fetch,checkFile=access}){
  return async function startAsr(begin){
    if(await probeAsr(baseUrl,fetcher))return {status:200,body:{code:'already_loaded',message:'Nemotron ASR is ready.'},keepBarrier:false};
    try{await checkFile(modelFile)}catch{return {status:409,body:{code:'model_missing',message:'Nemotron ASR model file is missing.'},keepBarrier:false}}
    const snapshot=await hardware();let plan=planModelLoad(snapshot,[],ASR_BUDGET_MIB);
    if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(snapshot,await services(),ASR_BUDGET_MIB),estimate:'Conservative, uncalibrated estimate for Nemotron ASR and its working memory.'};
    if(plan.code!=='ready')return {status:409,body:plan,keepBarrier:false};
    if(!begin())throw Error('Could not persist the speech model-load barrier.');
    try{
      const result=await startEngine('asr');
      if(result.status==='recovery_unresolved')return {status:503,body:{code:'load_unknown',message:result.message||'Speech startup may still be in progress. Check its worker before clearing the queue barrier.'},keepBarrier:true};
      if(['missing','failed','port_in_use','deleting'].includes(result.status))return {status:409,body:{code:'start_failed',message:result.message||`Speech service: ${result.status}.`},keepBarrier:false};
      return {status:202,body:{code:'load_requested',message:'Nemotron ASR is starting and loading its model.',pid:result.pid??null,memory:plan},keepBarrier:true};
    }catch{return {status:503,body:{code:'load_unknown',message:'Speech startup may have begun. Check the service before clearing its queue barrier.'},keepBarrier:true}}
  };
}
