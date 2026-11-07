import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {forceStopWindows} from '../runtime/force-stop.js';
import {inspectWindowsProcess} from '../runtime/engine-ownership.js';
import {JobQueue} from '../runtime/jobs.js';
import {EngineManager} from '../runtime/engines.js';
import {createServer} from 'node:http';

test('Windows force-stop rejects a changed identity and terminates a verified owned tree', {skip:process.platform!=='win32',timeout:30000},async t=>{
 const parent=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/force-stop-parent.js',import.meta.url))],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 const [chunk]=await once(parent.stdout,'data');const childPid=JSON.parse(String(chunk).trim()).childPid;
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 t.after(()=>{if(parent.exitCode===null)parent.kill();try{process.kill(childPid)}catch{};if(unrelated.exitCode===null)unrelated.kill()});
 const info=await inspectWindowsProcess(parent.pid,17654);
 const identity={pid:info.pid,creationTicks:info.creationTicks,executable:info.executable};
 await assert.rejects(forceStopWindows({...identity,creationTicks:(BigInt(identity.creationTicks)+1n).toString()}));
 assert.equal(parent.exitCode,null);assert.equal(unrelated.exitCode,null);
 const result=await forceStopWindows(identity);assert.equal(result.stopped,true);assert.ok(result.processes>=2);
 if(parent.exitCode===null)await once(parent,'exit');assert.equal(unrelated.exitCode,null);
});

test('force stop fences an affected render and allows the queue to be resolved',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-force-queue-')),project=path.join(root,'projects','game'),id=randomUUID();
 await fs.mkdir(path.join(project,'music'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
 const queue=new JobQueue({directory:path.join(root,'state'),projects:path.join(root,'projects'),autoStart:false});
 t.after(async()=>{queue.stop();await fs.rm(root,{recursive:true,force:true})});
 const job=queue.enqueue({type:'music',projectId:id,request:{style:'piano',lyrics:'[Instrumental]'}});
 queue.lease();let killed=false;queue.active={id:job.id,child:{kill:()=>{killed=true}}};
 queue.update(job.id,{status:'running',remote_id:'remote-1'});
 const fenced=queue.beginForceStop('music');assert.equal(fenced.jobId,job.id);assert.equal(queue.get(job.id).status,'interrupted');assert.equal(killed,true);assert.equal(queue.active.forced,true);
 assert.throws(()=>queue.suspendForModelLoad('music'),/Wait/);
 queue.active=null;queue.resume('music');assert.equal(queue.resolve(job.id,true).status,'cancelled');
});

test('engine manager force-stops only its own captured process tree', {skip:process.platform!=='win32',timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-force-engine-'));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const manager=new EngineManager({definitions:[{id:'sfx',name:'Fixture',port,endpoint:'/api/status',kind:'stable-audio',cwd:root,command:process.execPath,args:[fileURLToPath(new URL('./fixtures/force-stop-parent.js',import.meta.url))]}],logDir:path.join(root,'runtime'),modelRoot:path.join(root,'models'),modelDefinitions:[],logger:()=>{}});
 t.after(async()=>{const entry=manager.children.get('sfx');if(entry?.child?.exitCode===null)entry.child.kill();await fs.rm(root,{recursive:true,force:true}).catch(()=>{})});
 assert.equal((await manager.start('sfx')).status,'starting');
 const deadline=Date.now()+10000;while(!manager.status().sfx.canForceStop&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(manager.status().sfx.canForceStop,true);
 const result=await manager.forceStop('sfx');assert.equal(result.stopped,true);assert.ok(result.processes>=2);
 assert.equal(manager.status().sfx.managed,false);await assert.rejects(manager.forceStop('sfx'),/does not own/);
});

test('force-stopping a running adapter leaves its job interrupted after the adapter exits', {timeout:12000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-force-running-')),projects=path.join(root,'projects'),project=path.join(projects,'game'),id=randomUUID();
 await fs.mkdir(path.join(project,'music'),{recursive:true});await fs.writeFile(path.join(project,'.forge-project.json'),JSON.stringify({id}));
 const http=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/v1/health')return res.end(JSON.stringify({api_version:'1',model:{loaded:true}}));if(req.url==='/api/v1/jobs'&&req.method==='POST'){req.resume();return res.end(JSON.stringify({id:'running-job'}))}if(req.url==='/api/v1/jobs/running-job')return res.end(JSON.stringify({status:'running'}));res.statusCode=404;res.end('{}')});
 http.listen(0,'127.0.0.1');await once(http,'listening');const previous=process.env.FORGE_MUSIC_URL;process.env.FORGE_MUSIC_URL=`http://127.0.0.1:${http.address().port}`;
 const queue=new JobQueue({directory:path.join(root,'state'),projects,leaseMs:1500,intervalMs:50});
 t.after(async()=>{queue.stop();http.closeAllConnections();http.close();if(previous===undefined)delete process.env.FORGE_MUSIC_URL;else process.env.FORGE_MUSIC_URL=previous;await fs.rm(root,{recursive:true,force:true})});
 const job=queue.enqueue({type:'music',projectId:id,request:{style:'piano',lyrics:'[Instrumental]'}});let deadline=Date.now()+8000;
 while(queue.get(job.id).status!=='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(queue.get(job.id).status,'running');assert.equal(queue.beginForceStop('music').jobId,job.id);
 deadline=Date.now()+4000;while(queue.active&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(queue.active,null);assert.equal(queue.get(job.id).status,'interrupted');queue.resume('music');
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(queue.get(job.id).status,'interrupted');
});
