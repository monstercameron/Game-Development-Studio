import { readReferences } from './references.js';
import { saveAsset } from './job-io.js';
import { videoProgress } from './video-progress.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function send(jobId,type,values={}){if(process.connected)process.send({jobId,type,...values})}
process.on('disconnect',()=>process.exit(0));
process.once('message',async({job,projectFolder,baseUrl})=>{
  let remoteId=job.remoteId;
  try{
    if(!remoteId){
      // Validate all persisted input before the irreversible submission.
      let images;try{images=await readReferences(projectFolder,job.request.references)}catch(error){send(job.id,'failed',{error:`Could not read video references: ${error.message}`});return}
      const {references,...request}=job.request;
      let response,body;
      try{response=await fetch(`${baseUrl}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,images}),signal:AbortSignal.timeout(30000),redirect:'error'});body=await response.json()}
      catch{send(job.id,'interrupted',{error:'Submission result is unknown. Check H3 Studio before resolving this job.'});return}
      if(!response.ok){send(job.id,response.status>=500?'interrupted':'failed',{error:`H3 Studio returned ${response.status}: ${JSON.stringify(body).slice(0,1000)}`});return}
      if(typeof body.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.id)){send(job.id,'interrupted',{error:'H3 Studio accepted the request without a usable job ID. Check its output.'});return}
      remoteId=body.id;send(job.id,'accepted',{remoteId});
    }
    let output;
    while(true){
      let state;
      try{const response=await fetch(`${baseUrl}/api/status`,{signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw Error(`HTTP ${response.status}`);state=await response.json();if(typeof state.ready!=='boolean'||!Array.isArray(state.files)||!Array.isArray(state.videos))throw Error('Unexpected H3 status')}
      catch{send(job.id,'progress',{stage:'Waiting to reconnect to H3 Studio.'});await sleep(5000);continue}
      const current=state.job?.id===remoteId?state.job:null;
      if(current?.state==='failed'){send(job.id,'failed',{error:String(current.message||'H3 Studio failed.').slice(0,2000)});return}
      if(current?.state==='complete')output=current.output;
      // H3's gallery also lists files that may still be written by an orphaned
      // renderer after its server crashes. A filename is not a completion record.
      else if(!current){send(job.id,'interrupted',{error:'H3 Studio no longer recognizes this job. An output file alone does not prove the render finished; check H3 and its rendering process before resolving.'});return}
      if(output)break;
      if(current.state!=='running'){send(job.id,'interrupted',{error:'H3 Studio returned an unexpected job state. Check its output before resolving.'});return}
      send(job.id,'progress',{stage:videoProgress(current.details,job.request.steps)||String(current.message||'Rendering video.').slice(0,300)});await sleep(3000);
    }
    if(output!==`${remoteId}.webm`)throw Error('H3 Studio returned an invalid video path.');
    send(job.id,'finalizing');
    const result=await saveAsset(projectFolder,'video',job.id,'webm',`${baseUrl}/videos/${encodeURIComponent(output)}`);
    send(job.id,'complete',{output:result});
  }catch(error){send(job.id,'failed',{error:String(error.message).slice(0,2000)})}
  finally{if(process.connected)process.disconnect()}
});
