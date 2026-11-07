import os from 'node:os';
import {planModelLoad,hostMemoryConflict} from './model-load.js';

// Measured one 128-resolution run at roughly 10 GiB GPU and 5 GiB host memory.
// Higher resolutions have not been calibrated; these remain admission estimates.
export const HUNYUAN_GPU_BUDGET_MIB=16*1024;
export const HUNYUAN_HOST_REQUIRED_BYTES=8*1024**3;

export function createHunyuanLoader({hardware,services,baseUrl,freeMemory=os.freemem,fetcher=fetch}){
  let inFlight=null;
  return function loadHunyuan(){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      let status;
      try{const response=await fetcher(`${baseUrl}/api/status`,{signal:AbortSignal.timeout(2000),redirect:'error'});status=await response.json();if(!response.ok||status.engine!=='forge-hunyuan-shape-v1'||typeof status.loaded!=='boolean')throw Error('Unexpected response')}
      catch{return {status:503,body:{code:'engine_unavailable',message:'Start the Hunyuan shape worker first.'}}}
      if(status.loaded)return {status:200,body:{code:'already_loaded',message:'Hunyuan shape model is already loaded.'}};
      if(status.phase==='loading')return {status:202,body:{code:'loading',message:'Hunyuan shape model is already loading.'}};
      if(status.model_downloaded!==true)return {status:409,body:{code:'model_missing',message:'Hunyuan shape model files are missing.'}};
      const free=freeMemory();if(!Number.isFinite(free)||free<HUNYUAN_HOST_REQUIRED_BYTES)return {status:409,body:hostMemoryConflict(free,HUNYUAN_HOST_REQUIRED_BYTES,await services(),['3d-hunyuan'])};
      const snapshot=await hardware();let plan=planModelLoad(snapshot,[],HUNYUAN_GPU_BUDGET_MIB);
      if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(snapshot,await services(),HUNYUAN_GPU_BUDGET_MIB),estimate:'Conservative, uncalibrated Hunyuan shape GPU budget plus system reserve.'};
      if(plan.code!=='ready')return {status:409,body:plan};
      try{const response=await fetcher(`${baseUrl}/api/model/load`,{method:'POST',signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)return response.status>=500?{status:503,body:{code:'load_unknown',message:'The shape model may be loading. Check its worker before clearing the queue barrier.'}}:{status:502,body:{code:'load_rejected',message:`Shape worker rejected loading (HTTP ${response.status}).`}};return {status:202,body:{code:'load_requested',message:'Hunyuan shape model loading requested.',memory:plan}}}
      catch{return {status:503,body:{code:'load_unknown',message:'The shape model may be loading. Check its worker before clearing the queue barrier.'}}}
    })().finally(()=>{inFlight=null});
    return inFlight;
  };
}

export function createHunyuanPreparation({startEngine,loadModel,autoStart=true}){
  return async({health,reachable,claimLoad,retryModel=false})=>{
    if(!reachable){if(!autoStart)return {status:'waiting_engine',stage:'Waiting for the configured shape worker.'};const result=await startEngine('3d-hunyuan');if(result.status==='recovery_unresolved'){if(!claimLoad())return null;return {status:'needs_attention',stage:'Worker recovery needs review.',error:result.message||'A previous worker may still be starting or loading.',loadBarrier:true}}if(['missing','failed','port_in_use'].includes(result.status))return {status:'needs_attention',stage:'Shape worker could not start.',error:result.message||`Worker status: ${result.status}.`};return {status:'waiting_engine',stage:'Starting the shape worker.'}}
    if(health.phase==='generating')return {status:'waiting_engine',stage:'Waiting for the current 3D render.'};
    if(health.phase==='loading'){if(!claimLoad())return null;return {status:'waiting_engine',stage:'Loading Hunyuan shape model.',loadBarrier:true}}
    if(!health.model_downloaded)return {status:'needs_attention',stage:'Shape model files are missing.',error:'Install Hunyuan3D shape files, then retry.'};
    if(health.phase==='error'&&!retryModel)return {status:'needs_attention',stage:'Shape model could not load.',error:'Check the shape worker logs in Diagnostics, then retry.'};
    if(!claimLoad())return null;
    const result=await loadModel();
    if(result.body?.code==='load_unknown')return {status:'needs_attention',stage:'Shape model load needs review.',error:result.body.message,loadBarrier:true};
    if(['insufficient_gpu_memory','insufficient_host_memory'].includes(result.body?.code))return {status:'waiting_memory',stage:result.body.code==='insufficient_host_memory'?'Waiting for system memory.':'Waiting for GPU memory.',details:result.body};
    if(result.status>=400&&result.body?.code!=='engine_unavailable')return {status:'needs_attention',stage:'Shape model could not load.',error:result.body?.message||'Check Diagnostics.'};
    return {status:'waiting_engine',stage:result.body?.message||'Waiting for Hunyuan.',loadBarrier:['load_requested','loading'].includes(result.body?.code)};
  };
}

export function createHunyuanRenderPreparation({hardware,services,freeMemory=os.freemem}){
  return async({resolution})=>{
    const free=freeMemory();
    if(!Number.isFinite(free)||free<4*1024**3)return {status:'waiting_memory',stage:'Waiting for system memory.',details:hostMemoryConflict(free,4*1024**3,await services(),['3d-hunyuan'])};
    const budget=({128:4096,256:8192,384:16384})[resolution];
    if(!budget)return {status:'needs_attention',stage:'Invalid 3D resolution.',error:'Choose a supported mesh resolution.'};
    const snapshot=await hardware();let plan=planModelLoad(snapshot,[],budget);
    if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(snapshot,(await services()).filter(service=>service.id!=='3d-hunyuan'),budget),estimate:'Uncalibrated additional working-memory estimate for this 3D resolution.'};
    if(plan.code==='insufficient_gpu_memory')return {status:'waiting_memory',stage:'Waiting for GPU memory.',details:plan};
    if(plan.code!=='ready')return {status:'needs_attention',stage:'GPU memory is unavailable.',error:plan.message};
    return null;
  };
}
