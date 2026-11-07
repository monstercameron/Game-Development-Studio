import os from 'node:os';
import {planModelLoad,hostMemoryConflict} from './model-load.js';

// The worker independently rechecks these thresholds. Estimates are not reservations.
export const MOTIONBRICKS_HOST_LOAD_BYTES=7*1024**3;
export const MOTIONBRICKS_HOST_RENDER_BYTES=4*1024**3;
export const MOTIONBRICKS_GPU_LOAD_MIB=8*1024;
export const MOTIONBRICKS_GPU_RENDER_MIB=3*1024;

export function createMotionBricksLoader({hardware,services,baseUrl,freeMemory=os.freemem,fetcher=fetch}){
  let inFlight=null;
  return function load(){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      let health;
      try{const response=await fetcher(`${baseUrl}/api/status`,{signal:AbortSignal.timeout(2000),redirect:'error'});health=await response.json();if(!response.ok||health.engine!=='forge-motionbricks-cuda-experimental-v1'||typeof health.loaded!=='boolean')throw Error('Unexpected response')}
      catch{return {status:503,body:{code:'engine_unavailable',message:'Start the MotionBricks worker first.'}}}
      if(health.loaded)return health.rig==='soma'?{status:200,body:{code:'already_loaded',message:'MotionBricks SOMA is already loaded.'}}:{status:409,body:{code:'wrong_model',message:'Stop the worker before switching to SOMA.'}};
      if(health.phase==='loading')return {status:202,body:{code:'loading',message:'MotionBricks is already loading.'}};
      if(health.model_downloaded!==true)return {status:409,body:{code:'model_missing',message:'The MotionBricks SOMA checkpoint is missing.'}};
      const free=freeMemory();if(!Number.isFinite(free)||free<MOTIONBRICKS_HOST_LOAD_BYTES)return {status:409,body:hostMemoryConflict(free,MOTIONBRICKS_HOST_LOAD_BYTES,await services(),['motion-bricks'])};
      const snapshot=await hardware();let plan=planModelLoad(snapshot,[],MOTIONBRICKS_GPU_LOAD_MIB);
      if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(snapshot,await services(),MOTIONBRICKS_GPU_LOAD_MIB),estimate:'Estimated MotionBricks load budget plus system reserve.'};
      if(plan.code!=='ready')return {status:409,body:plan};
      try{const response=await fetcher(`${baseUrl}/api/model/load`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rig:'soma'}),signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)return response.status>=500?{status:503,body:{code:'load_unknown',message:'MotionBricks may be loading. Check the worker before clearing its queue barrier.'}}:{status:502,body:{code:'load_rejected',message:`MotionBricks rejected loading (HTTP ${response.status}).`}};return {status:202,body:{code:'load_requested',message:'MotionBricks loading requested.',memory:plan}}}
      catch{return {status:503,body:{code:'load_unknown',message:'MotionBricks may be loading. Check the worker before clearing its queue barrier.'}}}
    })().finally(()=>{inFlight=null});return inFlight;
  };
}

export function createMotionBricksPreparation({startEngine,loadModel,autoStart=true}){
  return async({health,reachable,claimLoad,retryModel=false})=>{
    if(!reachable){if(!autoStart)return {status:'waiting_engine',stage:'Waiting for the MotionBricks worker.'};const result=await startEngine('motion-bricks');if(result.status==='recovery_unresolved'){if(!claimLoad())return null;return {status:'needs_attention',stage:'Worker recovery needs review.',error:result.message||'A previous worker may still be starting or loading.',loadBarrier:true}}if(['missing','failed','port_in_use'].includes(result.status))return {status:'needs_attention',stage:'MotionBricks worker could not start.',error:result.message||`Worker status: ${result.status}.`};return {status:'waiting_engine',stage:'Starting the MotionBricks worker.'}}
    if(health.phase==='generating')return {status:'waiting_engine',stage:'Waiting for the current MotionBricks render.'};
    if(health.phase==='loading'){if(!claimLoad())return null;return {status:'waiting_engine',stage:'Loading MotionBricks.',loadBarrier:true}}
    if(!health.model_downloaded)return {status:'needs_attention',stage:'MotionBricks checkpoint is missing.',error:'Install the SOMA checkpoint, then retry.'};
    if(health.phase==='error'&&!retryModel)return {status:'needs_attention',stage:'MotionBricks could not load.',error:health.error||'Check worker logs in Diagnostics, then retry.'};
    if(!claimLoad())return null;
    const result=await loadModel();
    if(result.body?.code==='load_unknown')return {status:'needs_attention',stage:'MotionBricks load needs review.',error:result.body.message,loadBarrier:true};
    if(['insufficient_gpu_memory','insufficient_host_memory'].includes(result.body?.code))return {status:'waiting_memory',stage:result.body.code==='insufficient_host_memory'?'Waiting for system memory.':'Waiting for GPU memory.',details:result.body};
    if(result.status>=400&&result.body?.code!=='engine_unavailable')return {status:'needs_attention',stage:'MotionBricks could not load.',error:result.body?.message||'Check Diagnostics.'};
    return {status:'waiting_engine',stage:result.body?.message||'Waiting for MotionBricks.',loadBarrier:['load_requested','loading'].includes(result.body?.code)};
  };
}

export function createMotionBricksRenderPreparation({hardware,services,freeMemory=os.freemem}){
  return async()=>{
    const free=freeMemory();if(!Number.isFinite(free)||free<MOTIONBRICKS_HOST_RENDER_BYTES)return {status:'waiting_memory',stage:'Waiting for system memory.',details:hostMemoryConflict(free,MOTIONBRICKS_HOST_RENDER_BYTES,await services(),['motion-bricks'])};
    const snapshot=await hardware();let plan=planModelLoad(snapshot,[],MOTIONBRICKS_GPU_RENDER_MIB);
    if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(snapshot,(await services()).filter(service=>service.id!=='motion-bricks'),MOTIONBRICKS_GPU_RENDER_MIB),estimate:'Estimated additional MotionBricks working memory plus system reserve.'};
    if(plan.code==='insufficient_gpu_memory')return {status:'waiting_memory',stage:'Waiting for GPU memory.',details:plan};
    if(plan.code!=='ready')return {status:'needs_attention',stage:'GPU memory is unavailable.',error:plan.message};
    return null;
  };
}
