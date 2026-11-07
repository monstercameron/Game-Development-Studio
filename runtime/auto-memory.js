// Only engines with an atomic, authenticated idle-and-stop guard are eligible.
// Companion audio apps lack that guard; a check followed by killing them could
// interrupt a request that arrived between those two operations.
const guarded=new Set(['images','tts','3d-hunyuan','3d-trellis','segmentation','motion-hy','motion-bricks']);

export function createAutoMemoryManager({services,offload,now=Date.now,cooldownMs=60000}){
 const failures=new Map();
 return async function makeRoom({target,upcoming=[],isCurrent,announce,reserve,release}){
  const states=await services();if(!isCurrent())return {status:'cancelled'};
  const choices=states.filter(item=>guarded.has(item.id)&&item.id!==target&&item.status==='reachable'&&item.managed===true&&item.canUnload===true&&item.busy===false&&item.modelLoaded===true&&(failures.get(item.id)||0)<=now());
  // Keep models that the next jobs will need; try an otherwise unused model first.
  choices.sort((a,b)=>{const ai=upcoming.indexOf(a.id),bi=upcoming.indexOf(b.id);return (bi<0?Infinity:bi)-(ai<0?Infinity:ai)});
  if(!choices.length)return {status:'unavailable'};
  const choice=choices[0];let reserved=false;
  try{
   if(!isCurrent())return {status:'cancelled'};
   reserve(choice.id);reserved=true;
   if(!isCurrent()||!announce(choice))return {status:'cancelled'};
   const result=await offload(choice.id);
   if(result?.stopped!==true)throw Error('The engine did not confirm it stopped.');
   failures.delete(choice.id);return {status:'stopped',service:choice};
  }catch(error){failures.set(choice.id,now()+cooldownMs);return {status:'failed',service:choice,error:error.message||'Could not stop the idle service.'}}
  finally{if(reserved)release(choice.id)}
 };
}
