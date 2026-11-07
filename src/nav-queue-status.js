// Queue state is global across projects; it does not imply GPU availability.
const pageTypes={images:['images'],'3d':['3d','trellis'],world:['world'],motion:['motion','motion-bricks'],video:['video'],music:['music'],sfx:['sfx'],voices:['voices'],segmentation:['segmentation']};
const attention=new Set(['needs_attention','interrupted','waiting_memory']);
const running=new Set(['preparing','submitting','running','finalizing']);
const waiting=new Set(['queued','waiting_engine']);

export function pageQueueStatus(page,jobs,{loading=false,error=''}={}){
 const types=pageTypes[page];if(!types)return null;
 if(error)return {state:'unknown',short:'Unknown',detail:'Queue unavailable; page status is unknown.'};
 if(loading)return {state:'unknown',short:'Checking',detail:'Checking the render queue.'};
 const related=jobs.filter(job=>types.includes(job.type));
 const counts={running:0,waiting:0,attention:0};
 for(const job of related){if(attention.has(job.status))counts.attention++;else if(running.has(job.status))counts.running++;else if(waiting.has(job.status))counts.waiting++}
 const total=counts.running+counts.waiting+counts.attention;
 if(!total)return {state:'free',short:'No jobs',detail:'No active or waiting renders for this page across projects. This does not indicate whether the model is loaded or the GPU is available.'};
 const detail=[counts.running&&`${counts.running} running`,counts.waiting&&`${counts.waiting} waiting`,counts.attention&&`${counts.attention} needing attention`].filter(Boolean).join(', ')+' across projects.';
 if(counts.attention)return {state:'attention',short:'Review',detail};
 if(counts.running)return {state:'running',short:counts.waiting?`Running +${counts.waiting}`:'Running',detail};
 return {state:'waiting',short:`${counts.waiting} queued`,detail};
}
