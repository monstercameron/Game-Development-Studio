// YuE2's existing CUDA pipeline is configured with a 24 GiB memory budget.
// Keep 2 GiB free for the system; this is a conservative admission threshold,
// not a reservation or a guarantee against concurrent allocations.
export const YUE_BUDGET_MIB=24*1024;
export const GPU_RESERVE_MIB=2*1024;

export function memoryCandidates(services, exclude=[]) {
  return (services || []).filter(s => !exclude.includes(s.id) && (s.modelLoaded === true || s.busy === true || (s.status === 'reachable' && (s.modelLoaded == null || (s.managed === true && s.canUnload === true)))))
    .map(({id,name,canUnload,canForceStop,busy,managed,status,modelLoaded,url}) => ({id,name,canUnload:!!canUnload && busy !== true && managed === true,canForceStop:!!canForceStop,busy:busy === true,managed:managed === true,status,modelLoaded,url}));
}
export function hostMemoryConflict(freeBytes, requiredBytes, services, exclude=[]) {
  const free=Number.isFinite(freeBytes) && freeBytes >= 0 ? freeBytes : null;
  return {code:'insufficient_host_memory',freeBytes:free,requiredBytes,shortfallBytes:free===null?null:Math.max(0,requiredBytes-free),candidates:memoryCandidates(services,exclude),message:'Available system memory is below the configured requirement.'};
}

export function planModelLoad(hardware,services,budgetMiB=YUE_BUDGET_MIB){
  const devices=Array.isArray(hardware?.devices)?hardware.devices:[];
  const gpuDevices=devices.filter(item=>item&&typeof item==='object'&&!(/\bNPU\b/i.test(item.name||'')));
  // CUDA's default-device order can differ from the order reported by the
  // management tool. Until per-engine UUID mapping is available, never use
  // another device's free memory to admit a load on a multi-GPU machine.
  if(gpuDevices.length>1)return {code:'gpu_memory_unavailable',message:'Multiple GPUs are present, but the inference device cannot be identified safely. The model was not loaded.',devices};
  const device=gpuDevices[0];
  if(!device||!Number.isFinite(device.freeMiB)||device.freeMiB<0||(devices.some(item=>Number.isInteger(item?.index))&&device.index!==0))return {code:'gpu_memory_unavailable',message:'The inference GPU memory could not be verified. The model was not loaded.',devices};
  const requiredMiB=budgetMiB+GPU_RESERVE_MIB;
  if(device.freeMiB>=requiredMiB)return {code:'ready',device,requiredMiB};
  return {code:'insufficient_gpu_memory',device,requiredMiB,shortfallMiB:requiredMiB-device.freeMiB,candidates:memoryCandidates(services),message:'Free GPU memory is below the configured model budget plus the system reserve.'};
}

export function createModelLoader({hardware,services,baseUrl='http://127.0.0.1:8765',fetcher=fetch}){
  let inFlight=null,lastRequested=0;
  return async function loadMusic(){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      let health;
      try{const response=await fetcher(`${baseUrl}/api/v1/health`,{signal:AbortSignal.timeout(2000),redirect:'error'});health=await response.json();if(!response.ok||health.api_version!=='1'||typeof health.model?.loaded!=='boolean')throw Error('Unexpected engine response')}
      catch{return {status:503,body:{code:'engine_unavailable',message:'Start YuE2 before loading its model.'}}}
      if(health.model.loaded)return {status:200,body:{code:'already_loaded',message:'YuE2 is already loaded.'}};
      if(health.model.loading||Date.now()-lastRequested<15000)return {status:202,body:{code:'loading',message:'YuE2 is already loading or waiting to load.'}};
      const snapshot=await hardware();
      let plan=planModelLoad(snapshot,[]);
      if(plan.code==='insufficient_gpu_memory')plan=planModelLoad(snapshot,await services());
      if(plan.code!=='ready')return {status:409,body:plan};
      try{
        const response=await fetcher(`${baseUrl}/api/model/load`,{method:'POST',signal:AbortSignal.timeout(5000),redirect:'error'});
        if(!response.ok)return response.status>=500?{status:503,body:{code:'load_unknown',message:`YuE2 returned HTTP ${response.status}; the load request may have started. Check the worker before clearing its queue barrier.`}}:{status:502,body:{code:'load_rejected',message:`YuE2 rejected the load request (HTTP ${response.status}).`}};
        lastRequested=Date.now();return {status:202,body:{code:'load_requested',message:'YuE2 model loading requested.',memory:plan}};
      }catch{return {status:503,body:{code:'load_unknown',message:'The YuE2 load request may have started. Check the worker before clearing its queue barrier.'}}}
    })().finally(()=>{inFlight=null});
    return inFlight;
  };
}
