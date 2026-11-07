import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EngineOwnershipJournal,verifyEngineOwnership,probeWindowsProcess} from '../runtime/engine-ownership.js';
import {engineDefinitions} from '../runtime/engines.js';
import {EngineManager} from '../runtime/engines.js';
import {randomBytes} from 'node:crypto';

async function waitMessage(child,type,timeout=30000){return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timed out waiting for ${type}`)),timeout);child.on('message',function receive(value){if(value?.type!==type)return;clearTimeout(timer);child.off('message',receive);resolve(value)});child.once('exit',code=>{clearTimeout(timer);reject(Error(`Supervisor exited early: ${code}`))})})}

async function verifyRecoveryAfterCrash(t,id){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-supervisor-recovery-'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  let first,second,workerPid,workerStopped=false;
  t.after(async()=>{
    if(second?.exitCode===null){second.send({type:'shutdown'});await Promise.race([once(second,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);if(second.exitCode===null)second.kill()}
    if(first?.exitCode===null)first.kill();
    if(first&&!workerStopped){
      // Never signal a PID merely because the test once started it: Windows
      // can reuse PIDs. Challenge and verify the listener first.
      try{
        const record=await new EngineOwnershipJournal({directory:dir}).read(id);
        const definition=engineDefinitions.find(item=>item.id===id);
        const verified=await verifyEngineOwnership(record,{id,port,executable:definition.command});
        if(verified.verified&&(!workerPid||verified.pid===workerPid)){
          await fetch(`http://127.0.0.1:${port}/api/forge/stop`,{method:'POST',headers:{'X-Forge-Engine-Token':record.token}});
          for(let i=0;i<15;i++){if((await probeWindowsProcess(verified)).state==='exited_or_reused'){workerStopped=true;break}await new Promise(resolve=>setTimeout(resolve,300))}
        }
      }catch{}
    }
    if(!first||workerStopped)await fs.rm(dir,{recursive:true,force:true});
  });
  const launch=mode=>fork(new URL('./fixtures/trellis-recovery-supervisor.js',import.meta.url),[],{env:{...process.env,FORGE_TEST_RECOVERY_CONFIG:JSON.stringify({directory:dir,port,mode,id})},stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  first=launch('start');const initial=await waitMessage(first,'ready');workerPid=initial.pid;
  const exited=once(first,'exit');first.kill();await exited;
  second=launch('recover');const restored=await waitMessage(second,'ready');
  assert.equal(restored.managed,true);assert.equal(restored.recovered,true);
  const resultPromise=waitMessage(second,'offloaded');second.send({type:'offload'});const result=await resultPromise;
  assert.equal(result.error,undefined);assert.equal(result.result.stopped,true);workerStopped=true;
}

for(const id of ['3d-trellis','tts','images','3d-hunyuan','segmentation','motion-hy','motion-bricks','game'])test(`${id} supervisor crash recovers and safely stops its worker`,{skip:process.platform!=='win32',timeout:90000},t=>verifyRecoveryAfterCrash(t,id));

test('an unverifiable prepared launch blocks a duplicate worker', {skip:process.platform!=='win32',timeout:35000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-unresolved-recovery-'));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const original=engineDefinitions.find(item=>item.id==='3d-trellis');
  const definition={...original,port,args:['-u',original.args[1],'--port',String(port)]};
  const journal=new EngineOwnershipJournal({directory:dir});const lock=await journal.acquireLock();
  await journal.prepare({id:'3d-trellis',port,executable:definition.command,nonce:randomBytes(32).toString('hex'),token:randomBytes(32).toString('hex')});
  await lock.release();
  const manager=new EngineManager({definitions:[definition],logDir:dir,logger:()=>{}});
  t.after(async()=>{manager.closed=true;await manager.recoveryReady;await manager.recoveryLock?.release();await fs.rm(dir,{recursive:true,force:true})});
  await manager.recoveryReady;
  assert.equal(manager.recoveryStates.get('3d-trellis'),'unresolved');
  assert.equal(manager.status()['3d-trellis'].ownershipRecovery,'unresolved');
  const result=await manager.start('3d-trellis');
  assert.equal(result.status,'recovery_unresolved');assert.equal(manager.children.size,0);
});

test('a failed spawn clears its prepared record without leaving the engine blocked', {skip:process.platform!=='win32',timeout:35000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-failed-spawn-'));
  const executable=path.join(dir,'not-an-executable.exe');await fs.writeFile(executable,'not an executable');
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const original=engineDefinitions.find(item=>item.id==='3d-trellis');
  const manager=new EngineManager({definitions:[{...original,port,command:executable,cwd:dir,args:[]}],logDir:dir,logger:()=>{}});
  t.after(async()=>{manager.closed=true;await manager.recoveryReady;await manager.recoveryLock?.release();await fs.rm(dir,{recursive:true,force:true})});
  const result=await manager.start('3d-trellis');
  assert.equal(result.status,'failed');assert.equal(manager.recoveryStates.get('3d-trellis'),'none');
  assert.equal(await manager.recovery.journal.read('3d-trellis'),null);
});
