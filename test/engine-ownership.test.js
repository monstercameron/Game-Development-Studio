import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EngineOwnershipJournal,expectedEngineExecutables,verifyEngineOwnership,probeWindowsProcess} from '../runtime/engine-ownership.js';

const enabled=process.platform==='win32';
async function freePort(){const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port}
async function message(child,data,expected){const reply=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker response timed out.')),5000);function receive(value){if(value?.type!==expected)return;clearTimeout(timer);child.off('message',receive);resolve(value)}child.on('message',receive)});child.send(data);return reply}

test('DPAPI journal survives restart and adopts only its authenticated listener', {skip:!enabled,timeout:60000}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forge-ownership-'));
  let initialLock,resumedLock,worker;
  t.after(async()=>{if(worker?.exitCode===null)worker.kill();await resumedLock?.release();await initialLock?.release();await fs.rm(directory,{recursive:true,force:true})});
  const journal=new EngineOwnershipJournal({directory}),id='fixture-engine',port=await freePort();
  initialLock=await journal.acquireLock();
  const token=randomBytes(32).toString('hex'),nonce=randomBytes(32).toString('hex'),executable=process.execPath;
  const prepared=await journal.prepare({id,port,executable,nonce,token});
  assert.equal(prepared.state,'prepared');
  const raw=await fs.readFile(path.join(journal.directory,`${id}.json`),'utf8');
  assert.ok(!raw.includes(token)&&!raw.includes(nonce));
  await assert.rejects(journal.prepare({id,port,executable,nonce,token}),{code:'EEXIST'});
  const unchanged=await fs.readFile(path.join(journal.directory,`${id}.json`),'utf8');
  await assert.rejects(initialLock.mutate({operation:'replace',file:`${id}.json`,content:unchanged,expected:'not the original record'}),{code:'EEXIST'});
  await assert.rejects(initialLock.mutate({operation:'remove',file:`${id}.json`,expected:'not the original record'}),{code:'EEXIST'});
  assert.equal(await fs.readFile(path.join(journal.directory,`${id}.json`),'utf8'),unchanged);
  const second=new EngineOwnershipJournal({directory});
  assert.equal((await second.read(id)).nonce,nonce);
  worker=fork(new URL('./fixtures/ownership-worker.js',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  await message(worker,{type:'start',token,nonce,engine:id,port},'ready');
  const discovered=await verifyEngineOwnership(prepared,{id,port,executable});
  assert.equal(discovered.verified,true);assert.equal(discovered.pid,worker.pid);
  await initialLock.release();
  resumedLock=await second.acquireLock();
  const running=await second.bind(id,nonce,discovered);
  assert.equal(running.state,'running');
  assert.equal((await verifyEngineOwnership(await journal.read(id),{id,port,executable})).verified,true);
  assert.equal((await verifyEngineOwnership({...running,creationTicks:String(BigInt(discovered.creationTicks)+1n)},{id,port,executable})).verified,false);
  assert.equal((await probeWindowsProcess(discovered)).state,'alive');
  assert.equal((await probeWindowsProcess({...discovered,creationTicks:String(BigInt(discovered.creationTicks)+1n)})).state,'exited_or_reused');
  assert.equal((await verifyEngineOwnership({...running,port:port===65535?65534:port+1},{id,port,executable})).verified,false);
  assert.equal((await verifyEngineOwnership({...running,token:'f'.repeat(64)},{id,port,executable})).verified,false);
  await message(worker,{type:'mode',mode:'wrong-nonce'},'mode-ready');
  assert.equal((await verifyEngineOwnership(running,{id,port,executable})).verified,false);
  await message(worker,{type:'mode',mode:'wrong-pid'},'mode-ready');
  assert.equal((await verifyEngineOwnership(running,{id,port,executable})).verified,false);
  await assert.rejects(second.clear(id,'0'.repeat(64)),/does not match/);
  const exited=once(worker,'exit');worker.send({type:'stop'});await exited;
  assert.equal((await probeWindowsProcess(discovered)).state,'exited_or_reused');
  assert.equal((await verifyEngineOwnership(running,{id,port,executable})).verified,false);
  assert.equal(await second.clear(id,nonce),true);assert.equal(await journal.read(id),null);
});

test('tampered, malformed and invalid ownership records fail closed', {skip:!enabled,timeout:30000}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forge-ownership-invalid-'));
  let lock;t.after(async()=>{await lock?.release();await fs.rm(directory,{recursive:true,force:true})});
  const journal=new EngineOwnershipJournal({directory}),id='fixture',nonce=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
  lock=await journal.acquireLock();
  await journal.prepare({id,port:5173,executable:process.execPath,nonce,token});
  const file=path.join(journal.directory,`${id}.json`),wrapper=JSON.parse(await fs.readFile(file,'utf8'));
  const bytes=Buffer.from(wrapper.ciphertext,'base64');bytes[Math.floor(bytes.length/2)]^=1;
  await fs.writeFile(file,JSON.stringify({...wrapper,ciphertext:bytes.toString('base64')}));
  await assert.rejects(journal.read(id),/operation failed/);
  await fs.writeFile(file,'not json');await assert.rejects(journal.read(id),/malformed/);
  await assert.rejects(journal.read('../outside'),/Invalid engine ID/);
  assert.equal((await probeWindowsProcess({pid:0,creationTicks:'1',executable:process.execPath})).state,'indeterminate');
});

test('venv executable allowlist is derived from the launcher configuration', {skip:!enabled,timeout:10000}, async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'forge-venv-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  const scripts=path.join(folder,'env','Scripts'),base=path.join(folder,'base');
  await fs.mkdir(scripts,{recursive:true});await fs.mkdir(base);
  const launcher=path.join(scripts,'python.exe'),interpreter=path.join(base,'python.exe');
  await fs.writeFile(launcher,'launcher');await fs.writeFile(interpreter,'interpreter');
  const cfg=path.join(folder,'env','pyvenv.cfg');await fs.writeFile(cfg,`executable = ${interpreter}\n`);
  assert.deepEqual((await expectedEngineExecutables(launcher)).map(value=>value.toLowerCase()),[launcher,interpreter].map(value=>value.toLowerCase()));
  await fs.appendFile(cfg,`executable = ${interpreter}\n`);
  await assert.rejects(expectedEngineExecutables(launcher),/invalid/);
});

