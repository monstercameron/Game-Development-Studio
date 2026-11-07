import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {saveAsset} from '../runtime/job-io.js';

async function setup(t,handler){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-asset-commit-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const folder=path.join(root,'images');await fs.mkdir(folder);
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  return {root,folder,url:`http://127.0.0.1:${server.address().port}/asset`};
}

test('committed assets survive a retry without another download',async t=>{
  let requests=0;
  const {root,folder,url}=await setup(t,(_req,res)=>{requests++;res.end('complete image')});
  const id=randomUUID(),rel=await saveAsset(root,'images',id,'png',url);
  assert.equal(await fs.readFile(path.join(folder,`forge-${id}.png`),'utf8'),'complete image');
  assert.equal(await saveAsset(root,'images',id,'png',url),rel);
  assert.equal(requests,1);assert.deepEqual(await fs.readdir(folder),[`forge-${id}.png`]);
});

test('an output created during download is not overwritten',async t=>{
  const id=randomUUID();let folder,requests=0;
  const fixture=await setup(t,async(_req,res)=>{if(++requests===1)await fs.writeFile(path.join(folder,`forge-${id}.png`),'existing asset');res.end('newly downloaded asset')});
  folder=fixture.folder;
  await assert.rejects(saveAsset(fixture.root,'images',id,'png',fixture.url),/occupied during download/);
  assert.equal(await fs.readFile(path.join(folder,`forge-${id}.png`),'utf8'),'existing asset');
  await assert.rejects(saveAsset(fixture.root,'images',id,'png',fixture.url),/conflicting output file/);
  await fs.rename(path.join(folder,`forge-${id}.png`),path.join(folder,'saved-by-user.png'));
  // The same remote render may be downloaded again once the user has kept
  // their file at a different name.
  const final=await saveAsset(fixture.root,'images',id,'png',fixture.url);
  assert.equal(final,`images/forge-${id}.png`);
  assert.equal(await fs.readFile(path.join(folder,'saved-by-user.png'),'utf8'),'existing asset');
  assert.equal(await fs.readFile(path.join(folder,`forge-${id}.png`),'utf8'),'newly downloaded asset');
});

test('an existing empty output is preserved and never mistaken for a completed download',async t=>{
  let requests=0;const {root,folder,url}=await setup(t,(_req,res)=>{requests++;res.end('new asset')});
  const id=randomUUID(),target=path.join(folder,`forge-${id}.png`);await fs.writeFile(target,'');
  await assert.rejects(saveAsset(root,'images',id,'png',url),/empty file already occupies/);
  assert.equal((await fs.stat(target)).size,0);assert.equal(requests,0);
});

test('a killed download leaves no visible partial asset and can be retried', {timeout:10000}, async t=>{
  let requests=0,stream;
  const {root,folder,url}=await setup(t,(_req,res)=>{
    requests++;
    if(requests===1){stream=res;res.writeHead(200,{'Content-Type':'application/octet-stream'});res.write('partial bytes');return}
    res.end('completed bytes');
  });
  const id=randomUUID();
  const child=fork(new URL('./fixtures/save-asset-worker.js',import.meta.url),[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill();stream?.destroy()});
  child.send({root,id,url});
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    if((await fs.readdir(folder)).some(name=>name.endsWith('.part')))break;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok((await fs.readdir(folder)).some(name=>name.endsWith('.part')),'the first download must have started');
  const exit=once(child,'exit');child.kill();await exit;stream?.destroy();
  const target=path.join(folder,`forge-${id}.png`);
  await assert.rejects(fs.stat(target),{code:'ENOENT'});
  await saveAsset(root,'images',id,'png',url);
  assert.equal(await fs.readFile(target,'utf8'),'completed bytes');
  assert.equal(requests,2);
  assert.deepEqual((await fs.readdir(folder)).filter(name=>!name.startsWith('.')),[`forge-${id}.png`]);
});
