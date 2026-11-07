import {saveAsset} from './job-io.js';
import {readPose} from './references.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function send(jobId,type,values={}){if(process.connected)process.send({jobId,type,...values})}
process.on('disconnect',()=>process.exit(0));
process.once('message',async({job,projectFolder,baseUrl})=>{
  let remoteId=job.remoteId;
  try{
    if(!remoteId){
      // Read before submitting, so missing or modified inputs cannot become an
      // ambiguous remote submission after a process restart.
      const {pose,...settings}=job.request;
      let bvh;try{bvh=await readPose(projectFolder,pose)}catch(error){send(job.id,'failed',{error:`Could not read staged pose: ${error.message}`});return}
      let response,body;
      try{response=await fetch(`${baseUrl}/api/generate-bvh`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bvh,...settings}),signal:AbortSignal.timeout(30000),redirect:'error'});body=await response.json()}
      catch{send(job.id,'interrupted',{error:'Submission result is unknown. Check the MotionBricks worker before resolving this job.'});return}
      if(!response.ok){send(job.id,response.status>=500?'interrupted':'failed',{error:`MotionBricks returned ${response.status}: ${JSON.stringify(body).slice(0,1000)}`});return}
      if(typeof body.id!=='string'||!/^[a-f0-9]{32}$/.test(body.id)){send(job.id,'interrupted',{error:'MotionBricks accepted the request without a usable job ID. Check its output.'});return}
      remoteId=body.id;send(job.id,'accepted',{remoteId});
    }
    while(true){
      let state;
      try{const response=await fetch(`${baseUrl}/api/jobs/${remoteId}`,{signal:AbortSignal.timeout(10000),redirect:'error'});if(response.status===404){send(job.id,'interrupted',{error:'MotionBricks no longer recognizes this job. Check its output before resolving.'});return}if(!response.ok)throw Error(`HTTP ${response.status}`);state=await response.json()}
      catch{send(job.id,'progress',{stage:'Waiting to reconnect to MotionBricks.'});await sleep(5000);continue}
      if(state.status==='completed')break;
      if(state.status==='failed'){send(job.id,'failed',{error:String(state.message||'MotionBricks generation failed.').slice(0,2000)});return}
      send(job.id,'progress',{stage:String(state.message||state.status||'Generating motion.').slice(0,300)});await sleep(2000);
    }
    send(job.id,'finalizing');
    const output=await saveAsset(projectFolder,'motion',job.id,'bvh',`${baseUrl}/api/jobs/${remoteId}/output`);
    send(job.id,'complete',{output});
  }catch(error){send(job.id,'failed',{error:String(error.message).slice(0,2000)})}
  finally{if(process.connected)process.disconnect()}
});
