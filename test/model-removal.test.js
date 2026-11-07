import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ModelRemoval} from '../runtime/model-removal.js';
import {EngineManager} from '../runtime/engines.js';
import net from 'node:net';
import {once} from 'node:events';

const models=[{id:'tts',folder:'voice'}];
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-model-removal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'models'),stateDir=path.join(dir,'state');await fs.mkdir(path.join(root,'voice'),{recursive:true});await fs.writeFile(path.join(root,'voice','weights.bin'),'fixture');
  return {dir,root,stateDir};
}
async function waitFor(fn){for(let n=0;n<200;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('Timed out')}

test('removal stages managed files, blocks concurrent removal, and records completion',async t=>{
  const {root,stateDir}=await fixture(t);let release;const gate=new Promise(resolve=>release=resolve);
  const removal=new ModelRemoval({root,stateDir,models,remove:async(...args)=>{await gate;return fs.rm(...args)}});await removal.ready;
  const result=await removal.begin('tts');assert.equal(result.state,'deleting');assert.equal(removal.isActive('tts'),true);
  await assert.rejects(fs.stat(path.join(root,'voice')),{code:'ENOENT'});await assert.rejects(removal.begin('tts'),/already being removed/);
  release();await waitFor(()=>!removal.isActive('tts'));assert.equal(removal.status('tts').state,'complete');
  assert.equal(JSON.parse(await fs.readFile(path.join(stateDir,'tts.json'),'utf8')).state,'complete');
});

test('removal rejects active services, unmanaged ids, and links',async t=>{
  const {root,stateDir,dir}=await fixture(t);const external=path.join(dir,'outside');await fs.mkdir(external);await fs.writeFile(path.join(external,'keep'),'safe');
  const blocked=new ModelRemoval({root,stateDir,models,checkStopped:async()=>{throw Error('Service is running.')}});await blocked.ready;
  await assert.rejects(blocked.begin('tts'),/running/);await assert.rejects(blocked.begin('../outside'),/not available/);
  let linked=true;try{await fs.symlink(external,path.join(root,'voice','link'),'junction')}catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code))linked=false;else throw error}
  if(linked){const removal=new ModelRemoval({root,stateDir,models});await removal.ready;await assert.rejects(removal.begin('tts'),/link/)}
  assert.equal(await fs.readFile(path.join(external,'keep'),'utf8'),'safe');assert.equal(await fs.readFile(path.join(root,'voice','weights.bin'),'utf8'),'fixture');
});

test('failed deletion remains retryable and resumes after restart without removing a replacement',async t=>{
  const {root,stateDir}=await fixture(t);const removal=new ModelRemoval({root,stateDir,models,remove:async()=>{throw Error('locked')}});await removal.ready;
  const original=await removal.begin('tts');await waitFor(()=>removal.status('tts')?.state==='failed');assert.match(removal.status('tts').error,/locked/);
  await fs.mkdir(path.join(root,'voice'));await fs.writeFile(path.join(root,'voice','new.bin'),'replacement');
  const recovered=new ModelRemoval({root,stateDir,models});await recovered.ready;await waitFor(()=>recovered.status('tts')?.state==='complete');
  assert.equal(await fs.readFile(path.join(root,'voice','new.bin'),'utf8'),'replacement');
  await assert.rejects(fs.stat(path.join(root,`.forge-deleting-tts-${original.operation}`)),{code:'ENOENT'});
});

test('a crash before rename never deletes the original folder on recovery',async t=>{
  const {root,stateDir}=await fixture(t);await fs.mkdir(stateDir);await fs.writeFile(path.join(stateDir,'tts.json'),JSON.stringify({id:'tts',operation:randomUUID(),state:'prepared'}));
  const removal=new ModelRemoval({root,stateDir,models});await removal.ready;
  assert.equal(removal.status('tts').state,'cancelled');assert.equal(await fs.readFile(path.join(root,'voice','weights.bin'),'utf8'),'fixture');
});

