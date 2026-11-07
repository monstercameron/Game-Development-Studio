import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JobQueue} from '../runtime/jobs.js';
import {stageReference} from '../runtime/references.js';
import {interpretStatus} from '../runtime/catalog.js';
import {parsePlyPreview} from '../src/ply-preview.js';
import {rerunRequest} from '../src/rerun-request.js';

const ply='ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n';
test('world jobs validate settings, run sequentially, and save PLY files into the project', {timeout:30000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-world-')),projects=path.join(root,'projects'),folder=path.join(projects,'game'),projectId=randomUUID();
 await fs.mkdir(path.join(folder,'3d'),{recursive:true});await fs.writeFile(path.join(folder,'.forge-project.json'),JSON.stringify({id:projectId}));
 const image=await stageReference(folder,Buffer.from('89504e470d0a1a0a00000000','hex'));
 let requests=[];
 const server=createServer(async(req,res)=>{
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))};
  if(req.url==='/api/status')return json({engine:'forge-world-v1',ready:true,busy:false});
  if(req.url==='/api/generate'){let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body));return json({id:String(requests.length).padStart(32,'0')})}
  if(req.url.endsWith('/world')){res.end(ply);return}
  if(req.url.startsWith('/api/jobs/'))return json({status:'completed'});
  res.statusCode=404;res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const old=process.env.FORGE_WORLD_URL;process.env.FORGE_WORLD_URL=`http://127.0.0.1:${server.address().port}`;
 const queue=new JobQueue({directory:path.join(root,'runtime'),projects,intervalMs:100});
 try{
  assert.equal(interpretStatus('world',{engine:'forge-world-v1',ready:true,busy:false}).state,'ready');
  assert.throws(()=>queue.enqueue({type:'world',projectId,request:{model:'hy-world',mode:'text',resolution:518,references:[]}}),/HY-World/);
  assert.throws(()=>queue.enqueue({type:'world',projectId,request:{model:'worldgen',mode:'text',prompt:'forest',resolution:1024,references:[],steps:2}}),/10–60 steps/);
  const first=queue.enqueue({type:'world',projectId,request:{model:'worldgen',mode:'panorama',output:'splat',resolution:1024,references:[image.id]}});
  const second=queue.enqueue({type:'world',projectId,request:{model:'hy-world',mode:'image',output:'splat',resolution:336,references:[image.id]}});
  const third=queue.enqueue({type:'world',projectId,request:{model:'worldgen',mode:'text',prompt:'forest',output:'splat',resolution:1024,references:[],seed:123,steps:12}});
  const deadline=Date.now()+20000;while(Date.now()<deadline&&!['completed','failed','interrupted'].includes(queue.get(third.id).status))await new Promise(resolve=>setTimeout(resolve,100));
  for(const job of [first,second,third]){const done=queue.get(job.id);assert.equal(done.status,'completed',done.error||done.stage);assert.equal(await fs.readFile(path.join(folder,...done.output.split('/')),'utf8'),ply)}
  assert.deepEqual(requests.map(request=>request.model),['worldgen','hy-world','worldgen']);assert.equal(requests[0].images.length,1);assert.equal(requests[2].seed,123);assert.equal(requests[2].steps,12);
  const estimated=queue.estimate({type:'world',projectId,request:{model:'hy-world',mode:'image',output:'splat',resolution:336,references:[image.id]}});assert.equal(estimated.available,true);
 }finally{queue.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(old===undefined)delete process.env.FORGE_WORLD_URL;else process.env.FORGE_WORLD_URL=old;await fs.rm(root,{recursive:true,force:true})}
});

test('PLY point previews load geometry from world assets',()=>{
 const bytes=Buffer.from(ply);const points=parsePlyPreview(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
 assert.equal(points.type,'Points');assert.equal(points.geometry.attributes.position.count,3);
 points.geometry.dispose();points.material.dispose();
});

test('world reruns vary the seed only for generated panoramas',()=>{
 const generated={type:'world',request:{model:'worldgen',mode:'text',prompt:'forest',seed:42,steps:20,references:[]}};
 assert.deepEqual(rerunRequest(generated,'forest at night',{seed:8}),{...generated.request,prompt:'forest at night',seed:8});
 const panorama={type:'world',request:{model:'worldgen',mode:'panorama',prompt:'',seed:42,references:['ref.png']}};
 assert.equal(rerunRequest(panorama,'',{seed:8}).seed,42);
});
