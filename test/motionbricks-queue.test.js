import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobQueue} from '../runtime/jobs.js';
import {stagePose,stageProjectPose,readPose} from '../runtime/references.js';
import {createMotionBricksLoader,createMotionBricksPreparation,createMotionBricksRenderPreparation} from '../runtime/motionbricks-preparation.js';

const fixture=Buffer.from('HIERARCHY\nROOT Hips\n{\n}\nMOTION\nFrames: 1\nFrame Time: 0.033333333\n0\n');
async function waitFor(fn){const end=Date.now()+12000;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,30))}throw Error('Timed out')}

test('pose staging snapshots project BVH and rejects invalid or escaping inputs',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-pose-'));await fs.mkdir(path.join(dir,'motion'));
  await fs.writeFile(path.join(dir,'motion','walk.bvh'),fixture);
  const staged=await stageProjectPose(dir,'motion/walk.bvh');await fs.writeFile(path.join(dir,'motion','walk.bvh'),'changed');
  assert.equal(await readPose(dir,staged.id),fixture.toString());
  await assert.rejects(stagePose(dir,Buffer.from('not a bvh')),/does not look/);
  await assert.rejects(stageProjectPose(dir,'../walk.bvh'),/Choose a project/);
  await assert.rejects(readPose(dir,'../bad.bvh'),/staged BVH/);
});

test('MotionBricks admission checks memory and keeps uncertain loads fenced',async()=>{
  let gpu=1000,host=16*1024**3,posts=0;
  const fetcher=async(url,options={})=>{if(url.endsWith('/api/status'))return {ok:true,json:async()=>({engine:'forge-motionbricks-cuda-experimental-v1',phase:'idle',loaded:false,model_downloaded:true})};if(options.method==='POST'){posts++;throw Error('response lost')}throw Error('Unexpected')};
  const services=async()=>[{id:'tts',name:'Voice',modelLoaded:true,canUnload:true}],hardware=async()=>({devices:[{freeMiB:gpu}]});
  const load=createMotionBricksLoader({hardware,services,baseUrl:'http://127.0.0.1:8287',freeMemory:()=>host,fetcher});
  assert.equal((await load()).body.code,'insufficient_gpu_memory');assert.equal(posts,0);
  gpu=20000;host=1000;assert.equal((await load()).body.code,'insufficient_host_memory');assert.equal(posts,0);
  host=16*1024**3;assert.equal((await load()).body.code,'load_unknown');assert.equal(posts,1);
  const prepare=createMotionBricksPreparation({startEngine:async()=>({status:'starting'}),loadModel:load});
  assert.equal((await prepare({reachable:true,health:{phase:'idle',model_downloaded:true},claimLoad:()=>true})).loadBarrier,true);
  const render=createMotionBricksRenderPreparation({hardware,services,freeMemory:()=>host});assert.equal(await render(),null);
  gpu=1000;assert.equal((await render()).status,'waiting_memory');
});

test('durable queue sends the staged pose and saves the BVH asset', {timeout:20000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-bricks-')),projects=path.join(dir,'projects'),project=path.join(projects,'Game'),id=randomUUID();
  await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const pose=await stagePose(project,fixture),remoteId='d'.repeat(32);let submissions=0;
  const server=createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');
    if(req.url==='/api/status')return res.end(JSON.stringify({engine:'forge-motionbricks-cuda-experimental-v1',phase:'ready',loaded:true,rig:'soma',model_downloaded:true}));
    if(req.url==='/api/generate-bvh'&&req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;assert.deepEqual(JSON.parse(raw),{bvh:fixture.toString(),context_frame:0,target_frame:20,min_tokens:8,max_tokens:14});submissions++;return res.end(JSON.stringify({id:remoteId}))}
    if(req.url===`/api/jobs/${remoteId}`)return res.end(JSON.stringify({status:'completed'}));
    if(req.url===`/api/jobs/${remoteId}/output`)return res.end(fixture);res.statusCode=404;res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const previous=process.env.FORGE_MOTIONBRICKS_URL;process.env.FORGE_MOTIONBRICKS_URL=`http://127.0.0.1:${server.address().port}`;
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,intervalMs:50});
  try{
    const input={type:'motion-bricks',projectId:id,request:{pose:pose.id,context_frame:0,target_frame:20}};
    assert.throws(()=>queue.enqueue({...input,request:{...input.request,pose:'../file.bvh'}}),/staged SOMA/);
    const job=queue.enqueue(input);await waitFor(()=>queue.get(job.id)?.status==='completed');assert.equal(submissions,1);
    assert.match(queue.get(job.id).output,/^motion\/.*\.bvh$/);assert.deepEqual(await fs.readFile(path.join(project,...queue.get(job.id).output.split('/'))),fixture);assert.equal(queue.estimate(input).sampleCount,1);
  }finally{queue.stop();if(previous===undefined)delete process.env.FORGE_MOTIONBRICKS_URL;else process.env.FORGE_MOTIONBRICKS_URL=previous;await new Promise(resolve=>server.close(resolve))}
});
