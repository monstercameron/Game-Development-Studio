import os from 'node:os';
import {planModelLoad,hostMemoryConflict} from './model-load.js';

// A conservative initial estimate for Q4_K_M plus its CUDA working buffers.
// This is not a reservation; concurrent applications may still consume memory.
export const GAME_GPU_BUDGET_MIB=24*1024;
export const GAME_HOST_REQUIRED_BYTES=6*1024**3;

export function createGameLoader({hardware,services,startEngine,activity,requestLoad,freeMemory=os.freemem,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  let inFlight=null;
  return function loadGame(markRequested){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      let initial=(await services()).find(service=>service.id==='game');
      if(initial?.ownershipRecovery==='checking'){
        await startEngine('game');
        initial=(await services()).find(service=>service.id==='game');
      }
      if(initial?.ownershipRecovery==='unresolved'){
        if(!markRequested())throw Error('Could not reserve the model-load barrier.');
        return {status:503,keepBarrier:true,body:{code:'load_unknown',message:'Mammoth ownership needs review; its worker may still be starting or loading.'}};
      }
      if(initial?.status==='reachable'&&!initial.managed){
        return initial.modelLoaded===true?{status:200,body:{code:'already_loaded',message:'The separately managed Mammoth service is already loaded.'}}:{status:409,body:{code:'external_service',message:'Mammoth is running outside Forge. Load it in its own application or stop it before starting Forge’s managed service.'}};
      }
      const started=await startEngine('game');
      if(started.status==='recovery_unresolved'){if(!markRequested())throw Error('Could not reserve the model-load barrier.');return {status:503,keepBarrier:true,body:{code:'load_unknown',message:started.message||'Mammoth may still be starting. Check the worker before clearing the queue barrier.'}}}
      if(!['starting','already_managed'].includes(started.status))return {status:409,body:{code:'engine_unavailable',message:started.message||`Mammoth service status: ${started.status}.`}};
      let state=null;
      for(let i=0;i<30;i++){state=await activity();if(state)break;await wait(250)}
      if(!state)return {status:503,body:{code:'engine_unavailable',message:'The managed Mammoth worker did not become ready. Check its logs.'}};
      if(state.loaded)return {status:200,body:{code:'already_loaded',message:'Mammoth is already loaded.'}};
      if(state.loading){if(!markRequested())throw Error('Could not reserve the model-load barrier.');return {status:202,keepBarrier:true,body:{code:'loading',message:'Mammoth is loading.'}}}
      if(state.load_finished)return {status:409,body:{code:'previous_load_failed',message:'The previous Mammoth load finished without a model. Stop its managed worker and retry to start a fresh one.'}};
      if(!state.model_downloaded)return {status:409,body:{code:'model_missing',message:'Verified Mammoth model files were not found in Mammoth Studio.'}};
      const free=freeMemory();if(!Number.isFinite(free)||free<GAME_HOST_REQUIRED_BYTES)return {status:409,body:hostMemoryConflict(free,GAME_HOST_REQUIRED_BYTES,await services(),['game'])};
      const gpu=await hardware();let plan=planModelLoad(gpu,[],GAME_GPU_BUDGET_MIB);
      if(plan.code==='insufficient_gpu_memory')plan={...planModelLoad(gpu,await services(),GAME_GPU_BUDGET_MIB),estimate:'Conservative, uncalibrated Mammoth GPU budget plus system reserve.'};
      if(plan.code!=='ready')return {status:409,body:plan};
      if(!markRequested())throw Error('Could not reserve the model-load barrier.');
      try{
        const response=await requestLoad();
        if(response.status>=400&&response.status<500)return {status:409,body:{code:'load_rejected',message:response.body?.error||'Mammoth rejected the load request.'}};
        if(response.status>=200&&response.status<300&&(response.body?.accepted===true||response.body?.loading===true||response.body?.loaded===true))return {status:202,keepBarrier:true,body:{code:'load_requested',message:'Mammoth model loading requested.',memory:plan}};
      }catch{}
      return {status:503,keepBarrier:true,body:{code:'load_unknown',message:'Mammoth may be loading. Check the worker before clearing its queue barrier.'}};
    })().finally(()=>{inFlight=null});
    return inFlight;
  };
}
