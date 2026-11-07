import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobQueue} from '../runtime/jobs.js';
import {stageProjectAsset} from '../runtime/references.js';
import {createTrellisLoader,createTrellisPreparation,createTrellisRenderPreparation} from '../runtime/trellis-preparation.js';

async function waitFor(fn){const end=Date.now()+12000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw Error('Timed out')}

test('TRELLIS.2 admission checks system and GPU memory and fences uncertain loads',async()=>{
  let host=1,gpu=1,posts=0;
  const fetcher=async(url,options={})=>{if(url.endsWith('/api/status'))return {ok:true,json:async()=>({engine:'forge-trellis2-512-experimental-v1',phase:'idle',loaded:false,model_downloaded:true})};if(options.method==='POST'){posts++;throw Error('response lost')}throw Error('Unexpected')};
  const hardware=async()=>({devices:[{freeMiB:gpu}]});
  const services=async()=>[{id:'tts',name:'TTS',modelLoaded:true,canUnload:true,managed:true}];
  const load=createTrellisLoader({hardware,services,baseUrl:'http://127.0.0.1:8285',freeMemory:()=>host,fetcher});
  assert.equal((await load()).body.code,'insufficient_host_memory');assert.equal(posts,0);
  host=20*1024**3;const low=await load();assert.equal(low.body.code,'insufficient_gpu_memory');assert.equal(low.body.candidates[0].id,'tts');assert.equal(posts,0);
  gpu=60000;assert.equal((await load()).body.code,'load_unknown');assert.equal(posts,1);
  const prepare=createTrellisRenderPreparation({hardware,services,freeMemory:()=>host});
  assert.equal(await prepare(),null);gpu=1024;assert.equal((await prepare()).status,'waiting_memory');
  host=1;const hostWait=await prepare();assert.equal(hostWait.status,'waiting_memory');assert.equal(hostWait.details.code,'insufficient_host_memory');assert.equal(hostWait.details.candidates[0].canUnload,true);
  const preparation=createTrellisPreparation({startEngine:async()=>({status:'starting'}),loadModel:load,freeMemory:()=>host,services});
  const waiting=await preparation({reachable:true,health:{phase:'idle',model_downloaded:true},claimLoad:()=>{throw Error('Must not claim a load without system memory')}});
  assert.equal(waiting.status,'waiting_memory');assert.equal(waiting.details.requiredBytes,12*1024**3);assert.equal(waiting.details.candidates[0].id,'tts');
});

test('TRELLIS.2 durable queue snapshots a reference and saves a recovered GLB', {timeout:20000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-trellis-queue-')),projects=path.join(dir,'projects'),project=path.join(projects,'Game'),id=randomUUID();
  await fs.mkdir(path.join(project,'images'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('snapshot')]);await fs.writeFile(path.join(project,'images','source.png'),png);const ref=await stageProjectAsset(project,'images/source.png');
  let submissions=0;const remoteId='b'.repeat(32);
  const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({engine:'forge-trellis2-512-experimental-v1',phase:'ready',loaded:true,model_downloaded:true}));
    if(req.url==='/api/generate'&&req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.equal(body.image,`data:image/png;base64,${png.toString('base64')}`);assert.deepEqual({seed:body.seed,steps:body.steps,texture_size:body.texture_size},{seed:5,steps:3,texture_size:512});submissions++;return res.end(JSON.stringify({id:remoteId}))}
    if(req.url===`/api/jobs/${remoteId}`)return res.end(JSON.stringify({status:'completed',recovered:true}));
    if(req.url===`/api/jobs/${remoteId}/mesh`)return res.end('glTF-test');res.statusCode=404;res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const previous=process.env.FORGE_TRELLIS_URL;process.env.FORGE_TRELLIS_URL=`http://127.0.0.1:${server.address().port}`;
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,intervalMs:50});
  try{
    const input={type:'trellis',projectId:id,request:{references:[ref.id],seed:5,steps:3,texture_size:512}};
    const job=queue.enqueue(input);await waitFor(()=>queue.get(job.id)?.status==='completed');assert.equal(submissions,1);
    assert.equal(await fs.readFile(path.join(project,...queue.get(job.id).output.split('/')),'utf8'),'glTF-test');
    assert.equal(queue.estimate(input).sampleCount,1);
    assert.throws(()=>queue.enqueue({...input,request:{...input.request,texture_size:100}}),/Invalid/);
  }finally{queue.stop();if(previous===undefined)delete process.env.FORGE_TRELLIS_URL;else process.env.FORGE_TRELLIS_URL=previous;await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true})}
});
