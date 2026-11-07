import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobQueue} from '../runtime/jobs.js';
import {createRecoverService} from '../runtime/recover-service.js';

async function waitFor(fn){const end=Date.now()+10000;while(Date.now()<end){if(fn())return;await new Promise(resolve=>setTimeout(resolve,30))}throw Error('Timed out')}

test('recovery respects custom service ownership and reports startup failures',async()=>{
  const starts=[];
  const startEngine=async id=>{starts.push(id);return {status:'starting'}};
  const external=createRecoverService({startEngine,env:{FORGE_HYMOTION_URL:'http://127.0.0.1:8000'}});
  assert.equal(await external('motion'),null);assert.deepEqual(starts,[]);
  const permitted=createRecoverService({startEngine,env:{FORGE_HYMOTION_URL:'http://127.0.0.1:8000',FORGE_AUTO_START_HYMOTION:'1'}});
  assert.equal(await permitted('motion'),null);assert.deepEqual(starts,['motion-hy']);
  const failed=createRecoverService({startEngine:async()=>({status:'port_in_use',message:'Unverified service.'}),env:{}});
  assert.equal((await failed('3d')).status,'needs_attention');
  assert.equal(await failed('music'),null);
});

test('an accepted motion job restarts its worker and saves its existing result without resubmission',{timeout:15000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-recovered-queue-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Game'),id=randomUUID(),remote='a'.repeat(32);
  await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  let starts=0,submissions=0;
  const engine=createServer((req,res)=>{
    if(req.url==='/api/generate')submissions++;
    if(req.url===`/api/jobs/${remote}`){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({status:'completed',recovered:true}))}
    if(req.url===`/api/jobs/${remote}/motion`)return res.end('HIERARCHY\nrecovered');
    res.statusCode=404;res.end();
  });
  const previous=process.env.FORGE_HYMOTION_URL;process.env.FORGE_HYMOTION_URL=`http://127.0.0.1:${port}`;
  const recoverService=createRecoverService({env:{},startEngine:async id=>{assert.equal(id,'motion-hy');starts++;engine.listen(port,'127.0.0.1');await once(engine,'listening');return {status:'starting'}}});
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,autoStart:false,recoverService});
  try{
    const job=queue.enqueue({type:'motion',projectId:id,request:{prompt:'walk'}});
    queue.db.prepare("UPDATE jobs SET status='running',remote_id=? WHERE id=?").run(remote,job.id);
    await queue.tick();await waitFor(()=>queue.get(job.id)?.status==='completed');
    assert.equal(starts,1);assert.equal(submissions,0);
    assert.match(await fs.readFile(path.join(project,...queue.get(job.id).output.split('/')),'utf8'),/recovered/);
  }finally{
    queue.stop();if(previous===undefined)delete process.env.FORGE_HYMOTION_URL;else process.env.FORGE_HYMOTION_URL=previous;
    if(engine.listening)await new Promise(resolve=>engine.close(resolve));
    const resolved=await fs.realpath(dir),tempRoot=await fs.realpath(os.tmpdir());
    if(path.dirname(resolved)!==tempRoot||!path.basename(resolved).startsWith('forge-recovered-queue-'))throw Error('Unexpected test directory.');
    await fs.rm(resolved,{recursive:true,force:true});
  }
});

test('an accepted MotionBricks job recovers its BVH without submitting again',{timeout:15000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-bricks-recovery-'));
  const projects=path.join(dir,'projects'),project=path.join(projects,'Game'),id=randomUUID(),remote='b'.repeat(32);
  await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  let starts=0,submissions=0;
  const engine=createServer((req,res)=>{
    if(req.url==='/api/generate-bvh')submissions++;
    if(req.url===`/api/jobs/${remote}`){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({status:'completed',recovered:true}))}
    if(req.url===`/api/jobs/${remote}/output`)return res.end('HIERARCHY\nrecovered SOMA');res.statusCode=404;res.end();
  });
  const previous=process.env.FORGE_MOTIONBRICKS_URL;process.env.FORGE_MOTIONBRICKS_URL=`http://127.0.0.1:${port}`;
  const recoverService=createRecoverService({env:{},startEngine:async engineId=>{assert.equal(engineId,'motion-bricks');starts++;engine.listen(port,'127.0.0.1');await once(engine,'listening');return {status:'starting'}}});
  const queue=new JobQueue({directory:path.join(dir,'state'),projects,autoStart:false,recoverService});
  try{
    const job=queue.enqueue({type:'motion-bricks',projectId:id,request:{pose:`${randomUUID()}.bvh`,context_frame:0,target_frame:20}});
    queue.db.prepare("UPDATE jobs SET status='running',remote_id=? WHERE id=?").run(remote,job.id);
    await queue.tick();await waitFor(()=>queue.get(job.id)?.status==='completed');
    assert.equal(starts,1);assert.equal(submissions,0);
    assert.match(await fs.readFile(path.join(project,...queue.get(job.id).output.split('/')),'utf8'),/recovered SOMA/);
  }finally{
    queue.stop();if(previous===undefined)delete process.env.FORGE_MOTIONBRICKS_URL;else process.env.FORGE_MOTIONBRICKS_URL=previous;
    if(engine.listening)await new Promise(resolve=>engine.close(resolve));
  }
});