test('a failed staging rename clears the busy state and keeps the original model',async t=>{
  const {root,stateDir}=await fixture(t);const removal=new ModelRemoval({root,stateDir,models,rename:async()=>{throw Error('locked')}});await removal.ready;
  await assert.rejects(removal.begin('tts'),/locked/);assert.equal(removal.isActive('tts'),false);assert.equal(removal.status('tts').state,'cancelled');
  assert.equal(await fs.readFile(path.join(root,'voice','weights.bin'),'utf8'),'fixture');
});

test('engine manager refuses removal for a live service and fences startup while deleting',async t=>{
  const {root,stateDir}=await fixture(t);const server=net.createServer(socket=>socket.destroy());server.listen(0,'127.0.0.1');await once(server,'listening');
  const definition={id:'tts',name:'Test voice',port:server.address().port,endpoint:'/api/status',kind:'tts',cwd:root,command:process.execPath,args:['-e','process.exit(0)']};
  const manager=new EngineManager({definitions:[definition],logDir:stateDir,modelRoot:root,modelDefinitions:models,env:{}});await manager.removals.ready;
  await assert.rejects(manager.removeModel('tts'),/still running/);assert.equal(await fs.readFile(path.join(root,'voice','weights.bin'),'utf8'),'fixture');
  await new Promise(resolve=>server.close(resolve));let release;const gate=new Promise(resolve=>release=resolve);manager.removals.remove=async(...args)=>{await gate;return fs.rm(...args)};
  await manager.removeModel('tts');assert.equal((await manager.start('tts')).status,'deleting');assert.equal(manager.status().tts.removal.state,'deleting');
  release();await waitFor(()=>!manager.removals.isActive('tts'));assert.equal(manager.status().tts.removal.state,'complete');
});

test('custom endpoints and in-flight starts prevent model removal',async t=>{
  const {root,stateDir}=await fixture(t);const definition={id:'tts',port:1,endpoint:'/api/status',kind:'tts',cwd:root,command:process.execPath,args:[]};
  const external=new EngineManager({definitions:[definition],logDir:stateDir,modelRoot:root,modelDefinitions:models,env:{FORGE_TTS_URL:'http://127.0.0.1:1'}});await external.removals.ready;
  await assert.rejects(external.removeModel('tts'),/custom model or service/);
  const starting=new EngineManager({definitions:[definition],logDir:stateDir,modelRoot:root,modelDefinitions:models,env:{}});await starting.removals.ready;starting.starting.set('tts',Promise.resolve());
  await assert.rejects(starting.removeModel('tts'),/running or starting/);assert.equal(await fs.readFile(path.join(root,'voice','weights.bin'),'utf8'),'fixture');
});

test('a reinstalled model can be removed in a later confirmed operation',async t=>{
  const {root,stateDir}=await fixture(t);const removal=new ModelRemoval({root,stateDir,models});await removal.ready;
  await removal.begin('tts');await waitFor(()=>!removal.isActive('tts'));assert.equal(removal.status('tts').state,'complete');
  await fs.mkdir(path.join(root,'voice'));await fs.writeFile(path.join(root,'voice','second.bin'),'reinstalled');
  await removal.begin('tts');await waitFor(()=>!removal.isActive('tts'));assert.equal(removal.status('tts').state,'complete');
});

test('an unreadable removal journal fails closed without stopping unrelated engines',async t=>{
  const {root,stateDir}=await fixture(t);await fs.mkdir(stateDir);await fs.writeFile(path.join(stateDir,'model-removals'),'not a directory');
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const messages=[],definition={id:'images',port,endpoint:'/api/status',kind:'qwen',cwd:root,command:process.execPath,args:['-e','setTimeout(()=>process.exit(0),100)'],noRestart:true};
  const manager=new EngineManager({definitions:[definition],logDir:stateDir,modelRoot:root,modelDefinitions:models,env:{},logger:message=>messages.push(message)});
  await assert.rejects(manager.removals.ready);assert.ok(messages.some(message=>message.includes('recovery unavailable')));
  // A broken removal journal affects its maintenance operation, not the service process.
  // Use a valid log directory for the unrelated engine's output.
  manager.logDir=path.dirname(stateDir);assert.equal((await manager.start('images')).status,'starting');
  await waitFor(()=>!manager.children.has('images'));
});