test('a real Windows venv listener can be adopted even when the launcher is not the listener', {skip:!enabled,timeout:30000}, async t=>{
  const launcher=path.resolve('.forge-runtime/trellis2-venv/Scripts/python.exe');
  try{await fs.access(launcher)}catch{t.skip('TRELLIS venv is unavailable');return}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forge-ownership-venv-'));
  let lock,worker,shutdown=false;
  t.after(async()=>{if(!shutdown){try{await fetch(`http://127.0.0.1:${port}/shutdown`,{headers:{'X-Forge-Engine-Token':token},signal:AbortSignal.timeout(1000)})}catch{}if(worker?.exitCode===null)worker.kill()}await lock?.release();await fs.rm(directory,{recursive:true,force:true})});
  const id='python-fixture',port=await freePort(),nonce=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
  const journal=new EngineOwnershipJournal({directory});
  lock=await journal.acquireLock();
  const prepared=await journal.prepare({id,port,executable:launcher,nonce,token});
  assert.equal(prepared.executables.length,2);
  worker=spawn(launcher,['-u',path.resolve('test/fixtures/ownership-python-worker.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const ready=once(worker.stdout,'data');worker.stdin.end(JSON.stringify({id,port,nonce,token})+'\n');await ready;
  const adopted=await verifyEngineOwnership(prepared,{id,port,executable:launcher});
  assert.equal(adopted.verified,true);
  assert.ok(prepared.executables.some(value=>value.toLowerCase()===adopted.executable.toLowerCase()));
  const running=await journal.bind(id,nonce,adopted);assert.equal(running.pid,adopted.pid);
  const exited=once(worker,'exit');await fetch(`http://127.0.0.1:${port}/shutdown`,{headers:{'X-Forge-Engine-Token':token}});await exited;shutdown=true;
  assert.equal((await probeWindowsProcess(adopted)).state,'exited_or_reused');
});

test('exclusive supervisor lock is released after its owner process is killed', {skip:!enabled,timeout:30000}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'forge-ownership-lock-'));
  let holder,lock;
  t.after(async()=>{if(holder?.exitCode===null)holder.kill();await lock?.release();await fs.rm(directory,{recursive:true,force:true})});
  holder=fork(new URL('./fixtures/ownership-lock-holder.js',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const initial={id:'prior',port:12344,executable:process.execPath,nonce:'c'.repeat(64),token:'d'.repeat(64)};
  await message(holder,{type:'start',directory,record:initial},'locked');
  const competing=new EngineOwnershipJournal({directory});
  await assert.rejects(competing.acquireLock(),/lock/);
  await assert.rejects(competing.prepare({id:'fixture',port:12345,executable:process.execPath,nonce:'a'.repeat(64),token:'b'.repeat(64)}),/lock/);
  const exited=once(holder,'exit');holder.kill();await exited;
  const deadline=Date.now()+8000;
  while(!lock&&Date.now()<deadline){try{lock=await competing.acquireLock()}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
  assert.ok(lock?.held,'the orphaned helper must release its lock after the supervisor exits');
  assert.equal((await competing.read('prior')).nonce,initial.nonce);
  const record=await competing.prepare({id:'fixture',port:12345,executable:process.execPath,nonce:'a'.repeat(64),token:'b'.repeat(64)});
  assert.equal(record.state,'prepared');
});
