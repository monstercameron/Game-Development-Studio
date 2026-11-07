import test from 'node:test';
import assert from 'node:assert/strict';
import {stopExternalModel} from '../runtime/external-model-stop.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const service={id:'video',port:8274};
function fixture({busy=false,listeners=['127.0.0.1:1234']}={}) {
  const calls=[];
  const options={ownPid:999,inspect:async()=>({status:'reachable',busy}),processInfo:async pid=>({pid,listeners,creationTicks:'639295382864139249',executable:'C:\\node.exe'}),stop:async identity=>{calls.push(identity);return {stopped:true,processes:1}}};
  return {calls,options};
}
test('idle close identifies the service listener before stopping its tree',async()=>{
  const {calls,options}=fixture();
  const result=await stopExternalModel(service,options);
  assert.equal(result.stopped,true);assert.equal(calls.length,1);assert.equal(calls[0].pid,1234);
});
test('idle close refuses active work while explicit force close can interrupt it',async()=>{
  const {calls,options}=fixture({busy:true});
  await assert.rejects(stopExternalModel(service,options),/busy/);assert.equal(calls.length,0);
  await stopExternalModel(service,{...options,force:true});assert.equal(calls.length,1);
});
test('unverified or ambiguous services never reach process termination',async()=>{
  const {calls,options}=fixture({listeners:['127.0.0.1:1234','0.0.0.0:5678']});
  await assert.rejects(stopExternalModel(service,{...options,force:true}),/uniquely/);
  await assert.rejects(stopExternalModel({...service,host:'example.com'},{...options,force:true}),/local/);
  assert.equal(calls.length,0);
});

test('Windows closes a real idle loopback service process', {skip:process.platform!=='win32',timeout:40000},async()=>{
  const script=`const http=require('http');const s=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ready:true,files:[],job:null}))});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
  const child=spawn(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  try{
    const [chunk]=await once(child.stdout,'data');const port=Number(chunk.toString().trim());assert.ok(port>0);
    const exited=once(child,'exit');
    const result=await stopExternalModel({id:'video',port,endpoint:'/api/status',kind:'h3'});
    assert.equal(result.stopped,true);await exited;
  }finally{if(child.exitCode===null&&!child.killed)child.kill()}
});
